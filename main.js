document.addEventListener('DOMContentLoaded', () => {
    let myRole = '';
    let sessionId = '';

    const loginBtn = document.getElementById('loginBtn');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const loginDiv = document.getElementById('loginDiv');
    const panelDiv = document.getElementById('panelDiv');
    const userRoleSpan = document.getElementById('userRole');
    const onlineList = document.getElementById('onlineList');

    const killSwitchBtn = document.getElementById('killSwitchBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const newUserDiv = document.getElementById('newUserDiv');
    const newUsername = document.getElementById('newUsername');
    const newPassword = document.getElementById('newPassword');
    const newRole = document.getElementById('newRole');
    const createUserBtn = document.getElementById('createUserBtn');
    const newUserStatus = document.getElementById('newUserStatus');
    const statusSpan = document.getElementById('status');

    // Login
    loginBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value.trim();
        if (!username || !password) return alert('Enter username & password');

        try {
            const resp = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await resp.json();
            if (!data.sessionId) return alert(data.error || 'Login failed');

            sessionId = data.sessionId;
            myRole = data.role;

            loginDiv.style.display = 'none';
            panelDiv.style.display = 'block';
            userRoleSpan.innerText = myRole;

            setupOwnerButtons();
            loadOnlineUsers();
        } catch (e) {
            alert('Login error: ' + e);
        }
    });

    // Load online users every 2s
    async function loadOnlineUsers() {
        try {
            const resp = await fetch('/api/online', { headers: { 'X-Session-Id': sessionId } });
            const data = await resp.json();
            onlineList.innerHTML = '';
            data.forEach(u => {
                const li = document.createElement('li');
                li.innerText = `${u.username} (${u.role})`;
                onlineList.appendChild(li);
            });
        } catch (e) {
            console.log(e);
        } finally {
            setTimeout(loadOnlineUsers, 2000);
        }
    }

    // Owner buttons and actions
    function setupOwnerButtons() {
        if (myRole === 'owner') {
            killSwitchBtn.style.display = 'inline-block';
            downloadBtn.style.display = 'inline-block';
            newUserDiv.style.display = 'block';

            // Kill switch toggle
            killSwitchBtn.addEventListener('click', async () => {
                const enable = confirm('Activate kill switch? Only owner will be able to use system');
                try {
                    const resp = await fetch('/api/kill-switch', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Session-Id': sessionId
                        },
                        body: JSON.stringify({ enable })
                    });
                    const data = await resp.json();
                    statusSpan.innerText = `Kill switch: ${data.killSwitchEnabled ? 'ON' : 'OFF'}`;
                } catch (e) { alert('Error toggling kill switch'); }
            });

            // Download proxy script
            downloadBtn.addEventListener('click', () => {
                const blob = new Blob([`# Proxy script content\n# Put your PowerShell code here`], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'proxyloop.ps1';
                a.click();
                URL.revokeObjectURL(url);
            });

            // Create new user
            createUserBtn.addEventListener('click', async () => {
                const uname = newUsername.value.trim();
                const pass = newPassword.value.trim();
                const role = newRole.value;
                if (!uname || !pass) return alert('Enter username & password');

                try {
                    const resp = await fetch('/api/users', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Session-Id': sessionId
                        },
                        body: JSON.stringify({ username: uname, password: pass, role })
                    });
                    const data = await resp.json();
                    if (data.ok) {
                        newUserStatus.innerText = `User ${uname} created successfully`;
                        newUsername.value = '';
                        newPassword.value = '';
                    } else {
                        newUserStatus.innerText = `Error: ${data.error || 'Unknown error'}`;
                    }
                } catch (e) { newUserStatus.innerText = `Error: ${e}`; }
            });
        }
    }
});
