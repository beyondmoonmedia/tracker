const express = require('express');
const { ParseServer } = require('parse-server');
const ParseDashboard = require('parse-dashboard');

const app = express();

// Parse Server configuration
const parseConfig = {
    databaseURI: process.env.MONGODB_URI || 'mongodb+srv://dev:MgyKxSP9JyhzzKrf@cluster0.dydl7.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
    appId: process.env.PARSE_APP_ID || 'myAppId',
    masterKey: process.env.PARSE_MASTER_KEY || 'myMasterKey',
    serverURL: process.env.PARSE_SERVER_URL || 'https://localhost:1337/parse',
    publicServerURL: process.env.PARSE_SERVER_URL || 'https://localhost:1337/parse',
    allowClientClassCreation: false,
    allowExpiredAuthDataToken: false,

  };
// Initialize Parse Server
const parseServer = new ParseServer(parseConfig);

// Parse Dashboard configuration
const dashboardConfig = new ParseDashboard({
  apps: [{
    serverURL: parseConfig.serverURL,
    appId: parseConfig.appId,
    masterKey: parseConfig.masterKey,
    appName: 'Your App Name'
  }],
  users: [{
    user: 'admin',
    pass: 'password'
  }]
}, { allowInsecureHTTP: true });

// Serve Parse Server
app.use('/parse', parseServer.app);

// Serve Parse Dashboard
app.use('/dashboard', dashboardConfig);

const port = 1337;
const httpServer = require('http').createServer(app);

// Initialize LiveQuery server
ParseServer.createLiveQueryServer(httpServer);

httpServer.listen(port, () => {
  console.log(`Parse Server running on port ${port}`);
});