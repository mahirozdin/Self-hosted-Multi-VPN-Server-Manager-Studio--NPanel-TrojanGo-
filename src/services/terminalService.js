const { Client } = require('ssh2');
const { Server } = require('../models/Database');

module.exports = function(io) {
    io.on('connection', (socket) => {
        let conn = null;
        let stream = null;

        socket.on('start-session', async (serverId) => {
            try {
                const serverRecord = await Server.findByPk(serverId);
                if (!serverRecord) {
                    socket.emit('output', 'Server not found.\r\n');
                    return;
                }

                conn = new Client();
                conn.on('ready', () => {
                    socket.emit('output', `Connected to ${serverRecord.name} (${serverRecord.ip})...\r\n`);
                    conn.shell((err, s) => {
                        if (err) {
                            socket.emit('output', 'Error opening shell: ' + err.message + '\r\n');
                            return;
                        }
                        stream = s;
                        
                        stream.on('close', () => {
                            socket.emit('output', '\r\nSession closed.\r\n');
                            conn.end();
                        });

                        stream.on('data', (data) => {
                            socket.emit('output', data.toString());
                        });
                    });
                });

                conn.on('error', (err) => {
                    socket.emit('output', '\r\nSSH Error: ' + err.message + '\r\n');
                });
                
                conn.on('end', () => {
                    socket.emit('output', '\r\nSSH Connection ended.\r\n');
                });

                conn.connect({
                    host: serverRecord.ip,
                    port: serverRecord.port || 22,
                    username: serverRecord.username || 'root',
                    password: serverRecord.password,
                });

            } catch (error) {
                socket.emit('output', 'Error: ' + error.message + '\r\n');
            }
        });

        socket.on('input', (data) => {
            if (stream) {
                stream.write(data);
            }
        });
        
        socket.on('resize', (size) => {
             if (stream && size) {
                 stream.setWindow(size.rows, size.cols, size.height, size.width);
             }
        });

        socket.on('disconnect', () => {
            if (conn) conn.end();
        });
    });
};
