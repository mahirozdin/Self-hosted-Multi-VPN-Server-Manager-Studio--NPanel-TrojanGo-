# 🚀 NPanel TrojanGo Manager Studio

**Self-Hosted Automated VPN Server Provisioning, SSH Management, and Real-time Monitoring Dashboard**

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)
![VPN](https://img.shields.io/badge/VPN-Trojan--Go-blueviolet)

---

## 📸 Dashboard Preview

![NPanel Manager Studio Dashboard](demo.png)

---

## 🔍 Keywords & Tags
`Npanel` `VPN Manager` `Trojan-Go` `V2Ray` `Shadowsocks` `Auto-provisioning` `VPS Management` `SSH Terminal` `SSL Automation` `Certbot` `Ubuntu Server` `VPN Dashboard` `Proxy Manager`

---

## 📖 What is NPanel Manager Studio?

**NPanel Manager Studio** is a powerful web-based control center designed to simplify the lifecycle of your VPN servers. It acts as a management layer on top of the robust [Npanel core by Leiren](https://github.com/Leiren/Npanel), allowing you to transform a raw Ubuntu VPS into a fully functional, TLS-secured Trojan-Go VPN server in minutes—without touching the command line. And your data is safe with self-hosting.

Whether you are managing a single personal server or a fleet of global nodes, this studio provides the tools you need to install, monitor, and maintain your infrastructure securely.

### 🌟 Key Features

- **⚡ Automated One-Click Installation**: Pass your SSH credentials and domain, and the studio will handle the entire Npanel setup, including dependencies and firewall rules.
- **🖥️ Integrated Web SSH Terminal**: Access your server's console directly from the dashboard using `xterm.js` and `socket.io` for instant troubleshooting.
- **📊 Real-time Performance Monitoring**: Track VPN latency, SSH connectivity status, and service health at a glance.
- **🛡️ Auto-SSL (Let's Encrypt)**: Built-in integration with Certbot for automated TLS certificate issuance and one-click renewals.
- **🔄 Bulk Operations**: Multi-select servers to perform bulk reboots or status refreshes, saving you time.
- **🔥 Trojan-Go Monitoring**: Track specific Trojan instances by pasting your connection configs to monitor latency and last-seen errors.
- **📱 Responsive DataGrid**: A sleek, searchable, and sortable table layout designed for both desktop and tablet management.

---

## 🛠 Prerequisites

- **Host Machine**: Node.js v16+ and npm installed.
- **Target Servers**: Fresh Ubuntu VPS (20.04/22.04 recommended).
- **Domain**: A domain/subdomain pointed (A Record) to your target VPS IP for SSL/TLS.

---

## 🚀 Installation & Setup

### 1. Clone & Install
```bash
git clone https://github.com/mahirozdin/Self-hosted-Multi-VPN-Server-Manager-Studio--NPanel-TrojanGo-.git
cd Self-hosted-Multi-VPN-Server-Manager-Studio--NPanel-TrojanGo-
npm install
```

### 2. Configuration
Copy the example environment file:
```bash
cp .env.example .env
```
Edit `.env` and set your secure dashboard password:
```env
ADMIN_PASSWORD=your_secure_password
PORT=3000
```

### 3. Launch
```bash
npm start
```
Default dashboard address: `http://localhost:3000`

---

## 🎯 Post-Installation Steps

After successfully installing Npanel via this manager, please follow these security and configuration steps:

1. **Change Panel Password**: Navigate to the Npanel web address (usually `https://yourdomain/Admin/`) on the target server and change the default `ChangeMe123!`.
2. **User Management**: Log into the Npanel core dashboard to create your VPN users and generate Trojan configurations.
3. **Monitoring**: Copy your generated Trojan URL/JSON and paste it into the "Edit" section of this Manager Studio to track that specific connection's health.

---

## 🤝 Contributing & Support

We welcome contributions! This project is built for the community and we encourage you to get involved.

### How to Contribute
1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/AmazingFeature`)
3. **Commit** your changes (`git commit -m 'Add some AmazingFeature'`)
4. **Push** to the branch (`git push origin feature/AmazingFeature`)
5. **Open** a Pull Request

### Reporting Issues
- **Bug Reports**: Open an [Issue](https://github.com/mahirozdin/Self-hosted-Multi-VPN-Server-Manager-Studio--NPanel-TrojanGo-/issues) with detailed steps to reproduce
- **Feature Requests**: We're open to new ideas! Share your suggestions via Issues
- **Security Issues**: Please report security vulnerabilities privately

---

## 🐛 Troubleshooting

### Port Already in Use
```bash
# Kill process using port 3000
lsof -ti:3000 | xargs kill -9
```

### Database Issues
```bash
# Reset database (WARNING: deletes all data)
rm database.sqlite
npm start
```

### SSH Connection Failures
- Verify server IP and port are correct
- Ensure SSH service is running on target server
- Check firewall rules allow SSH (port 22)

### SSL Certificate Issues
- Ensure domain DNS is properly configured (A record pointing to server IP)
- Verify port 80 is accessible for Let's Encrypt validation
- Check if Certbot is installed on target server

### Installation Stuck or Fails
- Check server logs for detailed error messages
- Ensure target server has sufficient resources (1GB+ RAM recommended)
- Verify internet connectivity on target server

---

## 🙌 Credits

This project would not be possible without:
- **[Leiren/Npanel](https://github.com/Leiren/Npanel)**: The heart of the VPN automation
- **Trojan-Go**: High-performance trojan proxy
- **Community Contributors**: Thank you to everyone who helps improve this project!

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

<div align="center">

**Made with ❤️ for the open-source community**

[![GitHub](https://img.shields.io/badge/GitHub-mahirozdin-181717?style=flat&logo=github)](https://github.com/mahirozdin)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

*Maintained by [@mahirozdin](https://github.com/mahirozdin)*

</div>