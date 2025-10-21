let myRole = '';
let token = '';

document.getElementById('loginBtn').addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const resp = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password})});
    const data = await resp.json();
    if(!data.token){ alert(data.error||'Login failed'); return; }
    token = data.token;
    myRole = data.role;
    document.getElementById('loginDiv').style.display='none';
    document.getElementById('panelDiv').style.display='block';
    document.getElementById('userRole').innerText=myRole;
    setupOwnerButtons();
    loadOnlineUsers();
});

async function loadOnlineUsers(){
    try{
        const resp = await fetch('/api/online',{headers:{Authorization:`Bearer ${token}`}});
        const data = await resp.json();
        const list = document.getElementById('onlineList');
        list.innerHTML='';
        data.forEach(u=>{
            const li = document.createElement('li');
            li.innerText=`${u.username} (${u.role})`;
            list.appendChild(li);
        });
        setTimeout(loadOnlineUsers,2000);
    }catch(e){ console.log(e); setTimeout(loadOnlineUsers,5000);}
}

function setupOwnerButtons(){
    if(myRole==='owner'){
        document.getElementById('killSwitchBtn').style.display='inline-block';
        document.getElementById('downloadBtn').style.display='inline-block';
        document.getElementById('newUserDiv').style.display='block';
    }
}
