const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('.'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  connections: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
});
const User = mongoose.model('User', userSchema);

// Track online users
const onlineUsers = new Set();

// WebSocket Handling
wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    if (data.type === 'auth') {
      const user = await User.findOne({ username: data.username });
      if (user) {
        ws.user = user;
        onlineUsers.add(user.username);
        broadcastUserList();
      }
    }
    if (data.type === 'requestConnection' && ws.user) {
      const targetUser = await User.findOne({ username: data.target });
      if (targetUser) {
        wss.clients.forEach(client => {
          if (client.user && client.user.username === data.target) {
            client.send(JSON.stringify({
              type: 'connectionRequest',
              from: ws.user.username,
            }));
          }
        });
      }
    }
    if (data.type === 'connectionResponse' && ws.user) {
      const targetUser = await User.findOne({ username: data.target });
      if (targetUser && data.accept) {
        await User.updateOne({ _id: ws.user._id }, { $addToSet: { connections: targetUser._id } });
        await User.updateOne({ _id: targetUser._id }, { $addToSet: { connections: ws.user._id } });
      }
      wss.clients.forEach(client => {
        if (client.user && client.user.username === data.target) {
          client.send(JSON.stringify({
            type: 'connectionResponse',
            from: ws.user.username,
            accept: data.accept,
          }));
        }
      });
      broadcastUserList();
    }
    if (data.type === 'fileTransfer' && ws.user) {
      const targetUser = await User.findOne({ username: data.target });
      if (targetUser) {
        wss.clients.forEach(client => {
          if (client.user && client.user.username === data.target) {
            client.send(JSON.stringify({
              type: 'fileTransfer',
              from: ws.user.username,
              fileName: data.fileName,
              fileType: data.fileType,
              fileSize: data.fileSize,
              fileId: data.fileId,
            }));
          }
        });
      }
    }
    if (data.type === 'fileDownloaded' && ws.user) {
      wss.clients.forEach(client => {
        if (client.user && client.user.username === data.target) {
          client.send(JSON.stringify({
            type: 'fileDownloaded',
            fileId: data.fileId,
            downloadedTime: new Date().toISOString(),
          }));
        }
      });
    }
  });

  ws.on('close', () => {
    if (ws.user) {
      onlineUsers.delete(ws.user.username);
      broadcastUserList();
    }
  });
});

// Broadcast user list with online status
async function broadcastUserList() {
  const users = await User.find({}, 'username connections');
  const userList = users.map(user => ({
    username: user.username,
    connections: user.connections,
    online: onlineUsers.has(user.username),
  }));
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'userList', users: userList }));
    }
  });
}

// Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Routes
app.post('/signup', [
  body('email').isEmail(),
  body('username').notEmpty(),
  body('password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { email, username, password } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Email or username already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, username, password: hashedPassword });
    await user.save();
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Signup error' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Login error' });
  }
});

app.get('/users', authenticateToken, async (req, res) => {
  try {
    const users = await User.find({}, 'username connections');
    const userList = users.map(user => ({
      username: user.username,
      connections: user.connections,
      online: onlineUsers.has(user.username),
    }));
    res.json(userList);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check for pinger
app.get('/health', (req, res) => res.sendStatus(200));

// Pinger to prevent spin-down
const pingUrl = 'https://your-app-name.onrender.com/health';
setInterval(async () => {
  try {
    await axios.get(pingUrl);
    console.log('Ping successful');
  } catch (error) {
    console.error('Ping failed:', error.message);
  }
}, 5 * 60 * 1000);

// Start server
const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
