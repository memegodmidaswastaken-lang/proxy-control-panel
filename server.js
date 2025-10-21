// server.js
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

const USERS_FILE = './users.json';
const JWT_SECRET = 'supersecretkey123';
const PORT = process.env.PORT || 3000;

// Load users
let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

// Online users tracking
let onlineUsers = {};

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Serve static files from current directory
app.use('/static', express.static(__dirname));

// Serve ui.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ error: 'Missing username/password' });
  const user = users[username];
  if (!user || user.password !== password) return res.json({ error: 'Invalid credentials' });

  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, role: user.role });
});

// HEARTBEAT
app.post('/api/heartbeat', authMiddleware, (req, res) => {
  const { username, role } = req.user;
  onlineUsers[username] = { lastSeen: new Date(), role, version: '1.0' };
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

// CREATE USER (owner-only)
app.post('/api/users', authMiddleware, (req, res) => {
  const { username, password, role } = req.body;
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  if (!username || !password || !role) return res.json({ error: 'Missing fields' });
  users[username] = { password, role };
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok: true });
});

// Kill switch (owner-only)
let killSwitchEnabled = false;
app.post('/api/kill-switch', authMiddleware, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const { enable } = req.body;
  killSwitchEnabled = !!enable;
  res.json({ killSwitchEnabled });
});

// User config (role-based interval)
app.get('/api/user-config', authMiddleware, (req, res) => {
  const role = req.user.role;
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
