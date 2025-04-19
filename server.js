const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const axios = require('axios'); // Add axios for pinging

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, '.')));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('Server is running');
});

// Pinger to prevent spin-down
const url = 'https://your-app-name.onrender.com/health'; // Replace with your Render URL
setInterval(() => {
    axios.get(url).then(() => {
        console.log('Pinged server to stay awake');
    }).catch((error) => {
        console.error('Ping error:', error.message);
    });
}, 300000); // Ping every 5 minutes

wss.on('connection', (ws) => {
    console.log('New client connected');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString('utf8'));
            if (data.fileName && data.fileContent) {
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
    ws.on('close', () => {
        console.log('Client disconnected');
    });
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
