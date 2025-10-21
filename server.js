// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

// Load users from JSON
const USERS_FILE = './users.json';
let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

// Online users and sessions
let onlineUsers = {}; // { username: { lastSeen, role, version } }
let sessions = {};    // { sessionId: { username, role, lastSeen } }

// Auth middleware
function authMiddleware(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !sessions[sessionId]) return res.status(401).json({ error: 'Unauthorized' });
  req.session = sessions[sessionId];
  next();
}

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// Serve main.js
app.get('/static/main.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'main.js'));
});

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.password !== password) return res.json({ error: 'Invalid credentials' });

  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions[sessionId] = { username, role: user.role, lastSeen: new Date() };
  onlineUsers[username] = { lastSeen: new Date(), role: user.role, version: '1.0' };

  res.json({ sessionId, role: user.role });
});

// HEARTBEAT
app.post('/api/heartbeat', authMiddleware, (req, res) => {
  const { username, role } = req.session;
  onlineUsers[username] = { lastSeen: new Date(), role, version: '1.0' };
  req.session.lastSeen = new Date();
  res.json({ ok: true });
});

// GET ONLINE USERS
app.get('/api/online', authMiddleware, (req, res) => {
  res.json(Object.entries(onlineUsers).map(([username, info]) => ({
    username,
    role: info.role,
    version: info.version,
    lastSeen: info.lastSeen
  })));
});

// CREATE USER (owner only)
app.post('/api/users', authMiddleware, (req, res) => {
  if (req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const { username, password, role } = req.body;
  users[username] = { password, role };
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok: true });
});

// KILL SWITCH (owner only)
let killSwitchEnabled = false;
app.post('/api/kill-switch', authMiddleware, (req, res) => {
  if (req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const { enable } = req.body;
  killSwitchEnabled = !!enable;
  res.json({ killSwitchEnabled });
});

// USER CONFIG (interval)
app.get('/api/user-config', authMiddleware, (req, res) => {
  const role = req.session.role;
  let interval = 1;
  switch(role){
    case 'member': interval = 1; break;
    case 'pro': interval = 0.1; break;
    case 'moderator': interval = 0.1; break;
    case 'owner': interval = 0.05; break;
  }
  res.json({ interval });
});

// Cleanup inactive users every 2 minutes
setInterval(() => {
  const now = new Date();
  for (const [username, info] of Object.entries(onlineUsers)) {
    if ((now - info.lastSeen) > 2 * 60 * 1000) delete onlineUsers[username];
  }
}, 60 * 1000);

app.listen(3000, () => console.log('Server running on port 3000'));
