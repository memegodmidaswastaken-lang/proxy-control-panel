// main.js
let token = null;
let socket = null;
let myRole = null;

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
      myRole = data.role;
      document.getElementById('loginDiv').style.display = 'none';
      document.getElementById('panelDiv').style.display = 'block';
      document.getElementById('userRole').textContent = `${username} (${data.role})`;

      // Show new user form if owner
      if(data.role === 'owner') {
        document.getElementById('newUserDiv').style.display = 'block';
      }

      // Initialize buttons based on role
      setupKillSwitchButton();
      setupDownloadButton();

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
    renderOnlineUsers(data);
  });
}

// RENDER ONLINE USERS WITH ACTION BUTTONS
function renderOnlineUsers(users){
  const list = document.getElementById('onlineList');
  list.innerHTML = '';
  users.forEach(user=>{
    const li = document.createElement('li');
    const textSpan = document.createElement('span');
    textSpan.textContent = `${user.username} (${user.role}) - ${user.version}`;
    li.appendChild(textSpan);

    // only show action buttons to owner/moderator
    if(myRole === 'owner' || myRole === 'moderator'){
      const actions = document.createElement('span');
      actions.style.marginLeft = '12px';

      // Kick
      const kickBtn = document.createElement('button');
      kickBtn.textContent = 'Kick';
      kickBtn.style.margin = '0 4px';
      kickBtn.onclick = ()=> sendAdminCommand(user.socketId, 'kick', {});
      actions.appendChild(kickBtn);

      // Ban (only owner server-side; moderators will be blocked)
      const banBtn = document.createElement('button');
      banBtn.textContent = 'Ban';
      banBtn.style.margin = '0 4px';
      banBtn.onclick = ()=> {
        if(!confirm(`Ban ${user.username}?`)) return;
        sendAdminCommand(user.username, 'ban', {});
      };
      actions.appendChild(banBtn);

      // Timeout
      const timeoutBtn = document.createElement('button');
      timeoutBtn.textContent = 'Timeout (30s)';
      timeoutBtn.style.margin = '0 4px';
      timeoutBtn.onclick = ()=> {
        const s = prompt('Timeout seconds (default 30):', '30');
        if(s === null) return;
        const seconds = parseInt(s,10);
        if(isNaN(seconds) || seconds <= 0) { alert('Invalid seconds'); return; }
        sendAdminCommand(user.username, 'timeout', { seconds });
      };
      actions.appendChild(timeoutBtn);

      li.appendChild(actions);
    }

    list.appendChild(li);
  });
}

// send admin command to server
function sendAdminCommand(targetSocketIdOrUsername, command, data){
  socket.emit('server:command', { targetSocketId: targetSocketIdOrUsername, command, data });
  console.log('Sent admin command', command, targetSocketIdOrUsername, data);
}

// UPDATE ONLINE USERS MANUALLY
async function updateOnlineUsers(){
  try {
    const res = await fetch('/api/online', { headers: { 'Authorization': 'Bearer '+token } });
    const users = await res.json();
    renderOnlineUsers(users);
    setTimeout(updateOnlineUsers, 3000);
  } catch(e){ console.error(e); }
}

// Setup Kill Switch button (OWNER ONLY)
function setupKillSwitchButton(){
  const killBtn = document.getElementById('killSwitchBtn');
  if(myRole === 'owner'){
    killBtn.style.display = 'inline-block';
    killBtn.addEventListener('click', async ()=>{
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
  } else {
    killBtn.style.display = 'none';
  }
}

// Setup Download Proxy Script button (OWNER ONLY)
function setupDownloadButton(){
  const downloadBtn = document.getElementById('downloadBtn');
  if(myRole === 'owner'){
    downloadBtn.style.display = 'inline-block';
    downloadBtn.addEventListener('click', ()=>{
      const proxyScript = `# proxyloop.ps1 - Constantly sets Windows proxy until closed
$proxyServer = "127.0.0.1:8080"
$interval = 5
Write-Host "Starting proxy replacement loop..."
Write-Host "Setting proxy to $proxyServer every $interval seconds."
Write-Host "Press Ctrl + C to stop."
while ($true) {
    try {
        Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyEnable -Value 1
        Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyServer -Value $proxyServer
        Write-Host "Proxy set to $proxyServer at $(Get-Date -Format 'HH:mm:ss')"
    }
    catch {
        Write-Host "Error setting proxy: $_"
    }
    Start-Sleep -Seconds $interval
}
`;
      const blob = new Blob([proxyScript], { type: 'text/plain' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'proxyloop.ps1';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  } else {
    downloadBtn.style.display = 'none';
  }
}

// CREATE NEW USER BUTTON (OWNER ONLY)
const createUserBtn = document.getElementById('createUserBtn');
if(createUserBtn){
  createUserBtn.addEventListener('click', async ()=>{
    const newUsername = document.getElementById('newUsername').value;
    const newPassword = document.getElementById('newPassword').value;
    const newRole = document.getElementById('newRole').value;
    const statusDiv = document.getElementById('newUserStatus');

    if(!newUsername || !newPassword) {
      statusDiv.textContent = 'Username and password required.';
      return;
    }

    try {
      const res = await fetch('/api/users', {
        method:'POST',
        headers:{ 
          'Content-Type':'application/json', 
          'Authorization':'Bearer '+token 
        },
        body: JSON.stringify({ username:newUsername, password:newPassword, role:newRole })
      });
      const data = await res.json();
      if(data.ok){
        statusDiv.textContent = `User ${newUsername} (${newRole}) created successfully!`;
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
      } else {
        statusDiv.textContent = 'Error: ' + (data.error||'Unknown error');
      }
    } catch(e){ statusDiv.textContent = 'Error creating user'; console.error(e); }
  });
}

// LOGIN BUTTON
document.getElementById('loginBtn').addEventListener('click', login);
