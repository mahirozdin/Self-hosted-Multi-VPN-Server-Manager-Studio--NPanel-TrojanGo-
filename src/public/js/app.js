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
    overview: null, incidents: [], settings: {},
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
function formatBytes(n) {
    n = Number(n || 0);
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let i = -1;
    do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
    return `${n.toFixed(n < 10 ? 2 : 1)} ${units[i]}`;
}
function formatSpeed(bps) { return bps ? `${formatBytes(bps)}/s` : '0'; }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
// Health verdict from the monitor, with a legacy fallback for old rows.
function healthOf(s) {
    return s.health_status || (s.status === 'online' ? 'online' : (s.status === 'error' ? 'offline' : 'unknown'));
}
function statusLabel(s) {
    return ({ online: 'online', degraded: 'kısmi', offline: 'offline', unknown: 'bilinmiyor', installing: 'kuruluyor', renewing_ssl: 'sertifika', error: 'offline' })[s] || s;
}
function remoteLabel(s) {
    return ({ synced: 'senkron', desired: 'bekliyor', trojan_api_error: 'hata' })[s] || s || 'bekliyor';
}
function flagHtml(c) {
    if (!c) return '<span class="flag-pill">?</span>';
    return String(c.flag || '').startsWith('http')
        ? `<img class="flag" src="${escapeHtml(c.flag)}" alt="">`
        : `<span class="flag-pill">${escapeHtml(c.flag || c.code)}</span>`;
}
async function ensureApps() {
    if (!state.apps.length) { try { state.apps = (await api('/apps')) || []; } catch (_) { /* ignore */ } }
    return state.apps;
}

// Full ISO-3166 alpha-2 code list; names come from the browser (Intl) and flags
// from flagcdn — so the country picker is complete without seeding the DB.
const ISO_COUNTRY_CODES = ('AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW').split(' ');
// Emoji flag from an ISO-2 code (regional indicator symbols) — for <option>
// labels, where <img> can't be rendered.
function flagEmoji(code) {
    if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
    const cc = String(code).toUpperCase();
    return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
}
let _countryCatalog = null;
function allCountries() {
    if (_countryCatalog) return _countryCatalog;
    // English names everywhere (panel + API), even though the panel UI is Turkish.
    let names = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { names = null; }
    _countryCatalog = ISO_COUNTRY_CODES.map((code) => {
        let name = code;
        try { name = (names && names.of(code)) || code; } catch (_) { name = code; }
        return { code, name, flag: `https://flagcdn.com/w80/${code.toLowerCase()}.png` };
    }).filter((c) => c.name && c.name !== c.code)
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return _countryCatalog;
}
function countryNameForCode(code) {
    const c = allCountries().find((x) => x.code === code);
    return c ? c.name : code;
}
// English display name for a stored country row (from its ISO code), so the panel
// shows English even for rows saved before this convention.
function countryLabel(c) {
    if (c && c.code && /^[A-Za-z]{2}$/.test(c.code)) {
        const found = allCountries().find((x) => x.code === String(c.code).toUpperCase());
        if (found) return found.name;
    }
    return c ? c.name : '';
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
    if (page === 'overview') loadOverview();
    if (page === 'apps') loadApps();
    if (page === 'logs') searchLogs();
    if (page === 'settings') loadSettings();
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
    setText('mServers', state.servers.length);
    setText('mOnline', state.servers.filter((s) => healthOf(s) === 'online').length);
    setText('mError', state.servers.filter((s) => healthOf(s) === 'offline').length);
    setText('mJobs', state.jobs.filter((j) => ['queued', 'running'].includes(j.status)).length);

    const filter = state.filter.toLowerCase();
    const servers = state.servers.filter((s) => !filter
        || String(s.name || '').toLowerCase().includes(filter)
        || String(s.ip || '').includes(filter)
        || String(s.domain || '').toLowerCase().includes(filter));

    const list = document.getElementById('serverList');
    if (!servers.length) { list.innerHTML = '<div class="empty">Sunucu yok — "Ekle" veya "Kur" ile başlayın</div>'; return; }

    // Group servers by country, mirroring the mobile app's country → server layout.
    const byCountry = new Map();
    for (const s of servers) {
        const key = s.country_id || 0;
        if (!byCountry.has(key)) byCountry.set(key, []);
        byCountry.get(key).push(s);
    }
    const ordered = [...state.countries].sort((a, b) => (a.sort_order - b.sort_order) || String(a.name).localeCompare(b.name));
    const groups = [];
    for (const c of ordered) { if (byCountry.has(c.id)) groups.push([c, byCountry.get(c.id)]); }
    if (byCountry.has(0)) groups.push([null, byCountry.get(0)]);

    list.innerHTML = groups.map(([c, srvs]) => {
        const head = `<div class="country-group-head">${flagHtml(c)}<div><strong>${c ? escapeHtml(countryLabel(c)) : 'Ülkesiz'}</strong> ${c ? `<small>${escapeHtml(c.code)}</small>` : ''}</div><span class="count">${srvs.length} sunucu</span></div>`;
        return `<div class="country-group">${head}${srvs.map(serverCard).join('')}</div>`;
    }).join('');
}

function serverCard(s) {
    const users = state.users.filter((u) => u.server_id === s.id);
    const configs = state.catalog.filter((c) => c.server_id === s.id).length;
    const job = jobForServer(s.id);
    const expanded = state.selectedServerId === s.id;
    const showStatus = ['installing', 'renewing_ssl'].includes(s.status) ? s.status : healthOf(s);
    return `
        <article class="card ${expanded ? 'selected' : ''}">
            <div class="card-head">
                <div class="card-title">
                    <span class="pill pill-${escapeHtml(showStatus)}">${escapeHtml(statusLabel(showStatus))}</span>
                    <div><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.domain)} · ${escapeHtml(s.ip)}</small></div>
                </div>
                <div class="card-actions">
                    <button class="icon-btn" data-action="publish-server" data-id="${s.id}" title="Yayınla + uygulamaya ata"><i class="ri-rocket-2-line"></i></button>
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
                <span><i class="ri-group-line"></i> ${users.length} kullanıcı</span>
                <span><i class="ri-global-line"></i> ${configs} config</span>
            </div>
            ${job ? `<div class="steps">${(job.steps || []).sort((a, b) => a.sort_order - b.sort_order).map((st) => `<span class="step-dot ${escapeHtml(st.status)}" title="${escapeHtml(st.label)}"></span>`).join('')}</div><div class="hint">${escapeHtml(job.current_step || job.status)}</div>` : ''}
            ${expanded ? `
            <div class="subpanel">
                <div class="subpanel-head">
                    <h4>Kullanıcılar (${users.length})</h4>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                        <button class="btn btn-secondary btn-compact" data-action="add-user" data-id="${s.id}"><i class="ri-user-add-line"></i> Kullanıcı</button>
                        <button class="btn btn-secondary btn-compact" data-action="import-users" data-id="${s.id}"><i class="ri-download-2-line"></i> İçe aktar</button>
                        <button class="btn btn-secondary btn-compact" data-action="sync-users-now" data-id="${s.id}"><i class="ri-refresh-line"></i> Senkronize et</button>
                        <button class="btn btn-secondary btn-compact" data-action="sync-users" data-id="${s.id}"><i class="ri-magic-line"></i> Varsayılanlar</button>
                    </div>
                </div>
                ${users.length ? users.map((u) => userRow(s, u)).join('') : '<div class="empty">Kullanıcı yok — "Varsayılanlar" ile Free/Premium oluşturun</div>'}
            </div>` : ''}
        </article>`;
}

function userRow(s, u) {
    const up = formatBytes(u.traffic_up); const down = formatBytes(u.traffic_down);
    const live = (u.speed_down_current || u.speed_up_current)
        ? ` · <span style="color:var(--green)">↓${formatSpeed(u.speed_down_current)} ↑${formatSpeed(u.speed_up_current)}</span>` : '';
    const limit = (u.speed_download || u.speed_upload) ? `${u.speed_download || u.speed_upload} KiB/s` : 'limitsiz';
    const imported = u.source === 'imported';
    const statusPill = imported
        ? '<span class="pill plain pill-imported" title="Sunucudan içe aktarıldı — config NPanel’de, düzenlenemez">içe aktarıldı</span>'
        : `<span class="pill pill-${escapeHtml(u.remote_status)}" title="${escapeHtml(u.remote_message || '')}">${escapeHtml(remoteLabel(u.remote_status))}</span>`;
    const actions = imported
        ? `<button class="icon-btn" data-action="adopt-user" data-server="${s.id}" title="Config ile yönet"><i class="ri-links-line"></i></button>
           <button class="icon-btn warn" data-action="delete-user" data-server="${s.id}" data-id="${u.id}" data-imported="1" title="Panelden kaldır (sunucuya dokunmaz)"><i class="ri-eye-off-line"></i></button>`
        : `<button class="icon-btn" data-action="copy-config" data-config="${escapeHtml(u.config_ws || '')}" title="Config kopyala"><i class="ri-file-copy-line"></i></button>
           <button class="icon-btn" data-action="edit-user" data-server="${s.id}" data-id="${u.id}" title="Düzenle"><i class="ri-pencil-line"></i></button>
           <button class="icon-btn ${u.enabled ? '' : 'warn'}" data-action="toggle-user" data-server="${s.id}" data-id="${u.id}" data-enabled="${u.enabled ? 1 : 0}" title="${u.enabled ? 'Devre dışı bırak' : 'Aktifleştir'}"><i class="ri-${u.enabled ? 'pause' : 'play'}-circle-line"></i></button>
           <button class="icon-btn warn" data-action="delete-user" data-server="${s.id}" data-id="${u.id}" title="Sil"><i class="ri-delete-bin-line"></i></button>`;
    return `
        <div class="list-row">
            <div class="grow"><strong>${escapeHtml(u.name)}</strong>
                <small class="traffic">↑<b>${up}</b> ↓<b>${down}</b>${live} · ${escapeHtml(limit)} · ip ${u.ip_limit ? u.ip_limit : '∞'}</small></div>
            <span class="pill plain pill-${escapeHtml(u.profile_type)}">${escapeHtml(u.profile_type)}</span>
            ${statusPill}
            <div class="user-actions">${actions}</div>
        </div>`;
}

/* ===== OVERVIEW ===== */
async function loadOverview() {
    try {
        const [ov, incidents] = await Promise.all([api('/overview'), api('/incidents?status=open&limit=50')]);
        state.overview = ov; state.incidents = incidents || [];
        renderOverview();
    } catch (_) { /* silent */ }
}
function renderOverview() {
    const ov = state.overview; if (!ov) return;
    setText('ovServers', ov.servers.total);
    setText('ovOnline', ov.servers.online || 0);
    setText('ovDegraded', ov.servers.degraded || 0);
    setText('ovOffline', ov.servers.offline || 0);
    setText('ovCountries', ov.countryCount || 0);
    setText('ovConfigs', ov.activeConfigs || 0);
    setText('ovIncidentCount', ov.openIncidents || 0);

    const inc = state.incidents;
    document.getElementById('ovIncidents').innerHTML = inc.length ? inc.map((i) => `
        <div class="ov-row"><span class="pill pill-offline">${escapeHtml(i.kind)}</span>
            <div class="grow"><strong>${escapeHtml(i.server ? i.server.name : `#${i.server_id}`)}</strong><small>${escapeHtml(i.message || '')}</small></div>
            <span class="when">${escapeHtml(formatDate(i.started_at))}</span></div>`).join('') : '<div class="empty">Açık olay yok — her şey yolunda</div>';

    const certs = ov.certsExpiringSoon || [];
    document.getElementById('ovCerts').innerHTML = certs.length ? certs.map((c) => `
        <div class="ov-row"><span class="pill ${c.daysLeft < 7 ? 'pill-offline' : 'pill-draft'}">${c.daysLeft} gün</span>
            <div class="grow"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.domain)}</small></div>
            <button class="btn btn-compact" data-action="renew-ssl" data-id="${c.id}">Yenile</button></div>`).join('') : '<div class="empty">Yakında dolan sertifika yok</div>';
}

/* ===== SETTINGS ===== */
async function loadSettings() {
    try {
        await ensureApps();
        const r = await api('/settings');
        state.settings = (r && r.settings) || {};
        const badge = document.getElementById('smtpStatus');
        const configured = r && r.smtp && r.smtp.configured;
        badge.textContent = configured ? 'yapılandırıldı' : 'yapılandırılmadı';
        badge.className = `pill ${configured ? 'pill-online' : 'pill-error'}`;
        const sel = document.getElementById('settingsDefaultApp');
        sel.innerHTML = '<option value="">— seçili değil —</option>' + state.apps.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
        const f = document.getElementById('settingsForm');
        f.alert_email.value = state.settings.alert_email || '';
        f.default_app_id.value = state.settings.default_app_id || '';
        f.ssl_renew_days.value = state.settings.ssl_renew_days || 21;
        f.free_speed_kib.value = state.settings.free_speed_kib || 4096;
        f.premium_speed_kib.value = state.settings.premium_speed_kib || 0;
        f.free_ip_limit.value = state.settings.free_ip_limit != null ? state.settings.free_ip_limit : 0;
        f.monitor_enabled.checked = String(state.settings.monitor_enabled) === 'true';
        f.auto_renew_ssl.checked = String(state.settings.auto_renew_ssl) === 'true';
        f.config_test_enabled.checked = String(state.settings.config_test_enabled) === 'true';
        f.config_test_timeout.value = state.settings.config_test_timeout || 30;
    } catch (_) { /* silent */ }
}

/* ===== VPN LIST ===== */
// Latency summary from the last-10-test window (only when the config passed).
function latencyText(i) {
    if (!i.last_test_ok || i.latency_avg == null) return '';
    return ` · <span class="lat-tag">⏱ ort ${i.latency_avg} / min ${i.latency_min} / maks ${i.latency_max} ms</span>`;
}
// Health pill from the real-tunnel test: green ok, red fail (with reason), grey untested.
function testPill(i) {
    if (i.last_test_ok == null) return '<span class="pill pill-unknown" title="Henüz test edilmedi">test —</span>';
    if (i.last_test_ok) return '<span class="pill pill-online" title="Gerçek tünel testi başarılı">test ✓</span>';
    return `<span class="pill pill-offline" title="${escapeHtml(i.last_test_error || 'başarısız')}">test ✗</span>`;
}
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
                <div class="card-title">${flag}<div><strong>${escapeHtml(countryLabel(c))}</strong><small>${escapeHtml(c.code)} · ${items.length} config</small></div></div>
                <div class="card-actions">
                    <button class="icon-btn warn" data-action="delete-country" data-id="${c.id}" title="Ülkeyi sil (config yoksa)"><i class="ri-delete-bin-line"></i></button>
                </div>
            </div>
            ${items.length ? `<div class="subpanel">${items.map((i) => {
                const srv = state.servers.find((s) => s.id === i.server_id);
                const entry = i.entry_ip || srv?.ip || '—';
                const sni = i.sni || srv?.domain || '—';
                return `
                <div class="list-row">
                    <div class="grow"><strong>${escapeHtml(i.display_name)}</strong><small>giriş ${escapeHtml(entry)} · SNI ${escapeHtml(sni)}${latencyText(i)}</small></div>
                    <span class="pill plain pill-${escapeHtml(i.type)}">${escapeHtml(i.type)}</span>
                    ${testPill(i)}
                    <span class="pill pill-${escapeHtml(i.status)}">${escapeHtml(i.status)}</span>
                    <button class="icon-btn" data-action="test-config" data-id="${i.id}" title="Configi şimdi test et"><i class="ri-pulse-line"></i></button>
                    <button class="icon-btn" data-action="edit-catalog" data-id="${i.id}" title="Düzenle"><i class="ri-pencil-line"></i></button>
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

/* ===== One-click publish: activate a server's configs + assign to an app ===== */
let pendingAppPick = null;
// Resolves with the chosen app id (or null if the picker is closed).
function chooseApp() {
    return new Promise((resolve) => {
        pendingAppPick = resolve;
        document.getElementById('appPickerList').innerHTML = state.apps.map((a) =>
            `<button type="button" class="btn btn-secondary full-span" data-action="pick-app" data-id="${a.id}">${escapeHtml(a.name)} — <small>${escapeHtml(a.slug)}</small></button>`).join('');
        openModal('appPickerModal');
    });
}
async function publishServer(serverId) {
    const items = state.catalog.filter((c) => c.server_id === serverId);
    if (!items.length) { alert('Bu sunucuda config yok. Önce kart içinden "Varsayılanları oluştur" deyin.'); return; }

    // 1) Activate every draft/hidden config of this server.
    await Promise.all(items.filter((i) => i.status !== 'active')
        .map((i) => api(`/catalog/${i.id}`, { method: 'PUT', body: JSON.stringify({ status: 'active' }) })));

    // 2) Pick the target app (auto when there is exactly one).
    if (!state.apps.length) state.apps = (await api('/apps')) || [];
    if (!state.apps.length) {
        await loadAll({ silent: true });
        alert(`${items.length} config yayınlandı (active). Henüz uygulama yok — "Apps" sekmesinden uygulama oluşturup atayın.`);
        return;
    }
    const appId = state.apps.length === 1 ? state.apps[0].id : await chooseApp();
    if (!appId) { await loadAll({ silent: true }); return; }

    // 3) Expose all of this server's configs to that app.
    await Promise.all(items.map((i) =>
        api(`/apps/${appId}/catalog`, { method: 'POST', body: JSON.stringify({ catalog_item_id: i.id, status: 'active' }) })));
    await loadAll({ silent: true });
    const appName = state.apps.find((a) => a.id === appId)?.name || `#${appId}`;
    alert(`${items.length} config yayınlandı ve "${appName}" uygulamasına atandı.`);
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
    if (pendingAppPick) { const resolve = pendingAppPick; pendingAppPick = null; resolve(null); }
}
document.querySelectorAll('.close').forEach((b) => b.addEventListener('click', closeModals));
window.addEventListener('click', (e) => { if (e.target.classList.contains('modal')) closeModals(); });

// Fill an app <select> with the tenant apps (keeping its leading default option).
function populateAppSelect(selectId) {
    ensureApps().then(() => {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const first = sel.querySelector('option'); // keep "default (from Settings)"
        sel.innerHTML = (first ? first.outerHTML : '') + state.apps.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
    });
}
document.getElementById('addServerBtn').addEventListener('click', () => { populateCountrySelect('addServerCountry'); populateAppSelect('addServerApp'); openModal('addServerModal'); });
document.getElementById('installServerBtn').addEventListener('click', () => { populateCountrySelect('installServerCountry'); populateAppSelect('installServerApp'); openModal('installServerModal'); });
document.getElementById('addCountryBtn').addEventListener('click', () => openModal('countryModal'));
document.getElementById('newAppBtn').addEventListener('click', () => openModal('appModal'));
document.getElementById('addConfigBtn').addEventListener('click', openConfigModal);
document.getElementById('logoutBtn').addEventListener('click', () => { localStorage.removeItem('token'); window.location.href = '/login.html'; });
document.getElementById('refreshAllBtn').addEventListener('click', async () => { await api('/servers/refresh-all', { method: 'POST' }); setTimeout(() => loadAll({ silent: true }), 1500); });
document.getElementById('serverSearch').addEventListener('input', (e) => { state.filter = e.target.value; renderServers(); });
document.getElementById('overviewRefreshBtn').addEventListener('click', loadOverview);

/* ===== Settings form ===== */
document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
        alert_email: f.alert_email.value,
        default_app_id: f.default_app_id.value,
        ssl_renew_days: f.ssl_renew_days.value,
        free_speed_kib: f.free_speed_kib.value,
        premium_speed_kib: f.premium_speed_kib.value,
        free_ip_limit: f.free_ip_limit.value,
        monitor_enabled: f.monitor_enabled.checked ? 'true' : 'false',
        auto_renew_ssl: f.auto_renew_ssl.checked ? 'true' : 'false',
        config_test_enabled: f.config_test_enabled.checked ? 'true' : 'false',
        config_test_timeout: f.config_test_timeout.value,
    };
    try { await api('/settings', { method: 'PUT', body: JSON.stringify(body) }); alert('Ayarlar kaydedildi'); loadSettings(); }
    catch (err) { alert(err.message); }
});
document.getElementById('testEmailBtn').addEventListener('click', async () => {
    const to = document.getElementById('settingsForm').alert_email.value;
    try {
        const r = await api('/settings/test-email', { method: 'POST', body: JSON.stringify({ to }) });
        alert(r && r.ok ? 'Test e-postası gönderildi ✅' : `Gönderilemedi: ${(r && (r.reason || r.error)) || 'SMTP yapılandırılmadı (.env)'}`);
    } catch (e) { alert(e.message); }
});

/* ===== User create/edit modal ===== */
let editingUser = null;
function openUserModal(serverId, user) {
    editingUser = { serverId, userId: user ? user.id : null };
    const f = document.getElementById('userForm');
    f.reset();
    document.getElementById('userModalTitle').textContent = user ? 'Kullanıcıyı düzenle' : 'Kullanıcı ekle';
    if (user) {
        f.name.value = user.name;
        f.profile_type.value = user.profile_type;
        f.speed_upload.value = user.speed_upload;
        f.speed_download.value = user.speed_download;
        f.ip_limit.value = user.ip_limit;
        f.password.value = '';
        f.enabled.checked = !!user.enabled;
    } else {
        f.enabled.checked = true;
    }
    openModal('userModal');
}
document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
        name: f.name.value,
        profile_type: f.profile_type.value,
        speed_upload: f.speed_upload.value,
        speed_download: f.speed_download.value,
        ip_limit: f.ip_limit.value,
        enabled: f.enabled.checked,
    };
    if (f.password.value.trim()) body.password = f.password.value.trim();
    try {
        if (editingUser.userId) {
            await api(`/servers/${editingUser.serverId}/users/${editingUser.userId}`, { method: 'PUT', body: JSON.stringify(body) });
        } else {
            await api(`/servers/${editingUser.serverId}/users`, { method: 'POST', body: JSON.stringify(body) });
        }
        closeModals();
        await loadAll({ silent: true });
    } catch (err) { alert(err.message); }
});

/* ===== Catalog (config) edit modal ===== */
function openCatalogEditModal(item) {
    const f = document.getElementById('catalogEditForm');
    f.dataset.id = item.id;
    f.display_name.value = item.display_name || '';
    f.type.value = item.type || 'free';
    f.status.value = item.status || 'active';
    f.entry_ip.value = item.entry_ip || '';
    f.sni.value = item.sni || '';
    f.config.value = '';
    f.config.placeholder = item.config || 'Trojan config URI (boş = değişmez)';
    openModal('catalogEditModal');
}
document.getElementById('catalogEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
        display_name: f.display_name.value,
        type: f.type.value,
        status: f.status.value,
        entry_ip: f.entry_ip.value || null,
        sni: f.sni.value || null,
    };
    if (f.config.value.trim()) body.config = f.config.value.trim();
    try {
        await api(`/catalog/${f.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
        closeModals();
        await loadAll({ silent: true });
    } catch (err) { alert(err.message); }
});

/* ===== Adopt-config modal (make an imported user manageable) ===== */
let adoptServerId = null;
function openAdoptModal(serverId) {
    adoptServerId = serverId;
    document.getElementById('adoptForm').reset();
    openModal('adoptModal');
}
document.getElementById('adoptForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
        await api(`/servers/${adoptServerId}/users/adopt`, { method: 'POST', body: JSON.stringify(d) });
        closeModals();
        await loadAll({ silent: true });
    } catch (err) { alert(err.message); }
});

/* ===== Config modal ===== */
function openConfigModal() {
    const cs = document.getElementById('configCountry');
    cs.innerHTML = state.countries.map((c) => `<option value="${c.id}">${flagEmoji(c.code)} ${escapeHtml(c.name)}</option>`).join('');
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

/* ===== Server country picker (add/install) ===== */
// Fill a server-modal country <select> with existing countries + an "auto" and a
// "new country" option. Value is the country id, '' = infer from name, '__new__'
// = reveal the name/code inputs.
function populateCountrySelect(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const parts = ['<option value="">🌍 Ülke: otomatik (sunucu adından)</option>'];
    if (state.countries.length) {
        parts.push('<optgroup label="Kullanımdaki ülkeler">');
        parts.push(...state.countries.map((c) => `<option value="id:${c.id}">${flagEmoji(c.code)} ${escapeHtml(c.name)} (${escapeHtml(c.code)})</option>`));
        parts.push('</optgroup>');
    }
    parts.push('<optgroup label="Tüm ülkeler">');
    parts.push(...allCountries().map((c) => `<option value="code:${c.code}">${flagEmoji(c.code)} ${escapeHtml(c.name)} (${escapeHtml(c.code)})</option>`));
    parts.push('</optgroup>');
    parts.push('<option value="__new__">＋ Elle ülke ekle…</option>');
    sel.innerHTML = parts.join('');
    const wrap = document.getElementById(selectId === 'addServerCountry' ? 'addServerNewCountry' : 'installServerNewCountry');
    if (wrap) wrap.style.display = 'none';
}
['addServerCountry', 'installServerCountry'].forEach((selectId) => {
    const sel = document.getElementById(selectId);
    const wrap = document.getElementById(selectId === 'addServerCountry' ? 'addServerNewCountry' : 'installServerNewCountry');
    sel?.addEventListener('change', () => { if (wrap) wrap.style.display = sel.value === '__new__' ? 'grid' : 'none'; });
});
// Normalize a server form into the country fields the API expects: a numeric
// country_id, OR a new country_name(+code), OR nothing (auto-infer).
function serverFormData(form) {
    const d = formData(form);
    // The country <select> value is one of: '' (auto), 'id:<n>' (existing),
    // 'code:<XX>' (pick from the full list), or '__new__' (manual inputs).
    const cv = d.country_id;
    delete d.country_id;
    if (cv === '__new__') {
        if (!d.country_name || !d.country_name.trim()) { delete d.country_name; delete d.country_code; }
    } else if (cv && cv.startsWith('id:')) {
        d.country_id = cv.slice(3);
        delete d.country_name; delete d.country_code;
    } else if (cv && cv.startsWith('code:')) {
        const code = cv.slice(5);
        d.country_code = code;
        d.country_name = countryNameForCode(code);
    } else {
        delete d.country_name; delete d.country_code;
    }
    if (!d.app_id) delete d.app_id;
    // auto_publish / create_defaults are present (value 'true') only when ticked.
    return d;
}

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
    try { await submitForm('/servers', serverFormData(e.target), 'addServerModal'); } catch (err) { alert(err.message); }
});
document.getElementById('installServerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await submitForm('/install', serverFormData(e.target), 'installServerModal'); } catch (err) { alert(err.message); }
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
        else if (action === 'publish-server') { await publishServer(id); }
        else if (action === 'pick-app') {
            const resolve = pendingAppPick; pendingAppPick = null;
            document.getElementById('appPickerModal').classList.remove('open');
            if (resolve) resolve(id);
        }
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
        else if (action === 'sync-users') { target.disabled = true; await api(`/servers/${id}/users/sync-defaults`, { method: 'POST', body: JSON.stringify({ remote: true }) }); await loadAll({ silent: true }); }
        else if (action === 'sync-users-now') { target.disabled = true; const r = await api(`/servers/${id}/users/sync`, { method: 'POST' }); await loadAll({ silent: true }); if (r && r.error) alert(`Senkronizasyon uyarısı: ${r.error}`); }
        else if (action === 'add-user') { openUserModal(id, null); }
        else if (action === 'edit-user') { const u = state.users.find((x) => x.id === id); if (u) openUserModal(Number(target.dataset.server), u); }
        else if (action === 'toggle-user') {
            const serverId = Number(target.dataset.server);
            const enabled = target.dataset.enabled === '1';
            await api(`/servers/${serverId}/users/${id}`, { method: 'PUT', body: JSON.stringify({ enabled: !enabled }) });
            await loadAll({ silent: true });
        }
        else if (action === 'delete-user') {
            const msg = target.dataset.imported
                ? 'Bu kullanıcı içe aktarılmış — sadece panelden kaldırılır, sunucudaki gerçek kullanıcıya dokunulmaz. Devam?'
                : 'Kullanıcıyı sil? Bu kullanıcı sunucudan ve katalogdan kaldırılacak.';
            if (!confirm(msg)) return;
            await api(`/servers/${Number(target.dataset.server)}/users/${id}`, { method: 'DELETE' });
            await loadAll({ silent: true });
        }
        else if (action === 'import-users') { target.disabled = true; const r = await api(`/servers/${id}/import-users`, { method: 'POST' }); await loadAll({ silent: true }); alert(`${r.imported || 0} yeni kullanıcı içe aktarıldı (${r.total || 0} canlı kullanıcı).`); }
        else if (action === 'adopt-user') { openAdoptModal(Number(target.dataset.server)); }
        else if (action === 'edit-catalog') { const it = state.catalog.find((c) => c.id === id); if (it) openCatalogEditModal(it); }
        else if (action === 'copy-config') {
            const cfg = target.dataset.config || '';
            if (!cfg) { alert('Config yok'); return; }
            try { await navigator.clipboard.writeText(cfg); target.innerHTML = '<i class="ri-check-line"></i>'; setTimeout(() => { target.innerHTML = '<i class="ri-file-copy-line"></i>'; }, 1200); }
            catch (_) { prompt('Config (kopyalayın):', cfg); }
        }
        else if (action === 'toggle-catalog') {
            const item = state.catalog.find((c) => c.id === id);
            await api(`/catalog/${id}`, { method: 'PUT', body: JSON.stringify({ status: item.status === 'active' ? 'draft' : 'active' }) });
            await loadAll({ silent: true });
        }
        else if (action === 'delete-catalog') { if (confirm('Config\'i sil?')) { await api(`/catalog/${id}`, { method: 'DELETE' }); await loadAll({ silent: true }); } }
        else if (action === 'test-config') {
            target.disabled = true; target.innerHTML = '<i class="ri-loader-4-line"></i>';
            try { const r = await api(`/catalog/${id}/test`, { method: 'POST' }); await loadAll({ silent: true });
                alert(r.result && r.result.ok ? `Config çalışıyor ✅  (${r.result.latencyMs} ms)` : `Config başarısız ❌\n${(r.result && r.result.error) || ''}`);
            } catch (e) { alert(e.message); await loadAll({ silent: true }); }
        }
        else if (action === 'test-all-configs') { target.disabled = true; await api('/configs/test-all', { method: 'POST' }); alert('Tüm configler test ediliyor — birkaç dakika sürebilir, sonuçlar otomatik güncellenir.'); setTimeout(() => loadAll({ silent: true }), 4000); }
        else if (action === 'delete-country') {
            const c = state.countries.find((x) => x.id === id);
            const configs = state.catalog.filter((i) => i.country_id === id).length;
            const servers = state.servers.filter((s) => s.country_id === id).length;
            if (configs > 0 || servers > 0) { alert(`Bu ülkede ${servers} sunucu, ${configs} config var. Önce onları silin/taşıyın.`); return; }
            if (!confirm(`"${c ? c.name : 'Ülke'}" silinsin mi?`)) return;
            await api(`/countries/${id}`, { method: 'DELETE' });
            await loadAll({ silent: true });
        }
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

function activePage() {
    const el = document.querySelector('.page.active');
    return el ? el.id.replace('page-', '') : 'overview';
}

loadAll();
loadOverview();
setInterval(() => {
    loadAll({ silent: true });
    if (activePage() === 'overview') loadOverview();
}, 15000);
