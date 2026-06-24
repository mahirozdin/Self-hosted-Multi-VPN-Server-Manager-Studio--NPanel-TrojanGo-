const API_URL = '/api';

const token = localStorage.getItem('token');
if (!token && window.location.pathname !== '/login.html') {
    window.location.href = '/login.html';
}

const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
};

const state = {
    servers: [], countries: [], groups: [], users: [], catalog: [], jobs: [],
    apps: [], appAssignments: [], selectedAppId: null,
    selectedServerId: null, filter: '',
    logsPage: 1, devicesPage: 1, bansPage: 1,
};

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function formatDate(v) { return v ? new Date(v).toLocaleString() : '—'; }
function fmtDuration(s) {
    if (s == null) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return [h ? `${h}h` : '', m ? `${m}m` : '', `${sec}s`].filter(Boolean).join(' ') || '0s';
}
function sslDays(v) {
    if (!v) return '—';
    const d = Math.round((new Date(v) - Date.now()) / 86400000);
    return d > 0 ? `${d} gün` : 'süresi doldu';
}

async function api(path, options = {}) {
    const res = await fetch(`${API_URL}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('token');
        window.location.href = '/login.html';
        return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

/* ===== Tab routing ===== */
function showPage(page) {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
    if (page === 'apps') loadApps();
    if (page === 'logs') searchLogs();
}
document.querySelectorAll('.nav-tab').forEach((t) => t.addEventListener('click', () => showPage(t.dataset.page)));

/* ===== Data ===== */
async function loadAll({ silent = false } = {}) {
    try {
        const [servers, tree, jobs] = await Promise.all([api('/servers'), api('/management-tree'), api('/provision-jobs')]);
        state.servers = servers || [];
        state.countries = tree?.countries || [];
        state.groups = tree?.groups || [];
        state.users = tree?.users || [];
        state.catalog = tree?.catalog || [];
        state.jobs = jobs || [];
        renderServers();
        renderVpn();
    } catch (error) {
        if (!silent) alert(error.message);
    }
}

/* ===== SERVERS ===== */
function serverName(id) { return state.servers.find((s) => s.id === id)?.name || `#${id}`; }
function jobForServer(id) { return state.jobs.find((j) => j.server_id === id && ['queued', 'running'].includes(j.status)); }

function renderServers() {
    document.getElementById('mServers').textContent = state.servers.length;
    document.getElementById('mOnline').textContent = state.servers.filter((s) => s.status === 'online').length;
    document.getElementById('mError').textContent = state.servers.filter((s) => s.status === 'error').length;
    document.getElementById('mJobs').textContent = state.jobs.filter((j) => ['queued', 'running'].includes(j.status)).length;

    const filter = state.filter.toLowerCase();
    const servers = state.servers.filter((s) => !filter
        || String(s.name || '').toLowerCase().includes(filter)
        || String(s.ip || '').includes(filter)
        || String(s.domain || '').toLowerCase().includes(filter));

    const list = document.getElementById('serverList');
    if (!servers.length) { list.innerHTML = '<div class="empty">Sunucu yok — "Ekle" veya "Kur" ile başlayın</div>'; return; }

    list.innerHTML = servers.map((s) => {
        const users = state.users.filter((u) => u.server_id === s.id);
        const configs = state.catalog.filter((c) => c.server_id === s.id).length;
        const job = jobForServer(s.id);
        const expanded = state.selectedServerId === s.id;
        return `
        <article class="card ${expanded ? 'selected' : ''}">
            <div class="card-head">
                <div class="card-title">
                    <span class="pill pill-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
                    <div><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.domain)} · ${escapeHtml(s.ip)}</small></div>
                </div>
                <div class="card-actions">
                    <button class="icon-btn" data-action="toggle-users" data-id="${s.id}" title="Kullanıcılar"><i class="ri-group-line"></i></button>
                    <button class="icon-btn" data-action="edit-server" data-id="${s.id}" title="Düzenle"><i class="ri-pencil-line"></i></button>
                    <button class="icon-btn" data-action="refresh-server" data-id="${s.id}" title="Durumu yenile"><i class="ri-refresh-line"></i></button>
                    <button class="icon-btn" data-action="renew-ssl" data-id="${s.id}" title="Sertifika yenile"><i class="ri-shield-check-line"></i></button>
                    <button class="icon-btn" data-action="terminal" data-id="${s.id}" title="Terminal"><i class="ri-terminal-box-line"></i></button>
                    <button class="icon-btn warn" data-action="reboot-server" data-id="${s.id}" title="Reboot"><i class="ri-restart-line"></i></button>
                    <button class="icon-btn warn" data-action="delete-server" data-id="${s.id}" title="Sil"><i class="ri-delete-bin-line"></i></button>
                </div>
            </div>
            <div class="meta-row">
                <span><i class="ri-pulse-line"></i> ${s.latency ? `${s.latency} ms` : '--'}</span>
                <span><i class="ri-plug-line"></i> SSH ${escapeHtml(s.ssh_status || 'unknown')}</span>
                <span><i class="ri-shield-check-line"></i> SSL ${escapeHtml(sslDays(s.ssl_expiry))}</span>
                <span><i class="ri-group-line"></i> ${users.length} user</span>
                <span><i class="ri-global-line"></i> ${configs} config</span>
            </div>
            ${job ? `<div class="steps">${(job.steps || []).sort((a, b) => a.sort_order - b.sort_order).map((st) => `<span class="step-dot ${escapeHtml(st.status)}" title="${escapeHtml(st.label)}"></span>`).join('')}</div><div class="hint">${escapeHtml(job.current_step || job.status)}</div>` : ''}
            ${expanded ? `
            <div class="subpanel">
                <div class="subpanel-head">
                    <h4>Bu host'taki kullanıcılar</h4>
                    <button class="btn btn-secondary btn-compact" data-action="sync-users" data-id="${s.id}"><i class="ri-user-add-line"></i> Varsayılanları oluştur</button>
                </div>
                ${users.length ? users.map((u) => `
                    <div class="list-row">
                        <div class="grow"><strong>${escapeHtml(u.name)}</strong><small>${escapeHtml(u.protocol === 0 ? 'tcp' : 'ws')}</small></div>
                        <span class="pill plain pill-${escapeHtml(u.profile_type)}">${escapeHtml(u.profile_type)}</span>
                        <span class="pill pill-${escapeHtml(u.remote_status)}">${escapeHtml(u.remote_status)}</span>
                    </div>`).join('') : '<div class="empty">Kullanıcı yok</div>'}
            </div>` : ''}
        </article>`;
    }).join('');
}

/* ===== VPN LIST ===== */
function renderVpn() {
    document.getElementById('mCountries').textContent = state.countries.length;
    document.getElementById('mActive').textContent = state.catalog.filter((c) => c.status === 'active').length;
    document.getElementById('mConfigs').textContent = state.catalog.length;

    const list = document.getElementById('countryList');
    if (!state.countries.length) { list.innerHTML = '<div class="empty">Ülke yok — "Ülke ekle" ile başlayın</div>'; return; }

    list.innerHTML = state.countries.map((c) => {
        const items = state.catalog.filter((i) => i.country_id === c.id);
        const flag = String(c.flag || '').startsWith('http')
            ? `<img class="flag" src="${escapeHtml(c.flag)}" alt="">`
            : `<span class="flag-pill">${escapeHtml(c.flag || c.code)}</span>`;
        return `
        <article class="card">
            <div class="card-head">
                <div class="card-title">${flag}<div><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.code)} · ${items.length} config</small></div></div>
            </div>
            ${items.length ? `<div class="subpanel">${items.map((i) => {
                const srv = state.servers.find((s) => s.id === i.server_id);
                const entry = i.entry_ip || srv?.ip || '—';
                const sni = i.sni || srv?.domain || '—';
                return `
                <div class="list-row">
                    <div class="grow"><strong>${escapeHtml(i.display_name)}</strong><small>giriş ${escapeHtml(entry)} · SNI ${escapeHtml(sni)}</small></div>
                    <span class="pill plain pill-${escapeHtml(i.type)}">${escapeHtml(i.type)}</span>
                    <span class="pill pill-${escapeHtml(i.status)}">${escapeHtml(i.status)}</span>
                    <button class="icon-btn" data-action="toggle-catalog" data-id="${i.id}" title="Yayınla/Taslak"><i class="ri-toggle-line"></i></button>
                    <button class="icon-btn warn" data-action="delete-catalog" data-id="${i.id}" title="Sil"><i class="ri-delete-bin-line"></i></button>
                </div>`;
            }).join('')}</div>` : '<div class="hint" style="margin-top:10px">Henüz config yok</div>'}
        </article>`;
    }).join('');
}

/* ===== APPS ===== */
async function loadApps() {
    try { state.apps = (await api('/apps')) || []; renderApps(); } catch (e) { alert(e.message); }
}
function renderApps() {
    const list = document.getElementById('appsList');
    if (!state.apps.length) { list.innerHTML = '<div class="empty">Uygulama yok — "Uygulama ekle" ile oluşturun</div>'; document.getElementById('appCatalogPanel').innerHTML = ''; return; }
    list.innerHTML = state.apps.map((a) => `
        <article class="card ${state.selectedAppId === a.id ? 'selected' : ''}">
            <div class="card-head">
                <div class="card-title"><i class="ri-apps-2-line" style="color:var(--accent);font-size:20px"></i>
                    <div><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.slug)} · ${escapeHtml(a.status)}</small></div></div>
                <div class="card-actions">
                    <button class="btn btn-secondary btn-compact" data-action="app-catalog" data-id="${a.id}"><i class="ri-list-check"></i> Katalog</button>
                    <button class="btn btn-secondary btn-compact" data-action="rotate-app" data-id="${a.id}"><i class="ri-key-2-line"></i> Anahtar</button>
                    <button class="icon-btn warn" data-action="delete-app" data-id="${a.id}" title="Sil"><i class="ri-delete-bin-line"></i></button>
                </div>
            </div>
            <div class="meta-row"><span><i class="ri-fingerprint-line"></i> <span class="mono-pill">${escapeHtml(a.app_key)}</span></span></div>
        </article>`).join('');
    if (state.selectedAppId) renderAppCatalog();
}
async function loadAppCatalog(appId) {
    state.selectedAppId = appId;
    try { state.appAssignments = (await api(`/apps/${appId}/catalog`)) || []; renderApps(); } catch (e) { alert(e.message); }
}
function renderAppCatalog() {
    const panel = document.getElementById('appCatalogPanel');
    const assigned = new Set(state.appAssignments.map((a) => a.catalog_item_id));
    const rows = state.catalog.length ? state.catalog.map((i) => `
        <label class="list-row" style="cursor:pointer">
            <input type="checkbox" style="width:auto" data-action="toggle-app-catalog" data-app="${state.selectedAppId}" data-id="${i.id}" ${assigned.has(i.id) ? 'checked' : ''}>
            <span class="grow">${escapeHtml(i.display_name)}</span>
            <span class="pill plain pill-${escapeHtml(i.type)}">${escapeHtml(i.type)}</span>
            <span class="pill pill-${escapeHtml(i.status)}">${escapeHtml(i.status)}</span>
        </label>`).join('') : '<div class="empty">Önce VPN list\'te config oluşturun</div>';
    panel.innerHTML = `<article class="card"><div class="subpanel-head"><h4>Seçili uygulamanın gördüğü config\'ler</h4></div>${rows}</article>`;
}

/* ===== LOGS / DEVICES / BANS ===== */
function pager(kind, page, total, pageSize) {
    const last = Math.max(1, Math.ceil((total || 0) / (pageSize || 100)));
    return `<div class="pager">
        <button class="btn btn-compact" data-action="page-${kind}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ Önceki</button>
        <span>Sayfa ${page} / ${last} · ${total} kayıt</span>
        <button class="btn btn-compact" data-action="page-${kind}" data-page="${page + 1}" ${page >= last ? 'disabled' : ''}>Sonraki ›</button>
    </div>`;
}
function premiumPill(v) { return v ? '<span class="pill plain pill-premium">premium</span>' : '<span class="pill plain pill-free">free</span>'; }
async function banValue(type, value) {
    if (!value || !confirm(`${type} banla: ${value}?`)) return;
    try { await api('/bans', { method: 'POST', body: JSON.stringify({ type, value }) }); alert('Banlandı: ' + value); }
    catch (e) { alert(e.message); }
}

async function searchLogs() {
    const params = new URLSearchParams();
    new FormData(document.getElementById('logsFilterForm')).forEach((v, k) => { if (v) params.append(k, v); });
    params.set('page', state.logsPage);
    try { renderLogs(await api(`/connection-logs?${params}`)); } catch (e) { alert(e.message); }
}
function renderLogs(result) {
    const logs = result?.logs || [];
    const wrap = document.getElementById('logsResults');
    if (!logs.length) { wrap.innerHTML = '<div class="empty">Kayıt yok</div>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>
        <th>Bağlantı</th><th>Device</th><th>Firebase UID</th><th>Client IP</th><th>Premium</th><th>Tip</th><th>Süre</th><th></th></tr></thead><tbody>
        ${logs.map((l) => `<tr><td>${escapeHtml(formatDate(l.connect_at))}</td><td>${escapeHtml(l.device_id)}</td>
        <td>${escapeHtml(l.firebase_uid || '—')}</td><td>${escapeHtml(l.client_ip)}</td><td>${premiumPill(l.is_premium)}</td>
        <td>${escapeHtml(l.config_type || '—')}</td><td>${escapeHtml(l.disconnect_at ? fmtDuration(l.duration_seconds) : 'aktif')}</td>
        <td style="white-space:nowrap"><button class="icon-btn warn" data-action="ban-ip" data-value="${escapeHtml(l.client_ip)}" title="IP banla"><i class="ri-forbid-line"></i></button>${l.firebase_uid ? `<button class="icon-btn warn" data-action="ban-uid" data-value="${escapeHtml(l.firebase_uid)}" title="UID banla"><i class="ri-user-forbid-line"></i></button>` : ''}</td></tr>`).join('')}</tbody></table></div>${pager('logs', result.page, result.total, result.pageSize)}`;
}
async function searchDevices() {
    const params = new URLSearchParams();
    new FormData(document.getElementById('devicesFilterForm')).forEach((v, k) => { if (v) params.append(k, v); });
    params.set('page', state.devicesPage);
    try { renderDevices(await api(`/devices?${params}`)); } catch (e) { alert(e.message); }
}
function renderDevices(result) {
    const devices = result?.devices || [];
    const wrap = document.getElementById('devicesResults');
    if (!devices.length) { wrap.innerHTML = '<div class="empty">Cihaz yok</div>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>
        <th>Device ID</th><th>Firebase UID</th><th>Platform</th><th>Premium</th><th>Son görülme</th><th></th></tr></thead><tbody>
        ${devices.map((d) => `<tr><td>${escapeHtml(d.device_id)}</td><td>${escapeHtml(d.firebase_uid || '—')}</td>
        <td>${escapeHtml(d.platform)}</td><td>${premiumPill(d.is_premium)}</td><td>${escapeHtml(formatDate(d.last_seen_at))}</td>
        <td style="white-space:nowrap"><button class="icon-btn warn" data-action="ban-device" data-value="${escapeHtml(d.device_id)}" title="Cihazı banla"><i class="ri-forbid-line"></i></button>${d.firebase_uid ? `<button class="icon-btn warn" data-action="ban-uid" data-value="${escapeHtml(d.firebase_uid)}" title="UID banla"><i class="ri-user-forbid-line"></i></button>` : ''}</td></tr>`).join('')}</tbody></table></div>${pager('devices', result.page, result.total, result.pageSize)}`;
}
async function loadBans() {
    try { renderBans(await api(`/bans?page=${state.bansPage}`)); } catch (e) { alert(e.message); }
}
function renderBans(result) {
    const bans = result?.bans || [];
    const wrap = document.getElementById('bansResults');
    if (!bans.length) { wrap.innerHTML = '<div class="empty">Yasak yok</div>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr>
        <th>Tip</th><th>Değer</th><th>Sebep</th><th>Tarih</th><th></th></tr></thead><tbody>
        ${bans.map((b) => `<tr><td>${escapeHtml(b.type)}</td><td>${escapeHtml(b.value)}</td>
        <td>${escapeHtml(b.reason || '—')}</td><td>${escapeHtml(formatDate(b.createdAt))}</td>
        <td><button class="icon-btn warn" data-action="remove-ban" data-id="${b.id}" title="Kaldır"><i class="ri-delete-bin-line"></i></button></td></tr>`).join('')}</tbody></table></div>${pager('bans', result.page, result.total, result.pageSize)}`;
}
document.querySelectorAll('.inner-tab').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.inner-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.logtab;
    document.getElementById('logsTab').style.display = tab === 'logs' ? 'block' : 'none';
    document.getElementById('devicesTab').style.display = tab === 'devices' ? 'block' : 'none';
    document.getElementById('bansTab').style.display = tab === 'bans' ? 'block' : 'none';
    if (tab === 'devices') searchDevices();
    if (tab === 'bans') loadBans();
}));
document.getElementById('logsFilterForm').addEventListener('submit', (e) => { e.preventDefault(); state.logsPage = 1; searchLogs(); });
document.getElementById('devicesFilterForm').addEventListener('submit', (e) => { e.preventDefault(); state.devicesPage = 1; searchDevices(); });
document.getElementById('banForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try { await api('/bans', { method: 'POST', body: JSON.stringify(d) }); e.target.reset(); state.bansPage = 1; loadBans(); }
    catch (err) { alert(err.message); }
});

/* ===== Modals ===== */
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModals() {
    document.querySelectorAll('.modal').forEach((m) => m.classList.remove('open'));
    if (terminalSocket) terminalSocket.disconnect();
}
document.querySelectorAll('.close').forEach((b) => b.addEventListener('click', closeModals));
window.addEventListener('click', (e) => { if (e.target.classList.contains('modal')) closeModals(); });

document.getElementById('addServerBtn').addEventListener('click', () => openModal('addServerModal'));
document.getElementById('installServerBtn').addEventListener('click', () => openModal('installServerModal'));
document.getElementById('addCountryBtn').addEventListener('click', () => openModal('countryModal'));
document.getElementById('newAppBtn').addEventListener('click', () => openModal('appModal'));
document.getElementById('addConfigBtn').addEventListener('click', openConfigModal);
document.getElementById('logoutBtn').addEventListener('click', () => { localStorage.removeItem('token'); window.location.href = '/login.html'; });
document.getElementById('refreshAllBtn').addEventListener('click', async () => { await api('/servers/refresh-all', { method: 'POST' }); setTimeout(() => loadAll({ silent: true }), 1500); });
document.getElementById('serverSearch').addEventListener('input', (e) => { state.filter = e.target.value; renderServers(); });

/* ===== Config modal ===== */
function openConfigModal() {
    const cs = document.getElementById('configCountry');
    cs.innerHTML = state.countries.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    const ss = document.getElementById('configServer');
    ss.innerHTML = state.servers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.ip)})</option>`).join('');
    populateConfigUsers();
    openModal('configModal');
}
function populateConfigUsers() {
    const serverId = Number(document.getElementById('configServer').value);
    const us = document.getElementById('configUser');
    const users = state.users.filter((u) => u.server_id === serverId);
    us.innerHTML = users.length ? users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.profile_type)})</option>`).join('') : '<option value="">— önce host\'ta kullanıcı oluşturun —</option>';
}
document.getElementById('configServer').addEventListener('change', populateConfigUsers);

/* ===== Country flag preview ===== */
const countryCodeInput = document.getElementById('countryCodeInput');
countryCodeInput.addEventListener('input', () => {
    const code = countryCodeInput.value.trim().toLowerCase();
    const flagInput = document.getElementById('countryFlagInput');
    const preview = document.getElementById('countryFlagPreview');
    if (code.length === 2) { const url = `https://flagcdn.com/w80/${code}.png`; flagInput.value = url; preview.src = url; }
    else { flagInput.value = ''; preview.removeAttribute('src'); }
});

/* ===== Form submits ===== */
async function submitForm(url, data, modalId) {
    await api(url, { method: 'POST', body: JSON.stringify(data) });
    document.getElementById(modalId).classList.remove('open');
    document.querySelector(`#${modalId} form`)?.reset();
    await loadAll({ silent: true });
}
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

document.getElementById('addServerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await submitForm('/servers', formData(e.target), 'addServerModal'); } catch (err) { alert(err.message); }
});
document.getElementById('installServerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await submitForm('/install', formData(e.target), 'installServerModal'); } catch (err) { alert(err.message); }
});
document.getElementById('editServerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
        await api(`/servers/${form.dataset.id}`, { method: 'PUT', body: JSON.stringify(formData(form)) });
        document.getElementById('editServerModal').classList.remove('open');
        await loadAll({ silent: true });
    } catch (err) { alert(err.message); }
});
document.getElementById('countryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await submitForm('/countries', formData(e.target), 'countryModal'); } catch (err) { alert(err.message); }
});
document.getElementById('appForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const created = await api('/apps', { method: 'POST', body: JSON.stringify(formData(e.target)) });
        document.getElementById('appModal').classList.remove('open');
        e.target.reset();
        if (created) alert(`Uygulama oluşturuldu.\n\nX-App-Key (build'e göm):\n${created.app_key}\n\nHMAC secret (bir kez gösterilir):\n${created.hmac_secret}`);
        loadApps();
    } catch (err) { alert(err.message); }
});
document.getElementById('configForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const user = state.users.find((u) => u.id === Number(d.npanel_user_id));
    if (!user) { alert('Önce bu host\'ta kullanıcı oluşturun.'); return; }
    try {
        const item = await api('/catalog/assign', {
            method: 'POST',
            body: JSON.stringify({
                country_id: Number(d.country_id), server_id: Number(d.server_id),
                npanel_user_id: Number(d.npanel_user_id), type: d.type,
                display_name: d.display_name || undefined, status: 'active',
                config: d.config || undefined,
            }),
        });
        if (item && (d.entry_ip || d.sni)) {
            await api(`/catalog/${item.id}`, { method: 'PUT', body: JSON.stringify({ entry_ip: d.entry_ip || null, sni: d.sni || null }) });
        }
        document.getElementById('configModal').classList.remove('open');
        e.target.reset();
        await loadAll({ silent: true });
    } catch (err) { alert(err.message); }
});

/* ===== Delegated actions ===== */
document.body.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = Number(target.dataset.id);
    try {
        if (action === 'toggle-users') { state.selectedServerId = state.selectedServerId === id ? null : id; renderServers(); }
        else if (action === 'edit-server') {
            const s = state.servers.find((x) => x.id === id);
            const f = document.getElementById('editServerForm');
            f.dataset.id = s.id; f.name.value = s.name; f.ip.value = s.ip; f.port.value = s.port || 22;
            f.vpn_port.value = s.vpn_port || 443; f.username.value = s.username || 'root'; f.password.value = '';
            f.domain.value = s.domain; f.trojan_config.value = s.trojan_config || '';
            openModal('editServerModal');
        }
        else if (action === 'refresh-server') { await api(`/servers/${id}/refresh`, { method: 'POST' }); await loadAll({ silent: true }); }
        else if (action === 'renew-ssl') { if (confirm('Sertifikayı yenile?')) { await api(`/servers/${id}/renew-ssl`, { method: 'POST' }); await loadAll({ silent: true }); } }
        else if (action === 'terminal') { openTerminal(id); }
        else if (action === 'reboot-server') { if (confirm('Sunucuyu yeniden başlat?')) await api(`/servers/${id}/reboot`, { method: 'POST' }); }
        else if (action === 'delete-server') { if (confirm('Sunucuyu sil?')) { await api(`/servers/${id}`, { method: 'DELETE' }); await loadAll({ silent: true }); } }
        else if (action === 'sync-users') { await api(`/servers/${id}/users/sync-defaults`, { method: 'POST', body: JSON.stringify({ remote: true }) }); await loadAll({ silent: true }); }
        else if (action === 'toggle-catalog') {
            const item = state.catalog.find((c) => c.id === id);
            await api(`/catalog/${id}`, { method: 'PUT', body: JSON.stringify({ status: item.status === 'active' ? 'draft' : 'active' }) });
            await loadAll({ silent: true });
        }
        else if (action === 'delete-catalog') { if (confirm('Config\'i sil?')) { await api(`/catalog/${id}`, { method: 'DELETE' }); await loadAll({ silent: true }); } }
        else if (action === 'select-app' || action === 'app-catalog') { await loadAppCatalog(id); }
        else if (action === 'rotate-app') {
            if (!confirm('Anahtarı döndür? Eski key/secret hemen geçersiz olur.')) return;
            const r = await api(`/apps/${id}/rotate-key`, { method: 'POST' });
            if (r) alert(`Yeni X-App-Key:\n${r.app_key}\n\nYeni HMAC secret:\n${r.hmac_secret}`);
            loadApps();
        }
        else if (action === 'delete-app') { if (confirm('Uygulamayı sil?')) { await api(`/apps/${id}`, { method: 'DELETE' }); if (state.selectedAppId === id) state.selectedAppId = null; loadApps(); } }
        else if (action === 'toggle-app-catalog') {
            const appId = Number(target.dataset.app);
            if (target.checked) await api(`/apps/${appId}/catalog`, { method: 'POST', body: JSON.stringify({ catalog_item_id: id, status: 'active' }) });
            else await api(`/apps/${appId}/catalog/${id}`, { method: 'DELETE' });
            await loadAppCatalog(appId);
        }
        else if (action === 'ban-ip') await banValue('ip', target.dataset.value);
        else if (action === 'ban-device') await banValue('device_id', target.dataset.value);
        else if (action === 'ban-uid') await banValue('firebase_uid', target.dataset.value);
        else if (action === 'remove-ban') { if (confirm('Yasağı kaldır?')) { await api(`/bans/${id}`, { method: 'DELETE' }); loadBans(); } }
        else if (action === 'page-logs') { state.logsPage = Number(target.dataset.page); searchLogs(); }
        else if (action === 'page-devices') { state.devicesPage = Number(target.dataset.page); searchDevices(); }
        else if (action === 'page-bans') { state.bansPage = Number(target.dataset.page); loadBans(); }
    } catch (error) { alert(error.message); }
});

/* ===== Terminal ===== */
let term, terminalSocket, fitAddon;
function openTerminal(serverId) {
    const s = state.servers.find((x) => x.id === serverId);
    if (!s) return;
    openModal('terminalModal');
    document.getElementById('terminalTitle').textContent = `Terminal: ${s.name}`;
    if (term) term.dispose();
    if (terminalSocket) terminalSocket.disconnect();
    term = new Terminal({ cursorBlink: true, theme: { background: '#000000', foreground: '#e6edf3' } });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();
    terminalSocket = io({ auth: { token } });
    terminalSocket.emit('start-session', serverId);
    term.onData((d) => terminalSocket.emit('input', d));
    terminalSocket.on('output', (d) => term.write(d));
}

/* ===== Live job updates ===== */
const provisionSocket = io({ auth: { token } });
provisionSocket.on('provision:update', (job) => {
    const idx = state.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) state.jobs[idx] = job; else state.jobs.unshift(job);
    renderServers();
});

loadAll();
setInterval(() => loadAll({ silent: true }), 15000);
