const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const router = express.Router();
const {
    App,
    AppCatalogItem,
    Server,
    ProvisionJob,
    ProvisionStep,
    NpanelUser,
    Country,
    ServerGroup,
    VpnCatalogItem,
    ApiDevice,
    BanRule,
} = require('../models/Database');
const sshService = require('../services/sshService');
const monitorService = require('../services/monitorService');
const provisionService = require('../services/provisionService');
const {
    adminAuthMiddleware,
    createAdminToken,
} = require('../services/authService');
const {
    createChallenge,
    exchangeToken,
    refreshToken,
    mobileAuthMiddleware,
    mobileRateLimitMiddleware,
    audit,
} = require('../services/mobileSecurityService');
const {
    ensureCountryAndGroupForServer,
    ensureDefaultCatalog,
    serializeUser,
    syncDefaultUsers,
} = require('../services/npanelUserService');
const {
    resolveAppMiddleware,
    generateAppCredentials,
} = require('../services/tenantService');
const { serializeConfig } = require('../services/catalogSerializer');
const connectionLogService = require('../services/connectionLogService');
const banService = require('../services/banService');
const { getClientIp, cloudflareGuardMiddleware } = require('./../services/clientIpService');

function sanitizeServer(server) {
    const row = server.toJSON ? server.toJSON() : { ...server };
    delete row.password;
    delete row.admin_pass;
    return row;
}

function sanitizeServers(servers) {
    return servers.map(sanitizeServer);
}

function getIo(req) {
    return req.app.get('io');
}

// Constant-time string comparison that does not leak length via early return.
function timingSafeEqualStr(a, b) {
    const ab = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    // Hash both to a fixed length so timingSafeEqual never throws on length
    // mismatch and the comparison time is independent of input length.
    const ah = crypto.createHash('sha256').update(ab).digest();
    const bh = crypto.createHash('sha256').update(bb).digest();
    return crypto.timingSafeEqual(ah, bh);
}

function checkAdminPassword(password) {
    if (process.env.ADMIN_PASSWORD_HASH) {
        return bcrypt.compareSync(String(password || ''), process.env.ADMIN_PASSWORD_HASH);
    }
    if (!process.env.ADMIN_PASSWORD) return false;
    return timingSafeEqualStr(password, process.env.ADMIN_PASSWORD);
}

// Simple in-memory brute-force guard on /login: max attempts per client IP per
// window. Process-local (resets on restart) — adequate for a single-node panel.
const LOGIN_RATE_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_MAX = 10;
const loginAttempts = new Map();

function loginRateLimited(ip) {
    const now = Date.now();
    const bucket = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_RATE_WINDOW_MS };
    if (bucket.resetAt < now) {
        bucket.count = 0;
        bucket.resetAt = now + LOGIN_RATE_WINDOW_MS;
    }
    bucket.count += 1;
    loginAttempts.set(ip, bucket);
    return bucket.count > LOGIN_RATE_MAX;
}

router.post('/login', (req, res) => {
    const ip = getClientIp(req);
    if (loginRateLimited(ip)) {
        return res.status(429).json({ success: false, error: 'Too many attempts' });
    }
    const { password } = req.body;
    if (checkAdminPassword(password)) {
        res.json({ success: true, token: createAdminToken() });
    } else {
        res.status(401).json({ success: false });
    }
});

// When CF_ENFORCE=true, reject /v1 traffic whose immediate peer isn't a
// Cloudflare edge (no-op when disabled). Runs before tenant resolution.
router.use('/v1', cloudflareGuardMiddleware);
// Resolve the tenant (X-App-Key) for every /v1 request before rate limit / auth.
router.use('/v1', resolveAppMiddleware);
// Block banned IPs / device ids early (firebase_uid bans enforced post-auth).
router.use('/v1', banService.banGuardMiddleware);

router.post('/v1/auth/challenge', mobileRateLimitMiddleware, async (req, res) => {
    try {
        const challenge = await createChallenge({ ...req.body, app: req.app_tenant });
        await audit(req, 200, 'challenge_issued');
        res.json(challenge);
    } catch (error) {
        await audit(req, error.status || 500, error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

router.post('/v1/auth/token', mobileRateLimitMiddleware, async (req, res) => {
    try {
        const token = await exchangeToken({ ...req.body, app: req.app_tenant });
        await audit(req, 200, 'token_issued');
        res.json(token);
    } catch (error) {
        await audit(req, error.status || 500, error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

router.post('/v1/auth/refresh', mobileRateLimitMiddleware, async (req, res) => {
    try {
        const token = await refreshToken({ ...req.body, app: req.app_tenant });
        await audit(req, 200, 'token_refreshed');
        res.json(token);
    } catch (error) {
        await audit(req, error.status || 500, error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

// Only catalog items exposed to this tenant (active AppCatalogItem assignment).
function tenantCatalogInclude(req) {
    return {
        model: App,
        as: 'apps',
        attributes: [],
        through: { attributes: [], where: { status: 'active' } },
        where: { id: req.app_tenant.id },
        required: true,
    };
}

router.get('/v1/countries', mobileRateLimitMiddleware, mobileAuthMiddleware, async (req, res) => {
    const items = await VpnCatalogItem.findAll({
        where: { status: 'active' },
        attributes: ['country_id'],
        include: [tenantCatalogInclude(req)],
    });
    const countryIds = [...new Set(items.map((i) => i.country_id))];
    const countries = await Country.findAll({
        where: { id: countryIds },
        order: [['sort_order', 'ASC'], ['name', 'ASC']],
    });
    await audit(req, 200, 'countries');
    res.json({
        countries: countries.map((c) => ({ name: c.name, code: c.code, flag: c.flag })),
    });
});

router.get('/v1/configs', mobileRateLimitMiddleware, mobileAuthMiddleware, async (req, res) => {
    const where = { status: 'active' };
    if (req.query.type) where.type = req.query.type;
    const items = await VpnCatalogItem.findAll({
        where,
        include: [
            { model: Country, as: 'country' },
            { model: Server, as: 'server' },
            tenantCatalogInclude(req),
        ],
        order: [['sort_order', 'ASC'], ['display_name', 'ASC']],
    });
    await audit(req, 200, 'configs');
    res.json({ configs: items.map(serializeConfig) });
});

router.post('/v1/sessions/start', mobileRateLimitMiddleware, mobileAuthMiddleware, async (req, res) => {
    try {
        const log = await connectionLogService.startLog(req, req.body || {});
        await audit(req, 201, 'session_start');
        res.status(201).json({ logId: log.log_token, startedAt: log.connect_at });
    } catch (error) {
        await audit(req, error.status || 500, error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

router.post('/v1/sessions/stop', mobileRateLimitMiddleware, mobileAuthMiddleware, async (req, res) => {
    try {
        const log = await connectionLogService.stopLog(req, req.body || {});
        await audit(req, 200, 'session_stop');
        res.json({ ok: true, durationSeconds: log.duration_seconds });
    } catch (error) {
        await audit(req, error.status || 500, error.message);
        res.status(error.status || 500).json({ error: error.message });
    }
});

router.use(adminAuthMiddleware);

router.get('/servers', async (req, res) => {
    try {
        const servers = await Server.findAll();
        res.json(sanitizeServers(servers));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/servers', async (req, res) => {
    try {
        const { name, ip, port, vpn_port, username, password, domain, trojan_config, country_id, country_name, country_code } = req.body;
        const server = await Server.create({
            name,
            ip,
            port: port || 22,
            vpn_port: vpn_port || 443,
            username: username || 'root',
            password,
            domain,
            trojan_config,
            status: 'online',
        });

        const { country, group } = await ensureCountryAndGroupForServer(server, {
            countryId: country_id ? Number(country_id) : null,
            countryName: country_name,
            countryCode: country_code,
        });
        const users = await syncDefaultUsers(server, { remote: false });
        await ensureDefaultCatalog(server, users, country.id, group.id);
        monitorService.updateServerStatus(server);

        res.status(201).json(sanitizeServer(server));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/servers/:id', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        const { name, ip, port, vpn_port, username, password, domain, trojan_config } = req.body;
        const updates = {
            name,
            ip,
            port,
            vpn_port,
            username,
            domain,
            trojan_config,
        };
        if (password) updates.password = password;

        await server.update(updates);
        monitorService.updateServerStatus(server);

        res.json(sanitizeServer(server));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/servers/:id', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        await server.destroy();
        res.json({ message: 'Server deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/servers/:id/refresh', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        await monitorService.updateServerStatus(server);
        res.json(sanitizeServer(server));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/install', async (req, res) => {
    try {
        const { name, ip, port, vpn_port, username, password, domain, adminUser, adminPass, country_id, country_name, country_code } = req.body;
        const server = await Server.create({
            name,
            ip,
            port: port || 22,
            vpn_port: vpn_port || 443,
            username: username || 'root',
            password,
            domain,
            admin_user: adminUser || 'Admin',
            admin_pass: adminPass || 'ChangeMe123!',
            status: 'installing',
        });

        const job = await provisionService.createJob(server.id);
        provisionService.runInstall(
            server.id,
            { ip, port: port || 22, username: username || 'root', password },
            {
                job,
                domain,
                adminUser: adminUser || 'Admin',
                adminPass: adminPass || 'ChangeMe123!',
                mainPort: vpn_port || 443,
                country: {
                    countryId: country_id ? Number(country_id) : null,
                    countryName: country_name,
                    countryCode: country_code,
                },
            },
            getIo(req),
        ).catch((err) => {
            console.error(`Installation failed for ${ip}:`, err);
        });

        res.json({ message: 'Installation started', serverId: server.id, jobId: job.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/servers/:id/renew-ssl', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        server.update({ status: 'renewing_ssl' });
        sshService.renewSSL({
            ip: server.ip,
            port: server.port,
            username: server.username,
            password: server.password,
            domain: server.domain,
        })
            .then(() => server.update({
                status: 'online',
                last_ssl_renew: new Date(),
                ssl_expiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            }))
            .catch((err) => {
                server.update({ status: 'error' });
                console.error('SSL Renewal failed:', err);
            });

        res.json({ message: 'SSL Renewal started' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/servers/:id/reboot', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        sshService.rebootServer({
            ip: server.ip,
            port: server.port,
            username: server.username,
            password: server.password,
        }).catch((err) => console.error('Reboot command error (or connection drop):', err));

        res.json({ message: 'Reboot command sent' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/servers/refresh-all', async (req, res) => {
    try {
        monitorService.updateAllServers();
        res.json({ message: 'Refresh all started' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/servers/:id/users', async (req, res) => {
    try {
        const users = await NpanelUser.findAll({ where: { server_id: req.params.id }, order: [['name', 'ASC']] });
        res.json(users.map(serializeUser));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/servers/:id/users/sync-defaults', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        const users = await syncDefaultUsers(server, { remote: req.body?.remote !== false });
        const { country, group } = await ensureCountryAndGroupForServer(server);
        await ensureDefaultCatalog(server, users, country.id, group.id);
        res.json({ users: users.map(serializeUser) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/provision-jobs', async (req, res) => {
    const jobs = await ProvisionJob.findAll({
        include: [
            { model: Server, as: 'server' },
            { model: ProvisionStep, as: 'steps' },
        ],
        order: [['createdAt', 'DESC']],
        limit: 25,
    });
    res.json(jobs.map((job) => provisionService.sanitizeJob(job)));
});

router.get('/provision-jobs/:id', async (req, res) => {
    const job = await provisionService.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Provision job not found' });
    res.json(provisionService.sanitizeJob(job));
});

router.get('/management-tree', async (req, res) => {
    try {
        const [countries, groups, servers, users, catalog] = await Promise.all([
            Country.findAll({ order: [['sort_order', 'ASC'], ['name', 'ASC']] }),
            ServerGroup.findAll({ order: [['sort_order', 'ASC'], ['name', 'ASC']] }),
            Server.findAll({ order: [['name', 'ASC']] }),
            NpanelUser.findAll({ order: [['name', 'ASC']] }),
            VpnCatalogItem.findAll({ order: [['sort_order', 'ASC'], ['display_name', 'ASC']] }),
        ]);

        res.json({
            countries,
            groups,
            servers: sanitizeServers(servers),
            users: users.map(serializeUser),
            catalog,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/countries', async (req, res) => {
    try {
        const country = await Country.create({
            name: req.body.name,
            code: req.body.code || 'XX',
            flag: req.body.flag || req.body.code || 'XX',
            sort_order: req.body.sort_order || 0,
        });
        res.status(201).json(country);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/countries/:id', async (req, res) => {
    const country = await Country.findByPk(req.params.id);
    if (!country) return res.status(404).json({ error: 'Country not found' });
    await country.update(req.body);
    res.json(country);
});

router.post('/groups', async (req, res) => {
    try {
        const group = await ServerGroup.create({
            country_id: req.body.country_id,
            parent_id: req.body.parent_id || null,
            name: req.body.name,
            kind: req.body.kind || (req.body.parent_id ? 'sub' : 'main'),
            sort_order: req.body.sort_order || 0,
        });
        res.status(201).json(group);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/groups/:id', async (req, res) => {
    const group = await ServerGroup.findByPk(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await group.update(req.body);
    res.json(group);
});

router.post('/catalog/assign', async (req, res) => {
    try {
        const user = await NpanelUser.findByPk(req.body.npanel_user_id);
        if (!user) return res.status(404).json({ error: 'NPanel user not found' });

        const [item] = await VpnCatalogItem.findOrCreate({
            where: {
                server_id: req.body.server_id,
                npanel_user_id: req.body.npanel_user_id,
                type: req.body.type || user.profile_type,
            },
            defaults: {
                country_id: req.body.country_id,
                group_id: req.body.group_id || null,
                server_id: req.body.server_id,
                npanel_user_id: req.body.npanel_user_id,
                type: req.body.type || user.profile_type,
                display_name: req.body.display_name || user.name,
                config: req.body.config || user.config_ws,
                status: req.body.status || 'active',
            },
        });

        await item.update({
            country_id: req.body.country_id,
            group_id: req.body.group_id || null,
            display_name: req.body.display_name || item.display_name,
            config: req.body.config || user.config_ws,
            status: req.body.status || item.status,
        });

        res.json(item);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/catalog/:id', async (req, res) => {
    const item = await VpnCatalogItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: 'Catalog item not found' });
    await item.update(req.body);
    res.json(item);
});

router.delete('/catalog/:id', async (req, res) => {
    const item = await VpnCatalogItem.findByPk(req.params.id);
    if (!item) return res.status(404).json({ error: 'Catalog item not found' });
    await item.destroy();
    res.json({ message: 'Catalog item deleted' });
});

// ---- Apps (tenants) ----
function sanitizeApp(app) {
    const row = app.toJSON ? app.toJSON() : { ...app };
    delete row.hmac_secret;
    return row;
}

const APP_EDITABLE_FIELDS = [
    'name', 'slug', 'status', 'ios_bundle_id', 'apple_team_id', 'apple_attest_env',
    'android_package_name', 'google_cloud_project_number', 'android_min_device_verdict',
    'play_integrity_sa_ref', 'min_supported_version',
];

router.get('/apps', async (req, res) => {
    const apps = await App.findAll({ order: [['name', 'ASC']] });
    res.json(apps.map(sanitizeApp));
});

router.post('/apps', async (req, res) => {
    try {
        const { appKey, hmacSecret } = generateAppCredentials();
        const app = await App.create({
            name: req.body.name,
            slug: req.body.slug,
            status: req.body.status || 'active',
            app_key: appKey,
            hmac_secret: hmacSecret,
            ios_bundle_id: req.body.ios_bundle_id || null,
            apple_team_id: req.body.apple_team_id || null,
            apple_attest_env: req.body.apple_attest_env || 'production',
            android_package_name: req.body.android_package_name || null,
            google_cloud_project_number: req.body.google_cloud_project_number || null,
            android_min_device_verdict: req.body.android_min_device_verdict || 'MEETS_DEVICE_INTEGRITY',
            play_integrity_sa_ref: req.body.play_integrity_sa_ref || null,
            min_supported_version: req.body.min_supported_version || null,
        });
        // Return the signing secret in plaintext exactly once (never again).
        res.status(201).json({ ...sanitizeApp(app), app_key: appKey, hmac_secret: hmacSecret });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/apps/:id', async (req, res) => {
    const app = await App.findByPk(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    const updates = {};
    for (const key of APP_EDITABLE_FIELDS) {
        if (key in req.body) updates[key] = req.body[key];
    }
    await app.update(updates);
    res.json(sanitizeApp(app));
});

router.delete('/apps/:id', async (req, res) => {
    const app = await App.findByPk(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    await app.destroy();
    res.json({ message: 'App deleted' });
});

router.post('/apps/:id/rotate-key', async (req, res) => {
    const app = await App.findByPk(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    const { appKey, hmacSecret } = generateAppCredentials();
    await app.update({ app_key: appKey, hmac_secret: hmacSecret });
    res.json({ app_key: appKey, hmac_secret: hmacSecret });
});

router.get('/apps/:id/catalog', async (req, res) => {
    const items = await AppCatalogItem.findAll({
        where: { app_id: req.params.id },
        order: [['sort_order', 'ASC']],
    });
    res.json(items);
});

router.post('/apps/:id/catalog', async (req, res) => {
    try {
        const [item] = await AppCatalogItem.findOrCreate({
            where: { app_id: req.params.id, catalog_item_id: req.body.catalog_item_id },
            defaults: {
                app_id: req.params.id,
                catalog_item_id: req.body.catalog_item_id,
                status: req.body.status || 'active',
                sort_order: req.body.sort_order || 0,
                display_name_override: req.body.display_name_override || null,
            },
        });
        await item.update({
            status: req.body.status || item.status,
            sort_order: req.body.sort_order != null ? req.body.sort_order : item.sort_order,
            display_name_override: req.body.display_name_override !== undefined
                ? req.body.display_name_override
                : item.display_name_override,
        });
        res.json(item);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/apps/:id/catalog/:itemId', async (req, res) => {
    const item = await AppCatalogItem.findOne({
        where: { app_id: req.params.id, catalog_item_id: req.params.itemId },
    });
    if (!item) return res.status(404).json({ error: 'Catalog assignment not found' });
    await item.destroy();
    res.json({ message: 'Catalog assignment removed' });
});

// ---- Connection logs (legal record search) ----
router.get('/connection-logs', async (req, res) => {
    try {
        const result = await connectionLogService.searchLogs(req.query);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---- Registered devices/users ----
router.get('/devices', async (req, res) => {
    try {
        const where = {};
        if (req.query.appId) where.app_id = req.query.appId;
        if (req.query.q) {
            where[Op.or] = [
                { device_id: { [Op.like]: `%${req.query.q}%` } },
                { firebase_uid: { [Op.like]: `%${req.query.q}%` } },
            ];
        }
        const limit = Math.min(Number(req.query.pageSize) || 100, 100);
        const page = Math.max(Number(req.query.page) || 1, 1);
        const { rows, count } = await ApiDevice.findAndCountAll({
            where,
            attributes: ['id', 'app_id', 'device_id', 'firebase_uid', 'platform', 'status', 'is_premium', 'last_seen_at', 'createdAt'],
            order: [['last_seen_at', 'DESC']],
            limit,
            offset: (page - 1) * limit,
        });
        res.json({ total: count, page, pageSize: limit, devices: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ---- Bans (IP / device_id / firebase_uid) ----
router.get('/bans', async (req, res) => {
    try {
        const where = {};
        if (req.query.type) where.type = req.query.type;
        if (req.query.q) where.value = { [Op.like]: `%${req.query.q}%` };
        const limit = Math.min(Number(req.query.pageSize) || 100, 100);
        const page = Math.max(Number(req.query.page) || 1, 1);
        const { rows, count } = await BanRule.findAndCountAll({ where, order: [['createdAt', 'DESC']], limit, offset: (page - 1) * limit });
        res.json({ total: count, page, pageSize: limit, bans: rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/bans', async (req, res) => {
    try {
        const { type, value, reason, app_id } = req.body;
        if (!['ip', 'device_id', 'firebase_uid'].includes(type) || !value) {
            return res.status(400).json({ error: 'type (ip|device_id|firebase_uid) and value required' });
        }
        const [ban] = await BanRule.findOrCreate({
            where: { type, value, app_id: app_id || null },
            defaults: { type, value, reason: reason || null, app_id: app_id || null },
        });
        if (reason && ban.reason !== reason) await ban.update({ reason });
        banService.invalidate();
        res.status(201).json(ban);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/bans/:id', async (req, res) => {
    const ban = await BanRule.findByPk(req.params.id);
    if (!ban) return res.status(404).json({ error: 'Ban not found' });
    await ban.destroy();
    banService.invalidate();
    res.json({ message: 'Ban removed' });
});

module.exports = router;
