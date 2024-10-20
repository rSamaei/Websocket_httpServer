import * as net from "net";

async function newConn(socket: net.Socket): Promise<void> {
    console.log('new connection', socket.remoteAddress, socket.remotePort);
    
    try {
        await serveClient(socket);
    } catch (exc) {
        console.error('exception:', exc);
    } finally {
        socket.destroy();
    }
}

const server = net.createServer({
    pauseOnConnect: true,   // required by 'TCPConn'
});
server.on('error', (err: Error) => { throw err; });
server.on('connection', newConn);
server.listen({host: '127.0.0.1', port: 1234}); 

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

type TCPListener = {
    socket: net.Server;
};

function soListen(socket: net.Server): TCPListener {
    return {
        socket: socket
    };
}

function soAccept(listener: TCPListener): Promise<TCPConn> {
    return new Promise((resolve, reject) => {
        listener.socket.once('connection', (socket: net.Socket) => {
            // Initialize a new connection
            const conn: TCPConn = {
                socket: socket,
                err: null,
                ended: false,
                reader: null,
            };
            resolve(conn);
        });

        listener.socket.on('error', (err) => {
            reject(err);
        });
    });
}

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
    
}

// a dynamic-sized buffer
type DynBuf = {
    data: Buffer,
    length: number,
    start: number,
};

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

async function serveClient(socket: net.Socket): Promise<void> {
    // Initialize the connection with the socket
    const conn: TCPConn = soInit(socket);
    // Create an empty dynamic buffer for accumulating data
    const buf: DynBuf = { data: Buffer.alloc(0), length: 0, start: 0};
    while (true) { // Infinite loop to handle messages from the client
        // Try to extract one complete message from the buffer
        const msg: null | Buffer = cutMessage(buf);
        if (!msg) { // If no complete message is found (msg is null)
            // Need more data to form a complete message
            const data: Buffer = await soRead(conn); // Read more data from the connection
            bufPush(buf, data); // Push the newly read data into the dynamic buffer
            // Check if EOF (End of File) has been reached
            if (data.length == 0) {
                // If data length is 0, it indicates the connection is closed, so return (exit the loop)
                // [Additional cleanup code can be placed here, but it's omitted]
                return;
            }
            // Since more data has been received, try to cut a message again
            continue; // Go back to the start of the loop
        }
        // If a complete message has been extracted, process it
        if (msg.equals(Buffer.from('quit\n'))) { // Check if the message is "quit\n"
            await soWrite(conn, Buffer.from('Bye\n')); // Send a "Bye" response to the client
            socket.destroy(); // Close the connection
            return; // Exit the loop and function
        } else {
            // For any other message, send an "Echo: <message>" response
            const reply = Buffer.concat([Buffer.from('Echo: '), msg]); // Prepare the reply
            await soWrite(conn, reply); // Send the reply to the client
        }
    } // Loop continues to handle more messages
}

function cutMessage(buf: DynBuf): null | Buffer {
    // messages are separated by '\n'
    const idx = buf.data.subarray(0, buf.length).indexOf('\n'); 
    // Creates a subarray of the buffer from the start to the current length (buf.length) and looks for the index of the first newline character '\n'.
    // If no newline character is found, `indexOf` returns -1.
    if (idx < 0) {
        return null; // not complete
        // If no newline character is found (`idx` is -1), the function returns `null`, indicating the message is incomplete.
    }
    // make a copy of the message and move the remaining data to the front
    const msg = Buffer.from(buf.data.subarray(0, idx + 1));
    // Creates a new Buffer `msg` that copies the data from the start of `buf.data` to the position just after the newline character (`idx + 1`).
    // The `Buffer.from` ensures a new copy of the message is created.
    // bufPop(buf, idx + 1);
    
    // Move the startIndex forward
    buf.start = idx + 1;
    buf.length -= (idx + 1 - buf.start);

    // Optional: Reduce buffer size if possible
    if (buf.start > buf.data.length / 2) {
        buf.data = buf.data.slice(buf.start, buf.start + buf.length);
        buf.start = 0;
    }

    // Calls `bufPop` to remove the copied message from the buffer and adjust the buffer's internal state.
    // This moves the remaining data to the front of the buffer and decreases the buffer's length.
    return msg;
    // Returns the extracted message as a `Buffer`.
}

function bufPop(buf: DynBuf, len: number): void {
    buf.data.copyWithin(0, len, buf.length);
    // Moves the part of the buffer starting from `len` to the beginning (`0`) of the buffer.
    // `copyWithin(0, len, buf.length)` shifts the remaining data to the front of the buffer.
    buf.length -= len;
    // Adjusts the buffer's length to reflect the removed data by subtracting `len` from `buf.length`.
    // This effectively "pops" the first `len` bytes off the buffer, reducing its logical size.
}