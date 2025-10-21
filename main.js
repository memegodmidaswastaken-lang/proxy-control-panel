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

      // Show new user form if owner
      if(data.role === 'owner') {
        document.getElementById('newUserDiv').style.display = 'block';
      }

      // Show download button for owner and moderator
      if(data.role === 'owner' || data.role === 'moderator') {
        const downloadBtn = document.getElementById('downloadBtn');
        downloadBtn.style.display = 'inline-block';
        downloadBtn.addEventListener('click', ()=>{
          const proxyScript = `
# proxyloop.ps1 - Constantly sets Windows proxy until closed
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
      }

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

// Kill switch button
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

// CREATE NEW USER BUTTON (OWNER ONLY)
document.getElementById('createUserBtn').addEventListener('click', async ()=>{
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


