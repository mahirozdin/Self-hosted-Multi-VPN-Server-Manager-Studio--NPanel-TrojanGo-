const tcpPing = require('tcp-ping');
const { URL } = require('url');

const config = "trojan://PASSWORD@YOUR_DOMAIN:443?security=tls&type=ws&path=/fetch#SERVER_NAME";

function parseTrojanConfig(config) {
    if (!config) return null;
    try {
        if (config.trim().startsWith('trojan://')) {
            const url = new URL(config.trim());
            return { host: url.hostname, port: parseInt(url.port) || 443 };
        }
        const hostMatch = config.match(/"remote_addr"\s*:\s*"([^"]+)"/);
        const portMatch = config.match(/"remote_port"\s*:\s*(\d+)/);
        
        if (hostMatch && portMatch) {
            return { host: hostMatch[1], port: parseInt(portMatch[1]) };
        }
    } catch (e) {
        console.error('Error parsing trojan config', e);
    }
    return null;
}

const parsed = parseTrojanConfig(config);
console.log('Parsed:', parsed);

if (parsed) {
    console.log(`Pinging ${parsed.host}:${parsed.port}...`);
    tcpPing.ping({ address: parsed.host, port: parsed.port, attempts: 3, timeout: 5000 }, (err, data) => {
        if (err) console.error('Ping Error:', err);
        else console.log('Ping Result:', data);
    });
} else {
    console.error('Failed to parse');
}
