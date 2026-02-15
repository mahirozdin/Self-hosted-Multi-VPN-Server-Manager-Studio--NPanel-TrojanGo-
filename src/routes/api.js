const express = require('express');
const router = express.Router();
const { Server } = require('../models/Database');
const sshService = require('../services/sshService');

// Auth Middleware (Local scope or import, for now relying on server.js global middleware if applied globally, or re-implementing/importing here)
// Actually, server.js doesn't apply it globally to /api yet.
// Let's assume the router is mounted under /api and we want protection.

const monitorService = require('../services/monitorService');

// Get all servers
router.get('/servers', async (req, res) => {
    try {
        const servers = await Server.findAll();
        res.json(servers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add existing server
router.post('/servers', async (req, res) => {
    try {
        const { name, ip, port, vpn_port, username, password, domain, trojan_config } = req.body;
        const server = await Server.create({
            name, ip, port, vpn_port: vpn_port || 443, username, password, domain, trojan_config, status: 'online' 
        });
        
        // Trigger immediate check
        monitorService.updateServerStatus(server); // don't await to return fast
        
        res.status(201).json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update server
router.put('/servers/:id', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        const { name, ip, port, vpn_port, username, password, domain, trojan_config } = req.body;
        
        await server.update({
            name, ip, port, vpn_port, username, password, domain, trojan_config
        });
        
        // Trigger immediate check
        monitorService.updateServerStatus(server); // don't await
        
        res.json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete server
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

// Refresh server status
router.post('/servers/:id/refresh', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        
        await monitorService.updateServerStatus(server);
        res.json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Install new server
router.post('/install', async (req, res) => {
    try {
        const { name, ip, port, vpn_port, username, password, domain, adminUser, adminPass } = req.body;
        
        // create record first
        const server = await Server.create({
            name, ip, port, vpn_port: vpn_port || 443, username, password, domain, admin_user: adminUser, admin_pass: adminPass, status: 'installing'
        });

        // Trigger async installation (don't await)
        sshService.installNpanel({ ip, port, username, password }, { domain, adminUser, adminPass, mainPort: vpn_port || 443 })
            .then(() => {
                server.update({ status: 'online', last_ssl_renew: new Date() });
                console.log(`Installation successful for ${ip}`);
            })
            .catch((err) => {
                server.update({ status: 'error' });
                console.error(`Installation failed for ${ip}:`, err);
            });

        res.json({ message: 'Installation started', serverId: server.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Renew SSL
router.post('/servers/:id/renew-ssl', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        server.update({ status: 'renewing_ssl' });
        
        // Trigger async
        sshService.renewSSL({ ip: server.ip, port: server.port, username: server.username, password: server.password, domain: server.domain })
            .then(() => {
                server.update({ 
                    status: 'online', 
                    last_ssl_renew: new Date(),
                    // Approximate next expiry (Let's say 90 days for Let's Encrypt)
                    ssl_expiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
                });
            })
            .catch(err => {
                server.update({ status: 'error' });
                console.error('SSL Renewal failed:', err);
            });

        res.json({ message: 'SSL Renewal started' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reboot Server
router.post('/servers/:id/reboot', async (req, res) => {
    try {
        const server = await Server.findByPk(req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        // Trigger async
        sshService.rebootServer({ ip: server.ip, port: server.port, username: server.username, password: server.password })
            .catch(err => console.error('Reboot command error (or connection drop):', err));

        res.json({ message: 'Reboot command sent' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Refresh All Servers
router.post('/servers/refresh-all', async (req, res) => {
    try {
        // Trigger async, don't wait for individual checks
        monitorService.updateAllServers();
        res.json({ message: 'Refresh all started' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Login (Simple check against env)
router.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        res.json({ success: true, token: password }); // Simple token
    } else {
        res.status(401).json({ success: false });
    }
});

module.exports = router;
