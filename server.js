const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

app.use(express.static(path.join(__dirname, '.')));

app.get('/health', (req, res) => {
    console.log('Health check accessed');
    res.status(200).send('Server is running');
});

const pingUrl = 'https://filesync-pro.onrender.com/health'; // Replace with your Render URL
setInterval(() => {
    axios.get(pingUrl)
        .then(() => console.log('Ping successful'))
        .catch((error) => console.error('Ping error:', error.message));
}, 300000);

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString('utf8'));
            console.log('Received message:', data);
            if (data.type === 'login') {
                clients.set(data.username, ws);
                ws.username = data.username;
                broadcastUserList();
            } else if (data.type === 'connectionRequest' && data.from && data.to) {
                const recipientWs = clients.get(data.to);
                if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                    recipientWs.send(JSON.stringify(data));
                    console.log(`Sent connectionRequest from ${data.from} to ${data.to}`);
                } else {
                    console.error(`Recipient ${data.to} not found or not connected`);
                }
            } else if (data.type === 'connectionResponse' && data.from && data.to && data.accepted !== undefined) {
                const senderWs = clients.get(data.to);
                if (senderWs && senderWs.readyState === WebSocket.OPEN) {
                    senderWs.send(JSON.stringify(data));
                    console.log(`Sent connectionResponse from ${data.from} to ${data.to}`);
                } else {
                    console.error(`Sender ${data.to} not found or not connected`);
                }
            } else if (data.type === 'file' && data.fileName && data.fileContent && data.sentTime && data.messageId && data.from && data.to) {
                const recipientWs = clients.get(data.to);
                if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                    recipientWs.send(JSON.stringify({
                        type: 'file',
                        fileName: data.fileName,
                        fileSize: data.fileSize,
                        fileContent: data.fileContent,
                        sentTime: data.sentTime,
                        messageId: data.messageId,
                        from: data.from,
                        to: data.to
                    }));
                    console.log(`Sent file from ${data.from} to ${data.to}`);
                }
                const senderWs = clients.get(data.from);
                if (senderWs && senderWs.readyState === WebSocket.OPEN) {
                    senderWs.send(JSON.stringify({
                        type: 'file',
                        fileName: data.fileName,
                        fileSize: data.fileSize,
                        fileContent: data.fileContent,
                        sentTime: data.sentTime,
                        messageId: data.messageId,
                        from: data.from,
                        to: data.to
                    }));
                    console.log(`Sent file confirmation to ${data.from}`);
                }
            } else if (data.type === 'downloadNotification' && data.from && data.to && data.messageId && data.downloadedTime) {
                const senderWs = clients.get(data.to);
                if (senderWs && senderWs.readyState === WebSocket.OPEN) {
                    senderWs.send(JSON.stringify(data));
                    console.log(`Sent downloadNotification from ${data.from} to ${data.to}`);
                } else {
                    console.error(`Sender ${data.to} not found or not connected for downloadNotification`);
                }
            } else {
                console.error('Invalid message format:', data);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        if (ws.username) {
            clients.delete(ws.username);
            broadcastUserList();
            console.log(`Client ${ws.username} disconnected`);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function broadcastUserList() {
    const users = Array.from(clients.keys());
    clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'userList',
                users: users
            }));
            console.log(`Sent userList to ${ws.username}`);
        }
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
