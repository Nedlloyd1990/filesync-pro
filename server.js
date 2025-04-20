const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

app.use(express.json());
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

// MongoDB Setup
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    connections: [{ type: String }] // Store connected usernames
});

const User = mongoose.model('User', userSchema);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret'; // Use env variable in production

// Signup Endpoint
app.post('/api/signup', [
    body('email').isEmail().normalizeEmail(),
    body('username').isAlphanumeric().isLength({ min: 3, max: 20 }),
    body('password').isLength({ min: 6 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ message: 'Invalid input', errors: errors.array() });
    }

    const { email, username, password } = req.body;

    try {
        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(400).json({ message: 'Email or username already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ email, username, password: hashedPassword, connections: [] });
        await user.save();

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1d' });
        res.status(201).json({ token });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid username or password' });
        }

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1d' });
        res.json({ token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// File Validation
const allowedFileTypes = ['image/jpeg', 'image/png', 'application/pdf', 'text/plain'];

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString('utf8'));
            console.log('Received message:', data);

            if (data.type === 'login') {
                try {
                    const decoded = jwt.verify(data.token, JWT_SECRET);
                    if (decoded.username === data.username) {
                        clients.set(data.username, ws);
                        ws.username = data.username;
                        const user = await User.findOne({ username: data.username });
                        ws.connections = user.connections || [];
                        broadcastUserList();
                    } else {
                        ws.send(JSON.stringify({ type: 'authError', message: 'Invalid token' }));
                    }
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'authError', message: 'Invalid token' }));
                }
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
                if (data.accepted) {
                    const fromUser = await User.findOne({ username: data.from });
                    const toUser = await User.findOne({ username: data.to });
                    if (fromUser && toUser) {
                        fromUser.connections.push(data.to);
                        toUser.connections.push(data.from);
                        await fromUser.save();
                        await toUser.save();
                        if (senderWs) {
                            senderWs.connections = toUser.connections;
                        }
                        const fromWs = clients.get(data.from);
                        if (fromWs) {
                            fromWs.connections = fromUser.connections;
                        }
                    }
                }
                if (senderWs && senderWs.readyState === WebSocket.OPEN) {
                    senderWs.send(JSON.stringify(data));
                    console.log(`Sent connectionResponse from ${data.from} to ${data.to}`);
                } else {
                    console.error(`Sender ${data.to} not found or not connected`);
                }
            } else if (data.type === 'file' && data.fileName && data.fileContent && data.sentTime && data.messageId && data.from && data.to) {
                // Basic file validation
                const fileType = data.fileContent.split(';')[0].split(':')[1] || '';
                if (!allowedFileTypes.includes(fileType)) {
                    console.error(`Invalid file type from ${data.from}: ${fileType}`);
                    return;
                }
                if (data.fileSize > 5 * 1024 * 1024) {
                    console.error(`File too large from ${data.from}: ${data.fileSize}`);
                    return;
                }

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
    clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            const users = Array.from(clients.keys()).filter(u => u !== ws.username && !ws.connections.includes(u));
            ws.send(JSON.stringify({
                type: 'userList',
                users
            }));
            console.log(`Sent userList to ${ws.username}`);
        }
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
