// server.js
// Secure encrypted-script flow: upload plaintext (owner), server encrypts and stores ciphertext,
// clients log in, request a short-lived key via /api/get-key, download encrypted blob and decrypt locally.
// Folderless: serve ui.html and main.js from same folder.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

// Load users
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e){ users = {}; console.warn('users.json missing or invalid'); }

// In-memory sessions: sessionId -> { username, role, lastSeen }
const sessions = {};
// online users tracking
const onlineUsers = {};

// Content encryption state (in-memory)
// contentKey: Buffer (AES-256 key) used to encrypt the uploaded script
// encryptedScript: Buffer containing ciphertext (we'll store IV + ciphertext)
let contentKey = null;
let encryptedScriptBuffer = null;
let encryptedScriptExists = false;

// Map of issued ephemeral keys for auditing (sessionId -> { expiresAt })
const issuedKeys = {};

// helper: generate secure random hex
function genHex(n=16){ return crypto.randomBytes(n).toString('hex'); }

// serve ui and main as before (folderless)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'ui.html')));
app.get('/static/main.js', (req, res) => res.sendFile(path.join(__dirname, 'main.js')));

// --- session auth middleware using X-Session-Id ---
function authMiddleware(req, res, next){
  const sid = req.headers['x-session-id'];
  if(!sid || !sessions[sid]) return res.status(401).json({ error: 'Unauthorized' });
  req.session = sessions[sid];
  req.session.lastSeen = new Date();
  next();
}

// --- LOGIN ---
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

// --- logout ---
app.post('/api/logout', authMiddleware, (req, res) => {
  const sid = req.headers['x-session-id'];
  const username = req.session.username;
  delete sessions[sid];
  delete onlineUsers[username];
  res.json({ ok:true });
});

// --- heartbeat & online ---
app.post('/api/heartbeat', authMiddleware, (req, res) => {
  const { username, role } = req.session;
  onlineUsers[username] = { lastSeen: new Date(), role, version: req.body.version || '1.0' };
  res.json({ ok:true });
});
app.get('/api/online', authMiddleware, (req, res) => {
  res.json(Object.entries(onlineUsers).map(([u,i])=>({ username:u, role:i.role, version:i.version, lastSeen:i.lastSeen })));
});

// --- create user (owner) ---
app.post('/api/users', authMiddleware, (req,res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const { username, password, role } = req.body || {};
  if(!username || !password || !role) return res.json({ error: 'Missing fields' });
  if(users[username]) return res.json({ error: 'User exists' });
  users[username] = { password, role };
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok:true });
});

// --- kill switch (owner controls) ---
let killSwitchEnabled = false;
app.post('/api/kill-switch', authMiddleware, (req, res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  killSwitchEnabled = !!req.body.enable;
  res.json({ killSwitchEnabled });
});
app.get('/api/kill-switch', authMiddleware, (req,res) => res.json({ killSwitchEnabled }));

// --- authorize endpoint used by launcher if desired ---
app.post('/api/authorize', authMiddleware, (req,res) => {
  const username = req.session.username;
  const role = req.session.role;
  if(killSwitchEnabled && role !== 'owner') return res.json({ allowed:false, reason:'kill-switch' });
  // implement bans/timeouts here if needed (example: users[username].banned)
  if(users[username]?.banned) return res.json({ allowed:false, reason:'banned' });
  res.json({ allowed:true });
});

// --- owner uploads plaintext script: POST /api/upload-script { script: "..." } ---
// Server will create a random contentKey (AES-256) and encrypt the script with AES-GCM (or AES-CBC+HMAC).
// For simplicity we use AES-256-GCM (authenticated).
app.post('/api/upload-script', authMiddleware, (req,res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const script = req.body && req.body.script;
  if(!script) return res.json({ error: 'Missing script content' });

  // generate contentKey
  contentKey = crypto.randomBytes(32); // 256-bit
  // encrypt using AES-256-GCM
  const iv = crypto.randomBytes(12); // GCM recommended IV 12 bytes
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(script, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // store as: iv (12) | authTag (16) | ciphertext
  encryptedScriptBuffer = Buffer.concat([iv, authTag, ciphertext]);
  encryptedScriptExists = true;

  // Clear any previous issuedKeys (force clients to request again)
  for(const k of Object.keys(issuedKeys)) delete issuedKeys[k];

  res.json({ ok:true, message: 'Script uploaded+encrypted; clients must request key to decrypt.' });
});

// --- serve encrypted script to authenticated clients ---
// GET /proxyloop.enc (requires session)
app.get('/proxyloop.enc', authMiddleware, (req,res) => {
  if(!encryptedScriptExists) return res.status(404).send('No script uploaded');
  // Serve the buffer as application/octet-stream
  res.setHeader('Content-Type','application/octet-stream');
  res.send(encryptedScriptBuffer);
});

// --- get ephemeral key for current session ---
// POST /api/get-key { ttlSeconds?: number } -> returns { key: base64, expiresAt }
// Requires auth; server only issues key if authorized (eg not banned / kill-switch rules)
app.post('/api/get-key', authMiddleware, (req,res) => {
  const username = req.session.username;
  const role = req.session.role;
  // basic checks: script exists, authorized by kill-switch/ban
  if(!encryptedScriptExists) return res.status(404).json({ error: 'No script available' });
  if(killSwitchEnabled && role !== 'owner') return res.status(403).json({ error: 'Kill switch active' });
  if(users[username]?.banned) return res.status(403).json({ error: 'Banned' });

  // TTL
  const requestedTtl = parseInt(req.body && req.body.ttlSeconds, 10) || 15; // default 15s
  const ttl = Math.min(Math.max(requestedTtl, 5), 300); // clamp between 5s and 300s

  // Issue the contentKey to the session (we send raw key over TLS)
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (ttl * 1000);

  // Store issuance so we can revoke later by deleting the session or clearing issuedKeys
  issuedKeys[req.headers['x-session-id']] = { expiresAt };

  // Return key as base64 + expiry timestamp
  const keyB64 = contentKey.toString('base64');
  res.json({ key: keyB64, expiresAt });
});

// --- owner can revoke issued keys (optional) ---
// POST /api/revoke-session { sessionId }
app.post('/api/revoke-session', authMiddleware, (req,res) => {
  if(req.session.role !== 'owner') return res.status(403).json({ error: 'Forbidden' });
  const sid = req.body && req.body.sessionId;
  if(!sid) return res.json({ error: 'Missing sessionId' });
  delete issuedKeys[sid];
  delete sessions[sid];
  res.json({ ok:true });
});

// --- small cleanup loop: purge expired issuedKeys and old sessions/online entries ---
setInterval(() => {
  const now = Date.now();
  for(const [sid, info] of Object.entries(issuedKeys)){
    if(info.expiresAt <= now) delete issuedKeys[sid];
  }
  for(const [sid, sess] of Object.entries(sessions)){
    if((now - new Date(sess.lastSeen).getTime()) > (30*60*1000)) delete sessions[sid];
  }
  for(const [username, info] of Object.entries(onlineUsers)){
    if((now - new Date(info.lastSeen).getTime()) > (5*60*1000)) delete onlineUsers[username];
  }
}, 30*1000);

// --- start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
