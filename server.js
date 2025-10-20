// test_server.js
// Simple unauthenticated WebSocket + HTTP control server for local testing.
// WARNING: no auth — use only locally.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // id -> ws, meta

// When WS clients connect, assign an id and store meta
wss.on('connection', (ws, req) => {
  const id = uuidv4();
  clients.set(id, { ws, meta: { connectedAt: new Date().toISOString(), addr: req.socket.remoteAddress } });
  console.log(`Client connected: ${id} from ${req.socket.remoteAddress}`);

  // Send assigned id to client
  ws.send(JSON.stringify({ type: 'welcome', id }));

  ws.on('message', msg => {
    // expect JSON from client
    try {
      const json = JSON.parse(msg.toString());
      if(json.type === 'status') {
        clients.get(id).meta.lastStatus = json;
      }
      // echo to server console
      console.log(`From ${id}:`, json);
    } catch (e) {
      console.log(`Raw from ${id}:`, msg.toString());
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    console.log(`Client disconnected: ${id}`);
  });
});

// HTTP: list connected clients
app.get('/clients', (req, res) => {
  const arr = [];
  for(const [id, { meta }] of clients.entries()){
    arr.push({ id, ...meta });
  }
  res.json(arr);
});

// HTTP: send command to a client
// POST /send { targetId: "...", command: "start_loop"|"stop_loop"|"timeout", data: { ... } }
app.post('/send', (req, res) => {
  const { targetId, command, data } = req.body;
  if(!targetId || !command) return res.status(400).json({ error: 'targetId and command required' });
  const entry = clients.get(targetId);
  if(!entry) return res.status(404).json({ error: 'target not found' });
  const payload = { type: 'command', command, data: data || {} };
  try {
    entry.ws.send(JSON.stringify(payload));
    return res.json({ ok: true, sentTo: targetId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Simple web UI to view clients and send commands (very minimal)
app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family:system-ui">
    <h2>Test Control Server (no auth)</h2>
    <p>GET /clients to list, POST /send to send command.</p>
    <p>Example send payload: {"targetId":"<id>","command":"start_loop","data":{"interval":1,"proxy":"127.0.0.1:8080"}}</p>
    </body></html>
  `);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, ()=>console.log('Test server running on http://localhost:' + PORT));
