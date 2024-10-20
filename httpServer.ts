import * as net from "net";

// A promise-based API for TCP sockets.
type TCPConn = {
    // the JS socket object
    socket: net.Socket;
    // from the 'error' event
    err: null|Error;
    // EOF, from the 'end' event
    ended: boolean;
    // the callbacks of the promise of the current read
    reader: null|{
        resolve: (value: Buffer) => void,
        reject: (reason: Error) => void,
    };
};

// a dynamic-sized buffer
type DynBuf = {
    data: Buffer,
    length: number,
    // start: number,
};

// a parsed HTTP request header
type HTTPReq = {
    method: String,
    uri: Buffer,
    version: String,
    headers: Buffer[],
};

// an HTTP response
type HTTPRes = {
    code: number,
    headers: Buffer[],
    body: BodyReader,
};

// an interface for reading/writing data from/to the HTTP body
type BodyReader = {
    // the "Content-Length", -1 if unknown
    length: number,
    // read data, returns an empty buffer after EOF
    read: () => Promise<Buffer>,
};

function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket: socket, err: null, ended: false, reader: null,
    };
    socket.on('data', (data: Buffer) => {
        console.assert(conn.reader);
        // pause the 'data' event until the next read
        conn.socket.pause();
        // fulfill the promise of the current read
        conn.reader!.resolve(data);
        conn.reader = null;
    });
    socket.on('end', () => {
        // this also fulfills the current read
        conn.ended = true;
        if(conn.reader){
            conn.reader.resolve(Buffer.from(''));   // EOF
            conn.reader = null;
        }
    });
    socket.on('error', (err: Error) => {
        // errors are also delivered to the current read
        conn.err = err;
        if(conn.reader){
            conn.reader.reject(err);
            conn.reader = null;
        }
    });
    return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
    console.assert(!conn.reader);   // no concurrent calls
    return new Promise((resolve, reject) => {
        // if the connection is not readable, complete the promise now
        if(conn.err){
            reject(conn.err);
            return;
        }
        if(conn.ended){
            resolve(Buffer.from(''));   // EOF
            return;
        }

        // save the promise callbacks
        conn.reader = {resolve: resolve, reject: reject};
        // and resume the 'data' event to fulfill the promise later
        conn.socket.resume();
    });
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        // Write the data to the connection
        conn.socket.write(data, (err) => {
            if (err) {
                // If there is an error, reject the promise
                reject(err);
            } else {
                // Otherwise, resolve the promise successfully
                resolve();
            }
        });
    });
}


// append data to DynBuf
function bufPush(buf: DynBuf, data: Buffer): void {
    const newLen = buf.length + data.length;
    if(buf.length < newLen){
        // grow the capacity by a power of 2
        let cap = Math.max(buf.data.length, 32);
        while (cap < newLen){
            cap *= 2;
        }
        const grown = Buffer.alloc(cap);
        buf.data.copy(grown, 0, 0);
        buf.data = grown;
    }
    data.copy(buf.data, buf.length, 0);
    buf.length = newLen;
}

function bufPop(buf: DynBuf, len: number): void {
    buf.data.copyWithin(0, len, buf.length);
    // Moves the part of the buffer starting from `len` to the beginning (`0`) of the buffer.
    // `copyWithin(0, len, buf.length)` shifts the remaining data to the front of the buffer.
    buf.length -= len;
    // Adjusts the buffer's length to reflect the removed data by subtracting `len` from `buf.length`.
    // This effectively "pops" the first `len` bytes off the buffer, reducing its logical size.
}

async function serveClient(conn: TCPConn): Promise<void> {
    const buf: DynBuf = {data: Buffer.alloc(0), length: 0};
    while (true) {
        // try to get one request header from the buffer
        const msg: null|HTTPReq = cutMessage(buf);
        if(!msg){
            // need more data
            const data = await soRead(conn);
            bufPush(buf, data);
            // EOF?
            if(data.length === 0 && buf.length === 0){
                return;     // no more requests
            }
            if(data.length === 0){
                throw new HTTPError(400, 'Unexpected EOF');
            }
            // got some data, try it again
            continue;
        }

        // process the message and send the response
        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close the connection for HTTP/1.0
        if(msg.version === '1.0'){
            return;
        }
        // make sure that the request body is consumed completely
        while((await reqBody.read()).length > 0) { /* empty */ }
    }   // loop for IO
}

async function newConn(socket: net.Socket): Promise<void> { 
    const conn: TCPConn = soInit(socket);
    try {
        await serveClient(conn);
    } catch (exc) { 
        console.error('exception: ', exc);
        if(exc instanceof HTTPError){
            // intended to send an error response
            const resp: HTTPRes = {
                code: exc.code,
                headers: [],
                body: readerFromMemory(Buffer.from(exc.message + '\n')),
            };
            try {
                await writeHTTPResp(conn, resp);
            } catch (exc) { /* ignore */ }
        }
    } finally {
        socket.destroy();
    }
}

// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// parse and remove a header from the beginning of the buffer if possible
function cutMessage(buf: DynBuf): null|HTTPReq { 
    // the end of the header is marked by '\r\n\r\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if(idx < 0){
        if(buf.length >= kMaxHeaderLen){
            throw new HTTPError(413, 'header is too large');
        }
        return null;
    }
    // parse and remove the header
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
    bufPop(buf, idx + 4);
    return msg;
}

// parse an HTTP request header
function parseHTTPReq(data: Buffer): HTTPReq {
    // split the data into lines
    const lines: Buffer[] = splitLines(data);
    // the first line is 'METHOD URI VERSION'
    const[method, uri, version] = parseRequestLine(lines[0]);
    // followed by header fields in the format 'Name: value'
    const headers: Buffer[] = [];
    for(let i = 1; i < lines.length - 1; i++){
        const h = Buffer.from(lines[i]);
        if(!validateHeader(h)){
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }
    // the header ends by an empty line
    console.assert(lines[lines.length - 1].length === 0);
    return {
        method: method, uri: uri, version: version, headers: headers,
    };
}

// BodyReader from an HTTP request
function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
    let bodyLen = -1;
    const contentLen = fieldGet(req.headers, 'Content-Length');
    if(contentLen){
        bodyLen = parseDec(contentLen.toString('latin1'));
        if(isNaN(bodyLen)){
            throw new HTTPError(400, 'bad Content-Length');
        }
    }
    const bodyAllowed = !(req.method === 'GET' || req.method === 'HEAD');
    const chunked = fieldGet(req.headers, 'Transfer-Encoding') ?.equals(Buffer.from('chunked')) || false;
    if(!bodyAllowed && (bodyLen > 0 || chunked)) {
        throw new HTTPError(400, 'HTTP body not allowed');
    }
    if(!bodyAllowed){
        bodyLen = 0;
    }

    if(bodyLen >= 0){
        // Content-Length is present
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked){
        // chunked encoding
        throw new HTTPError(501, 'TODO');
    } else {
        // read the rest of the connection
        throw new HTTPError(501, 'TODO');
    }
}

function fieldGet(headers: Buffer[], key: string): null|Buffer{
    return null;
}

// BodyReader from a socket with a known length
function readerFromConnLength(conn: TCPConn, buf: DynBuf, remain: number): BodyReader {
    return {
        // Initialize the length property with the remaining bytes to read
        length: remain,
        // Define the read method, which returns a Promise that resolves to a Buffer
        read: async (): Promise<Buffer> => {
            if (remain === 0) {
                // If there's nothing left to read, return an empty Buffer
                return Buffer.from(''); // done
            }
            if (buf.length === 0) {
                // If the buffer is empty, read more data from the connection
                const data = await soRead(conn);
                // Add the newly read data to the buffer
                bufPush(buf, data);
                if (data.length === 0) {
                    // If no data was read (unexpected EOF), throw an error
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            // Determine how much data to consume, either the buffer length or the remaining bytes
            const consume = Math.min(buf.length, remain);
            // Decrease the remaining byte count by the amount consumed
            remain -= consume;
            // Extract the portion of data to be returned as a Buffer
            const data = Buffer.from(buf.data.subarray(0, consume));
            // Remove the consumed data from the buffer
            bufPop(buf, consume);
            // Return the consumed data as a Buffer
            return data;
        }
    };
}

// a sample request handler
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    // act on the request URI
    let resp: BodyReader;
    switch(req.uri.toString('latin1')){
    case '/echo':
        // http echo server
        resp = body;
        break;
    default:
        resp = readerFromMemory(Buffer.from('hello world.\n'));
        break;
    }

    return {
        code: 200,
        headers: [Buffer.from('Server: my_first_http_server')],
        body: resp,
    };
}

// BodyReader from in-memory data
function readerFromMemory(data: Buffer): BodyReader {
    let done = false;
    return {
        length: data.length,
        read: async(): Promise<Buffer> => {
            if(done){
                return Buffer.from(''); // no more data
            } else {
                done = true;
                return data;
            }
        }
    };
}

// send an HTTP response through the socket
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
    if(resp.body.length){
        throw new Error('TODO: chunked encoding');
    }
    // set the Content-Length field
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from('Content-Length: ${resp.body.length}'));
    // write the header
    await soWrite(conn, encodeHTTPResp(resp));
    // write the body
    while(true) {
        const data = await resp.body.read();
        if(data.length === 0){
            break;
        }
        await soWrite(conn, data);
    }
}

class HTTPError extends Error {
    statusCode: number; // Add the statusCode property
    constructor(statusCode, message) {
        super(message); // Call the parent class's constructor with the message
        this.name = 'HTTPError'; // Name the error for easier identification
        this.statusCode = statusCode; // Store the HTTP status code
    }
}
