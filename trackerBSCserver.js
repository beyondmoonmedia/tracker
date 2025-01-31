const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();

// SSL certificate configuration with local paths
const sslOptions = {
  key: fs.readFileSync('private.key'),     // Your private key file
  cert: fs.readFileSync('certificate.crt'), // Your certificate file
  ca: fs.readFileSync('ca_bundle.crt')      // Your CA bundle file
};

// Your existing route
app.get('/.well-known/pki-validation/CA8A9209D7653245550200FC8EE46EBC.txt', (req, res) => {
    const filePath = path.join(__dirname, '.well-known', 'pki-validation', 'CA8A9209D7653245550200FC8EE46EBC.txt');
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        console.error('File not found:', filePath);
        res.status(404).send('File not found');
    }
});

// Optional: Redirect HTTP to HTTPS
const http = require('http');
http.createServer((req, res) => {
    res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
    res.end();
}).listen(80);

// Create HTTPS server
const httpsServer = https.createServer(sslOptions, app);

// Start the HTTPS server
const PORT = 443; // Standard HTTPS port
httpsServer.listen(PORT, () => {
    console.log(`HTTPS Server running on port ${PORT}`);
});