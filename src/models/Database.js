const { Sequelize, DataTypes } = require('sequelize');
const path = require('path');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, '../../database.sqlite'),
  logging: false,
});

const Server = sequelize.define('Server', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  ip: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  port: {
    type: DataTypes.INTEGER,
    defaultValue: 22,
  },
  vpn_port: {
    type: DataTypes.INTEGER,
    defaultValue: 443,
  },
  username: {
    type: DataTypes.STRING,
    defaultValue: 'root',
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  domain: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  admin_user: {
    type: DataTypes.STRING,
    defaultValue: 'Admin',
  },
  admin_pass: {
    type: DataTypes.STRING,
    defaultValue: 'ChangeMe123!',
  },
  ssl_expiry: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  last_ssl_renew: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  latency: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'unknown', // online, error, installing
  },
  ssh_status: {
    type: DataTypes.STRING,
    defaultValue: 'unknown', // ok, error
  },
  trojan_config: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  trojan_latency: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  trojan_last_error: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
});

module.exports = { sequelize, Server };
