const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { sequelize } = require('./models/Database');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

// Load environment variables if .env exists
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/node_modules', express.static(path.join(__dirname, '../node_modules')));

const apiRoutes = require('./routes/api');
const monitorService = require('./services/monitorService');
const terminalService = require('./services/terminalService');

app.use('/api', apiRoutes);

// Initialize Terminal Service with IO
terminalService(io);

sequelize.sync({ alter: true }).then(() => {
  console.log('Database synced');
}).catch(err => {
  console.error('Database sync failed:', err);
});

// Create default .env if not exists
const envPath = path.join(__dirname, '../.env');
if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, 'ADMIN_PASSWORD=admin123\nPORT=3000');
    console.log('.env file created with default password: admin123');
}

// Placeholder Routes
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
