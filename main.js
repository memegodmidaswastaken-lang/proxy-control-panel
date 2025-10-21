// main.js
let token = null;
let socket = null;

// LOGIN FUNCTION
async function login() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if(data.token){
      token = data.token;
      document.getElementById('loginDiv').style.display = 'none';
      document.getElementById('panelDiv').style.display = 'block';
      document.getElementById('userRole').textContent = `${username} (${data.role})`;
      initSocket();
      updateOnlineUsers();
    } else {
      alert('Login failed: ' + (data.error||'Unknown error'));
    }
  } catch(e){ alert('Login error: ' + e); }
}

// SOCKET.IO INITIALIZATION
function initSocket(){
  socket = io({ auth: { token, version: '1.0' } });
  socket.on('connect', ()=>console.log('Connected to server via Socket.IO'));
  socket.on('server:kill-switch', data=>{
    const status = document.getElementById('status');
    status.textContent = data.enabled ? 'Kill switch ACTIVE' : 'Kill switch OFF';
  });
  socket.on('server:online-update', data=>{
    const list = document.getElementById('onlineList');
    list.innerHTML = '';
    data.forEach(user=>{
      const li = document.createElement('li');
      li.textContent = `${user.username} (${user.role}) - ${user.version}`;
      list.appendChild(li);
    });
  });
}

// UPDATE ONLINE USERS MANUALLY
async function updateOnlineUsers(){
  try {
    const res = await fetch('/api/online', { headers: { 'Authorization': 'Bearer '+token } });
    const users = await res.json();
    const list = document.getElementById('onlineList');
    list.innerHTML = '';
    users.forEach(user=>{
      const li = document.createElement('li');
      li.textContent = `${user.username} (${user.role}) - ${user.version}`;
      list.appendChild(li);
    });
  } catch(e){ console.error(e); }
}

// BUTTON EVENTS
document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('killSwitchBtn').addEventListener('click', async ()=>{
  try{
    const res = await fetch('/api/kill-switch', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
      body: JSON.stringify({ enable: true })
    });
    const data = await res.json();
    alert(data.killSwitchEnabled ? 'Kill switch activated' : 'Kill switch deactivated');
  } catch(e){ console.error(e); alert('Error toggling kill switch'); }
});
