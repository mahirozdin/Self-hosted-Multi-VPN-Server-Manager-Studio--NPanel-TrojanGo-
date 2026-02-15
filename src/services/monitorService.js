const tcpPing = require('tcp-ping');
const { Server } = require('../models/Database');
const cron = require('node-cron');
const { Client } = require('ssh2');
const { URL } = require('url');

class MonitorService {
    constructor() {
        this.startCron();
    }

    // Checks Latency to the VPN Port (usually 443)
    checkVpnLatency(server) {
        return new Promise((resolve) => {
            const port = server.vpn_port || 443;
            tcpPing.ping({ address: server.ip, port: port, attempts: 3, timeout: 2000 }, (err, data) => {
                if (err || isNaN(data.avg)) {
                    resolve({ status: 'error', latency: null });
                } else {
                    resolve({ status: 'online', latency: Math.round(data.avg) });
                }
            });
        });
    }

    checkSSH(server) {
        return new Promise((resolve) => {
            const conn = new Client();
            let resolved = false;

            const done = (status, err) => {
                if (resolved) return;
                resolved = true;
                conn.end();
                if (err) console.error(`SSH Check failed for ${server.ip}:`, err.message);
                resolve(status);
            };

            conn.on('ready', () => {
                done('ok');
            });
            
            conn.on('error', (err) => {
                done('error', err);
            });

            conn.on('timeout', () => {
                done('error', new Error('Connection timed out'));
            });

            try {
                conn.connect({
                    host: server.ip,
                    port: server.port || 22,
                    username: server.username || 'root',
                    password: server.password,
                    readyTimeout: 10000, 
                    keepaliveInterval: 0,
                });
            } catch (err) {
                 done('error', err);
            }
        });
    }

    parseTrojanConfig(config) {
        if (!config) return null;
        const cleanConfig = config.trim();
        try {
            // Try URL
            if (cleanConfig.startsWith('trojan://')) {
                const url = new URL(cleanConfig);
                return { host: url.hostname, port: parseInt(url.port) || 443 };
            }
            // Try JSON attempt (flexible)
            // Just loose regex for host/port if JSON fails or if it's Client config
            // Simple fallback: look for "remote_addr": "..."
            const hostMatch = cleanConfig.match(/"remote_addr"\s*:\s*"([^"]+)"/);
            const portMatch = cleanConfig.match(/"remote_port"\s*:\s*(\d+)/);
            
            if (hostMatch && portMatch) {
                return { host: hostMatch[1], port: parseInt(portMatch[1]) };
            }
        } catch (e) {
            console.error('Error parsing trojan config', e);
        }
        return null; // Signals rewrite needed or invalid
    }

    checkTrojan(server) {
        return new Promise((resolve) => {
            if (!server.trojan_config) {
                resolve({ latency: null, error: null });
                return;
            }

            const parsed = this.parseTrojanConfig(server.trojan_config);
            if (!parsed) {
                resolve({ latency: -1, error: 'Invalid config format' }); 
                return;
            }

            tcpPing.ping({ address: parsed.host, port: parsed.port, attempts: 3, timeout: 2000 }, (err, data) => {
                 if (err) {
                    resolve({ latency: -1, error: err.message });
                 } else if (isNaN(data.avg)) {
                    // Check if 100% packet loss
                    resolve({ latency: -1, error: 'Timeout/Packet Loss' });
                 } else {
                    resolve({ latency: Math.round(data.avg), error: null });
                 }
            });
        });
    }

    async updateServerStatus(server) {
        try {
             // Check VPN Latency
            const vpnResult = await this.checkVpnLatency(server);
            
            // Check SSH Status
            let sshStatus = await this.checkSSH(server);

            // Check Trojan Status
            let trojanResult = await this.checkTrojan(server);

            // Update DB
            await server.update({ 
                latency: vpnResult.latency, 
                status: vpnResult.status, 
                ssh_status: sshStatus,
                trojan_latency: trojanResult.latency,
                trojan_last_error: trojanResult.error
            });
            console.log(`Updated status for ${server.name}: VPN=${vpnResult.status}, SSH=${sshStatus}, Trojan=${trojanResult.latency}ms`);
            return server;
        } catch (e) {
            console.error(`Error updating status for ${server.ip}:`, e);
        }
    }

    async updateAllServers() {
        const servers = await Server.findAll();
        for (const server of servers) {
            await this.updateServerStatus(server);
        }
        console.log(`Updated status for ${servers.length} servers.`);
    }

    startCron() {
        // Run every 5 minutes
        cron.schedule('*/5 * * * *', () => {
            this.updateAllServers();
        });
    }
}

module.exports = new MonitorService();
