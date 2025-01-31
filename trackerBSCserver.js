const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

// Specific route for the validation file
app.get('/.well-known/pki-validation/CA8A9209D7653245550200FC8EE46EBC.txt', (req, res) => {
    const filePath = path.join(__dirname, '.well-known', 'pki-validation', 'CA8A9209D7653245550200FC8EE46EBC.txt');
    
    // Check if file exists
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        console.error('File not found:', filePath);
        res.status(404).send('File not found');
    }
});

// Optional: Add a basic route for the root path
app.get('/', (req, res) => {
    res.send('Server is running');
});

// Start the server
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // Log the full path to help with debugging
    console.log('Looking for file at:', path.join(__dirname, '.well-known', 'pki-validation', 'CA8A9209D7653245550200FC8EE46EBC.txt'));
});