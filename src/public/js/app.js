const API_URL = '/api';

// Check Auth
const token = localStorage.getItem('token');
if (!token) {
    if (window.location.pathname !== '/login.html') {
        window.location.href = '/login.html';
    }
}

const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
};

// DOM Elements
const serverList = document.getElementById('serverList');
const addServerModal = document.getElementById('addServerModal');
const installServerModal = document.getElementById('installServerModal');
const editServerModal = document.getElementById('editServerModal');
const terminalModal = document.getElementById('terminalModal');
const terminalContainer = document.getElementById('terminal-container');

// Terminal Vars
let term;
let socket;
let fitAddon;
let currentServers = [];

// Logout
document.getElementById('logoutBtn')?.addEventListener('click', () => {
    localStorage.removeItem('token');
    window.location.href = '/login.html';
});

// DataGrid State
let sortCol = 'name';
let sortAsc = true;
let filterText = '';

// DOM Elements (New)
const searchInput = document.getElementById('searchInput');
const refreshAllBtn = document.getElementById('refreshAllBtn');
const bulkRebootBtn = document.getElementById('bulkRebootBtn');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const selectedCountSpan = document.getElementById('selectedCount');

let selectedIds = new Set();

// Initial Load
if (window.location.pathname !== '/login.html') {
    fetchServers();
    setInterval(() => {
        // Only auto-refresh if not searching or interacting heavily? 
        // Or just background refresh data but respect sort/filter
        fetchServers(true); 
    }, 10000);
}

// Fetch Servers (modified to support silent update)
async function fetchServers(silent = false) {
    try {
        const res = await fetch(`${API_URL}/servers`, { headers });
        if (res.status === 401 || res.status === 403) {
            localStorage.removeItem('token');
            window.location.href = '/login.html';
            return;
        }
        const servers = await res.json();
        currentServers = servers;
        processAndRender();
    } catch (err) {
        console.error('Failed to fetch servers', err);
        if (!silent) serverList.innerHTML = '<tr><td colspan="7" class="error-text">Failed to load servers. Ensure backend is running.</td></tr>';
    }
}

function processAndRender() {
    let displayServers = [...currentServers];

    // Filter
    if (filterText) {
        const lower = filterText.toLowerCase();
        displayServers = displayServers.filter(s => 
            s.name.toLowerCase().includes(lower) || 
            s.ip.includes(lower) || 
            s.domain.toLowerCase().includes(lower)
        );
    }

    // Sort
    displayServers.sort((a, b) => {
        let valA = a[sortCol];
        let valB = b[sortCol];

        // Handle nulls
        if (valA === null || valA === undefined) valA = '';
        if (valB === null || valB === undefined) valB = '';

        // Latency is number, others string
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();

        if (valA < valB) return sortAsc ? -1 : 1;
        if (valA > valB) return sortAsc ? 1 : -1;
        return 0;
    });

    renderServers(displayServers);
}

window.sortServers = (col) => {
    if (sortCol === col) {
        sortAsc = !sortAsc;
    } else {
        sortCol = col;
        sortAsc = true;
    }
    processAndRender();
}

searchInput?.addEventListener('input', (e) => {
    filterText = e.target.value;
    processAndRender();
});

refreshAllBtn?.addEventListener('click', async () => {
    refreshAllBtn.disabled = true;
    refreshAllBtn.innerText = 'Refreshing...';
    try {
        await fetch(`${API_URL}/servers/refresh-all`, { method: 'POST', headers });
        // Give it a moment for async jobs to start/finish some
        setTimeout(() => {
            fetchServers();
            refreshAllBtn.disabled = false;
            refreshAllBtn.innerText = 'Refresh All';
        }, 2000);
    } catch (e) {
        console.error(e);
        refreshAllBtn.disabled = false;
        refreshAllBtn.innerText = 'Refresh All';
    }
});

bulkRebootBtn?.addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Are you sure you want to REBOOT ${selectedIds.size} servers?`)) return;

    bulkRebootBtn.disabled = true;
    bulkRebootBtn.innerText = 'Processing...';

    const ids = Array.from(selectedIds);
    for (const id of ids) {
        try {
            await fetch(`${API_URL}/servers/${id}/reboot`, { method: 'POST', headers });
        } catch (e) {
            console.error(`Failed to reboot ${id}`, e);
        }
    }

    alert('Reboot commands sent.');
    bulkRebootBtn.disabled = false;
    selectedIds.clear();
    updateBulkUI();
    fetchServers();
});

// Bulk Selection Logic
window.toggleSelectAll = () => {
    if (selectAllCheckbox.checked) {
        currentServers.forEach(s => selectedIds.add(s.id));
    } else {
        selectedIds.clear();
    }
    updateBulkUI();
    renderServers(currentServers);
};

window.toggleSelect = (id) => {
    if (selectedIds.has(id)) {
        selectedIds.delete(id);
    } else {
        selectedIds.add(id);
    }
    updateBulkUI();
};

function updateBulkUI() {
    selectedCountSpan.innerText = selectedIds.size;
    if (selectedIds.size > 0) {
        bulkRebootBtn.style.display = 'inline-block';
    } else {
        bulkRebootBtn.style.display = 'none';
        selectAllCheckbox.checked = false;
    }
}

// Render Servers (Table Rows)
function renderServers(servers) {
    serverList.innerHTML = '';
    if (servers.length === 0) {
        serverList.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:2rem; color:var(--text-secondary)">No servers found.</td></tr>';
        return;
    }

    servers.forEach(server => {
        const tr = document.createElement('tr');
        
        // Status Logic
        const statusClass = `status-${server.status}`;
        
        // SSH Status Logic
        let sshStatusHtml = '';
        if (server.ssh_status) {
            const sshClass = server.ssh_status === 'ok' ? 'status-online' : 'status-error';
            const sshText = server.ssh_status === 'ok' ? 'OK' : 'Error';
            sshStatusHtml = `<span class="metric-value"><span class="status-indicator ${sshClass}" style="width:8px;height:8px;"></span>${sshText}</span>`;
        } else {
             sshStatusHtml = '<span class="metric-value">--</span>';
        }

        // Trojan Status Logic
        let trojanStatusHtml = '';
        if (server.trojan_config) {
            if (server.trojan_latency === -1) {
                // Show error if available
                const errorMsg = server.trojan_last_error || 'Fail';
                trojanStatusHtml = `<span class="metric-value danger" title="${errorMsg}">${errorMsg}</span>`;
            } else if (server.trojan_latency !== null) {
                trojanStatusHtml = `<span class="metric-value">${server.trojan_latency}ms</span>`;
            } else {
                trojanStatusHtml = '<span class="metric-value">--</span>';
            }
        } else {
            trojanStatusHtml = '<span class="text-secondary">Not Configured</span>';
        }

        // SSL expiry check
        let sslStatus = 'Unknown';
        let sslClass = '';
        if (server.ssl_expiry) {
            const daysLeft = Math.ceil((new Date(server.ssl_expiry) - new Date()) / (1000 * 60 * 60 * 24));
            sslStatus = `${daysLeft} days`;
            if (daysLeft < 20) sslClass = 'danger';
        }
        
        const isSelected = selectedIds.has(server.id);
        tr.innerHTML = `
            <td style="text-align:center;">
                <input type="checkbox" onchange="toggleSelect(${server.id})" ${isSelected ? 'checked' : ''}>
            </td>
            <td>
                <div style="display:flex; align-items:center;">
                    <span class="status-indicator ${statusClass}"></span>
                    <strong>${server.name}</strong>
                </div>
            </td>
            <td>
                <div>${server.ip}</div>
                <div class="text-secondary">${server.domain}</div>
            </td>
             <td>
                <span class="metric-value ${server.latency > 300 ? 'danger' : ''}">${server.latency ? server.latency + 'ms' : '--'}</span>
            </td>
             <td>
                ${sshStatusHtml}
            </td>
            <td>
                <span class="metric-value ${sslClass}">${sslStatus}</span>
            </td>
            <td>
                ${trojanStatusHtml}
            </td>
            <td>
                <div class="cell-actions">
                    <button class="btn-icon" onclick="editServer(${server.id})" title="Edit Server"><i class="ri-pencil-line"></i></button>
                    <button class="btn-icon" onclick="refreshServer(${server.id}, this)" title="Refresh Status"><i class="ri-refresh-line"></i></button>
                    ${server.ssh_status === 'ok' ? `<button class="btn-icon" onclick="openTerminal(${server.id}, '${server.name}')" title="Web Terminal"><i class="ri-terminal-box-line"></i></button>` : ''}
                    ${server.ssh_status === 'ok' ? `<button class="btn-icon" onclick="renewSSL(${server.id})" title="Renew SSL"><i class="ri-shield-check-line"></i></button>` : ''}
                    <button class="btn-icon warn" onclick="rebootServer(${server.id})" title="Reboot Server"><i class="ri-shut-down-line"></i></button>
                    <button class="btn-icon danger" onclick="deleteServer(${server.id})" title="Delete Server"><i class="ri-delete-bin-line"></i></button>
                </div>
            </td>
        `;
        serverList.appendChild(tr);
    });
}

// Reboot Server
window.rebootServer = async (id) => {
    if(!confirm('WARNING: Are you sure you want to REBOOT this server? It will be offline for a few minutes.')) return;
    try {
        const res = await fetch(`${API_URL}/servers/${id}/reboot`, { 
            method: 'POST',
            headers
        });
        if (res.ok) {
            alert('Reboot command sent. Server will restart.');
        } else {
            const err = await res.json();
            alert('Failed: ' + err.error);
        }
    } catch (err) {
         alert('Network Error');
    }
}

// Refresh Server
window.refreshServer = async (id, btn) => {
    const originalText = btn.innerText;
    btn.innerText = '...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_URL}/servers/${id}/refresh`, { 
            method: 'POST',
            headers
        });
        if (res.ok) {
            fetchServers(); // Re-render with new data
        } else {
            console.error('Refresh failed');
            alert('Refresh failed');
            btn.innerText = originalText;
            btn.disabled = false;
        }
    } catch (err) {
        console.error(err);
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// Delete Server
window.deleteServer = async (id) => {
    if(!confirm('Are you sure you want to delete this server? This action cannot be undone.')) return;
    
    try {
        const res = await fetch(`${API_URL}/servers/${id}`, { 
            method: 'DELETE',
            headers
        });
        if (res.ok) {
            fetchServers();
        } else {
            const err = await res.json();
            alert('Failed: ' + err.error);
        }
    } catch (err) {
         alert('Network Error');
    }
}

// Edit Server
window.editServer = (id) => {
    const server = currentServers.find(s => s.id === id);
    if (!server) return;

    const form = document.getElementById('editServerForm');
    form.name.value = server.name;
    form.ip.value = server.ip;
    form.port.value = server.port;
    form.vpn_port.value = server.vpn_port || 443;
    form.username.value = server.username;
    form.password.value = server.password;
    form.domain.value = server.domain;
    form.trojan_config.value = server.trojan_config || '';
    
    // Store ID
    form.dataset.id = id;

    editServerModal.style.display = 'block';
}

// Renew SSL
window.renewSSL = async (id) => {
    if(!confirm('Are you sure you want to renew SSL for this server? This will restart the panel.')) return;
    
    try {
        const res = await fetch(`${API_URL}/servers/${id}/renew-ssl`, { 
            method: 'POST',
            headers
        });
        if (res.ok) {
            alert('SSL Renewal started. Check back in a few minutes.');
            fetchServers();
        } else {
            const err = await res.json();
            alert('Failed: ' + err.error);
        }
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// Open Terminal
window.openTerminal = (id, name) => {
    terminalModal.style.display = 'block';
    document.getElementById('terminalTitle').innerText = `Terminal: ${name}`;
    
    // Cleanup previous session
    if (term) term.dispose();
    if (socket) socket.disconnect();
    
    // Initialize xterm
    term = new Terminal({
        cursorBlink: true,
        theme: {
            background: '#000000',
            foreground: '#ffffff'
        }
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);
    fitAddon.fit();
    
    // Connect Socket.io
    socket = io();
    socket.emit('start-session', id);
    
    term.onData(data => {
        socket.emit('input', data);
    });
    
    socket.on('output', data => {
        term.write(data);
    });
    
    // Handle Resize
    window.addEventListener('resize', () => fitAddon.fit());
}


// Modal Logic
const modals = [addServerModal, installServerModal, editServerModal, terminalModal];
const closeBtns = document.querySelectorAll('.close');

document.getElementById('addServerBtn')?.addEventListener('click', () => addServerModal.style.display = 'block');
document.getElementById('installServerBtn')?.addEventListener('click', () => installServerModal.style.display = 'block');

closeBtns.forEach(btn => btn.onclick = function() {
  modals.forEach(m => m.style.display = "none");
  if (terminalModal.style.display === 'none' && socket) {
      socket.disconnect();
  }
});

window.onclick = function(event) {
  if (modals.includes(event.target)) {
    event.target.style.display = "none";
    if (event.target === terminalModal && socket) {
        socket.disconnect();
    }
  }
}

// Form Submissions
document.getElementById('addServerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    
    if(!data.port) data.port = 22;
    if(!data.vpn_port) data.vpn_port = 443;
    if(!data.username) data.username = 'root';

    await submitForm(`${API_URL}/servers`, data, addServerModal);
});

document.getElementById('installServerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    
    if(!data.port) data.port = 22;
    if(!data.username) data.username = 'root';
    if(!data.adminUser) data.adminUser = 'Admin';
    if(!data.adminPass) data.adminPass = 'ChangeMe123!';

    await submitForm(`${API_URL}/install`, data, installServerModal);
});

document.getElementById('editServerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    const id = e.target.dataset.id;
    
    try {
        const res = await fetch(`${API_URL}/servers/${id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify(data)
        });
        
        if (res.ok) {
            editServerModal.style.display = 'none';
            fetchServers();
        } else {
            const err = await res.json();
            alert('Error: ' + err.error);
        }
    } catch (err) {
        console.error(err);
        alert('Network Error');
    }
});

async function submitForm(url, data, modal) {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(data)
        });
        
        if (res.ok) {
            modal.style.display = 'none';
            fetchServers();
            modal.querySelector('form').reset();
        } else {
            const err = await res.json();
            alert('Error: ' + err.error);
        }
    } catch (err) {
        console.error(err);
        alert('Network Error');
    }
}


