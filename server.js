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

// Serve static files if you add CSS/JS/images later
app.use(express.static(path.join(__dirname)));

// Environment config
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_local';

// === HARD-CODED USERS ===
const users = {
  "memegodmidas": { password: "username", role: "owner", banned: false },
  "Godsatan1342": { password: "password", role: "owner", banned: false },
  "member1": { password: "memberpass", role: "member", banned: false },
  "mod1": { password: "modpass", role: "moderator", banned: false }
};

// Helper function to verify login
async function verifyUser(username, password){
  const user = users[username];
  if(!user) return false;
  return user.password === password;
}

// Track connected clients
const online = new Map();

// API auth middleware
function authMiddleware(req, res, next){
  const auth = req.headers.authorization;
  if(!auth) return res.status(401).json({ error: 'Missing token' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if(users[decoded.username]?.banned) return res.status(403).json({ error: 'Banned' });
    req.user = decoded;
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// LOGIN ROUTE
app.post('/api/login', async (req,res)=>{
  const { username, password } = req.body;
  const valid = await verifyUser(username, password);
  if(!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ username, role: users[username].role }, JWT_SECRET, { expiresIn: '6h' });
  res.json({ token, role: users[username].role });
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

// Kill switch
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

io.use((socket,next)=>{
  const token = socket.handshake.auth?.token;
  if(!token) return next(new Error('Auth required'));
  try{
    const decoded = jwt.verify(token, JWT_SECRET);
    if(users[decoded.username]?.banned) return next(new Error('Banned'));
    socket.user = decoded;
    next();
  } catch { next(new Error('Invalid token')); }
});

io.on('connection', socket=>{
  const { username, role } = socket.user;
  online.set(socket.id, { username, role, version: socket.handshake.auth.version||'unknown', lastSeen: new Date().toISOString() });
  io.emit('server:online-update', Array.from(online.entries()).map(([sid, info])=>({ socketId:sid, ...info })));

  socket.on('server:command', payload=>{
    const sender = socket.user;
    if(!(sender.role==='owner'||sender.role==='moderator')) return socket.emit('error','No permission');
    const { targetSocketId, command, data } = payload;
    const targetInfo = online.get(targetSocketId);
    if(!targetInfo) return socket.emit('error','Target not online');
    if(sender.role==='moderator' && (targetInfo.role==='owner'||targetInfo.role==='moderator')) return socket.emit('error','Moderator cannot target this user');
    if(killSwitchEnabled && sender.role!=='owner') return socket.emit('error','Kill switch active');
    io.to(targetSocketId).emit('server:command',{ from: sender.username, command, data });
    socket.emit('server:command_sent',{ ok:true });
  });

  socket.on('disconnect', ()=>{
    online.delete(socket.id);
    io.emit('server:online-update', Array.from(online.entries()).map(([sid, info])=>({ socketId:sid, ...info })));
  });
});

server.listen(PORT, ()=>console.log(`Server running on port ${PORT}`));

