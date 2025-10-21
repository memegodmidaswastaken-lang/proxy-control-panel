// server.js
// Encrypted-script server: owner uploads plaintext; server encrypts and stores ciphertext.
// Clients authenticate, request short-lived decryption key, download ciphertext and decrypt locally.
// Folderless: serve ui.html and main.js from same directory.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// load users
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e){ users = {}; console.warn('users.json missing or invalid'); }

// in-memory session store: sessionId -> { username, role, lastSeen }
const sessions = {};
// online tracking
const onlineUsers = {};
// content encryption state (in memory)
let contentKey = null;                 // Buffer (32 bytes) AES-256
let encryptedScriptBuffer = null;      // Buffer (iv + authTag + ciphertext)
let encryptedScriptExists = false;
const issuedKeys = {};                 // sessionId -> { expiresAt }

// helpers
function genHex(n=16){ return crypto.randomBytes(n).toString('hex'); }

// Serve UI (folderless)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'ui.html')));
app.get('/static/main.js', (req, res) => res.sendFile(path.join(__dirname, 'main.js')));

// auth middleware (X-Session-Id)
function authMiddleware(req, res, next){
  const sid = req.headers['x-session-id'];
  if(!sid || !sessions[sid]) return res.status(401).json({ error: 'Unauthorized' });
  req.session = sessions[sid];
  req.session.lastSeen = new Date();
  next();
}

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if(!username || !password) return res.json({ error: 'Missing username / password' });
  const user = users[username];
  if(!user || user.password !== password) return res.json({ error: 'Invalid credentials' });

  const sessionId = genHex(16);
  sessions[sessionId] = { username, role: user.role, lastSeen: new Date() };
  onlineUsers[username] = { lastSeen: new Date(), role: user.role, version: '1.0' };
  res.json({ sessionId, role: user.role });
});

// LOGOUT
app.post('/api/logout', authMiddleware, (req, res) => {
  const sid = req.headers['x-session-id'];
  const username = req.session.username;
  delete sessions[sid];
  delete onlineUsers[username];
  delete issuedKeys[sid];
  res.json({ ok:true });
});

// HEARTBEAT & ONLINE
app.post('/api/heartbeat', authMiddleware, (req, res) => {
  const { username, role } = req.session;
  onlineUsers[username] = { lastSeen: new Date(), role, version: req.body.version || '1.0' };
  res.json({ ok:true });
});
app.get('/api/online', authMiddleware, (req, res) => {
  res.json(Object.entries(onlineUsers).map(([u,i])=>({ username:u, role:i.role, version:i.version, lastSeen:i.lastSeen })));
});

// CREATE USER (owner only)
app.post('/api/users', authMiddleware, (req,res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const { username, password, role } = req.body || {};
  if(!username || !password || !role) return res.json({ error: 'Missing fields' });
  if(users[username]) return res.json({ error: 'User exists' });
  users[username] = { password, role };
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok:true });
});

// KILL SWITCH (owner only)
let killSwitchEnabled = false;
app.post('/api/kill-switch', authMiddleware, (req, res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  killSwitchEnabled = !!req.body.enable;
  // clear previously issued keys so clients must re-request
  for(const k of Object.keys(issuedKeys)) delete issuedKeys[k];
  res.json({ killSwitchEnabled });
});
app.get('/api/kill-switch', authMiddleware, (req,res) => res.json({ killSwitchEnabled }));

// AUTHORIZE endpoint
app.post('/api/authorize', authMiddleware, (req,res) => {
  const username = req.session.username;
  const role = req.session.role;
  if(killSwitchEnabled && role !== 'owner') return res.json({ allowed:false, reason:'kill-switch' });
  if(users[username]?.banned) return res.json({ allowed:false, reason:'banned' });
  res.json({ allowed:true });
});

// OWNER uploads plaintext script - server encrypts it with AES-256-GCM
app.post('/api/upload-script', authMiddleware, (req,res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const script = req.body && req.body.script;
  if(!script) return res.json({ error: 'Missing script content' });

  // generate contentKey
  contentKey = crypto.randomBytes(32);
  // AES-GCM encrypt: iv(12) | authTag(16) | ciphertext
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(script, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  encryptedScriptBuffer = Buffer.concat([iv, authTag, ciphertext]);
  encryptedScriptExists = true;

  // revoke previously issued keys (force re-issue)
  for(const sid of Object.keys(issuedKeys)) delete issuedKeys[sid];

  res.json({ ok:true, message:'Script uploaded and encrypted in memory. Clients must request key.' });
});

// Serve ciphertext (authenticated)
app.get('/proxyloop.enc', authMiddleware, (req,res) => {
  if(!encryptedScriptExists) return res.status(404).send('No script uploaded');
  res.setHeader('Content-Type','application/octet-stream');
  res.send(encryptedScriptBuffer);
});

// Issue ephemeral key to a session (requires authorization)
app.post('/api/get-key', authMiddleware, (req,res) => {
  if(!encryptedScriptExists) return res.status(404).json({ error: 'No script available' });

  const username = req.session.username;
  const role = req.session.role;
  if(killSwitchEnabled && role !== 'owner') return res.status(403).json({ error: 'Kill switch active' });
  if(users[username]?.banned) return res.status(403).json({ error: 'Banned' });

  const requestedTtl = parseInt(req.body && req.body.ttlSeconds, 10) || 15;
  const ttl = Math.min(Math.max(requestedTtl, 5), 300);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (ttl * 1000);

  issuedKeys[req.headers['x-session-id']] = { expiresAt };
  const keyB64 = contentKey.toString('base64');
  res.json({ key: keyB64, expiresAt });
});

// Owner can revoke session or issued key
app.post('/api/revoke-session', authMiddleware, (req,res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const sid = req.body && req.body.sessionId;
  if(!sid) return res.json({ error: 'Missing sessionId' });
  delete issuedKeys[sid];
  delete sessions[sid];
  res.json({ ok:true });
});

// Cleanup expired issuedKeys, sessions, online users
setInterval(() => {
  const now = Date.now();
  for(const [sid, info] of Object.entries(issuedKeys)) if(info.expiresAt <= now) delete issuedKeys[sid];
  for(const [sid, sess] of Object.entries(sessions)) if((now - new Date(sess.lastSeen).getTime()) > (30*60*1000)) delete sessions[sid];
  for(const [u, info] of Object.entries(onlineUsers)) if((now - new Date(info.lastSeen).getTime()) > (5*60*1000)) delete onlineUsers[u];
}, 30*1000);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server running on port ${PORT}`));
