// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const socketio = require('socket.io');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

// Helmet with custom CSP to allow Socket.IO CDN and inline scripts
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "https://cdn.socket.io"],
        "script-src-attr": ["'unsafe-inline'"]
      }
    }
  })
);

app.use(cors());
app.use(express.json());

// Serve ui.html at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui.html'));
});
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_local';

// === HARD-CODED USERS ===
const users = {
  "memegodmidas": { password: "Godsatan1342", role: "owner", banned: false },
  "MEMEADMIN": { password: "Satangod1342", role: "owner", banned: false },
  "mememember": { password: "lololowewe23232", role: "member", banned: false },
  "mod1": { password: "modkiller14535", role: "moderator", banned: false }
};

// Track connected clients: socketId -> { username, role, version, lastSeen }
const online = new Map();

// Track banned until timestamps (ms) for temporary timeouts: username -> timestamp
const bannedUntil = {}; // e.g. { "member1": 1699999999999 }

// Helper
function isTemporarilyBanned(username){
  const until = bannedUntil[username];
  if(!until) return false;
  if(Date.now() > until){
    delete bannedUntil[username];
    return false;
  }
  return true;
}

// API auth middleware
function authMiddleware(req, res, next){
  const auth = req.headers.authorization;
  if(!auth) return res.status(401).json({ error: 'Missing token' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // check banned permanent
    if(users[decoded.username]?.banned) return res.status(403).json({ error: 'Banned' });
    // check timed ban
    if(isTemporarilyBanned(decoded.username)) return res.status(403).json({ error: 'Temporarily banned' });
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// LOGIN ROUTE (plaintext passwords from users object)
app.post('/api/login', async (req,res)=>{
  const { username, password } = req.body;
  const user = users[username];
  if(!user) return res.status(401).json({ error: 'Invalid credentials' });
  if(user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if(user.banned) return res.status(403).json({ error: 'Banned' });
  if(isTemporarilyBanned(username)) return res.status(403).json({ error: 'Temporarily banned' });
  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '6h' });
  res.json({ token, role: user.role });
});

// Create new user (Owner only)
app.post('/api/users', authMiddleware, async (req,res)=>{
  if(req.user.role !== 'owner') return res.status(403).json({ error: 'Need owner' });
  const { username, password, role } = req.body;
  if(users[username]) return res.status(400).json({ error: 'Exists' });
  users[username] = { password, role: role||'member', banned:false };
  res.json({ ok:true });
});

// Online users
app.get('/api/online', authMiddleware, (req,res)=>{
  const arr = [];
  for(const [socketId, info] of online.entries()){
    arr.push({ socketId, username: info.username, role: info.role, version: info.version, lastSeen: info.lastSeen });
  }
  res.json(arr);
});

// Kill switch (owner only)
let killSwitchEnabled = false;
app.post('/api/kill-switch', authMiddleware, (req,res)=>{
  if(req.user.role !== 'owner') return res.status(403).json({ error:'Need owner' });
  killSwitchEnabled = !!req.body.enable;
  io.emit('server:kill-switch', { enabled: killSwitchEnabled });
  res.json({ ok:true, killSwitchEnabled });
});

// SOCKET.IO
const server = http.createServer(app);
const io = socketio(server, { cors: { origin: '*' } });

// Helper: find socket id(s) by username
function findSocketsByUsername(username){
  const matches = [];
  for(const [sid, info] of online.entries()){
    if(info.username === username) matches.push(sid);
  }
  return matches;
}

io.use((socket,next)=>{
  const token = socket.handshake.auth?.token;
  if(!token) return next(new Error('Auth required'));
  try{
    const decoded = jwt.verify(token, JWT_SECRET);
    // check banned
    if(users[decoded.username]?.banned) return next(new Error('Banned'));
    if(isTemporarilyBanned(decoded.username)) return next(new Error('Temporarily banned'));
    socket.user = decoded;
    next();
  } catch (e) { next(new Error('Invalid token')); }
});

io.on('connection', socket=>{
  const { username, role } = socket.user;
  online.set(socket.id, { username, role, version: socket.handshake.auth.version||'unknown', lastSeen: new Date().toISOString() });
  io.emit('server:online-update', Array.from(online.entries()).map(([sid, info])=>({ socketId:sid, ...info })));

  // Admins will emit 'server:command' to the server socket; we process commands here
  socket.on('server:command', async payload=>{
    const sender = socket.user;
    if(!(sender.role === 'owner' || sender.role === 'moderator')) return socket.emit('error','No permission');

    const { targetSocketId, command, data } = payload;

    // Allow command by username target too (support client passing username)
    let targetInfo = online.get(targetSocketId);
    // if not found by socketId, maybe payload provided username in targetSocketId
    if(!targetInfo && typeof targetSocketId === 'string'){
      // try find by username
      for(const [sid, info] of online.entries()){
        if(info.username === targetSocketId) { targetInfo = info; break; }
      }
    }

    if(!targetInfo) return socket.emit('error','Target not online');

    // Prevent moderators from targeting owners or other moderators
    if(sender.role === 'moderator' && (targetInfo.role === 'owner' || targetInfo.role === 'moderator')){
      return socket.emit('error','Moderator cannot target this user');
    }

    // Kill switch prevention: if enabled only owner can act
    if(killSwitchEnabled && sender.role !== 'owner') return socket.emit('error','Kill switch active');

    // Identify username(s) for server-side actions
    const targetUsername = targetInfo.username;
    const targetSocketIds = findSocketsByUsername(targetUsername);

    // Handle built-in admin actions on server side
    if(command === 'kick'){
      // disconnect all sockets for that username
      for(const sid of targetSocketIds){
        const s = io.sockets.sockets.get(sid);
        if(s) s.disconnect(true);
        online.delete(sid);
      }
      io.emit('server:online-update', Array.from(online.entries()).map(([sid, info])=>({ socketId:sid, ...info })));
      socket.emit('server:command_sent', { ok:true, info: 'kicked' });
      return;
    }

    if(command === 'ban'){
      // Only owner can ban (extra check)
      if(sender.role !== 'owner') return socket.emit('error', 'Only owner can ban');
      // set permanent ban
      if(users[targetUsername]) users[targetUsername].banned = true;
      // disconnect
      for(const sid of targetSocketIds){
        const s = io.sockets.sockets.get(sid);
        if(s) s.disconnect(true);
        online.delete(sid);
      }
      io.emit('server:online-update', Array.from(online.entries()).map(([sid, info])=>({ socketId:sid, ...info })));
      socket.emit('server:command_sent', { ok:true, info: 'banned' });
      return;
    }

    if(command === 'timeout'){
      // data.seconds expected
      const seconds = (data && data.seconds) ? parseInt(data.seconds,10) : 30;
      if(isNaN(seconds) || seconds <= 0) return socket.emit('error','Invalid timeout seconds');
      // mods cannot timeout owners or mods (we already checked above)
      // set temporary ban
      bannedUntil[targetUsername] = Date.now() + (seconds * 1000);
      // disconnect
      for(const sid of targetSocketIds){
        const s = io.sockets.sockets.get(sid);
        if(s) s.disconnect(true);
        online.delete(sid);
      }
      io.emit('server:online-update', Array.from(online.entries()).map(([sid, info])=>({ socketId:sid, ...info })));
      socket.emit('server:command_sent', { ok:true, info: `timed out ${seconds}s` });
      return;
    }

    // For any other commands, forward to target socket(s)
    for(const sid of targetSocketIds){
      io.to(sid).emit('server:command', { from: sender.username, command, data });
    }
    socket.emit('server:command_sent', { ok:true });
  });

  socket.on('disconnect', ()=>{
    online.delete(socket.id);
    io.emit('server:online-update', Array.from(online.entries()).map(([sid, info])=>({ socketId:sid, ...info })));
  });
});

server.listen(PORT, ()=>console.log(`Server running on port ${PORT}`));
