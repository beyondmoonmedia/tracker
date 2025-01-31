const express = require('express');
const { default: ParseServer } = require('parse-server');
const ParseDashboard = require('parse-dashboard');
const axios = require('axios');
const { ethers } = require('ethers');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// Essential constants
const CHAINLINK_BNB_USD_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
const BNB_RPC_URL = 'https://bsc-dataseed1.binance.org';
const bnbProvider = new ethers.JsonRpcProvider(BNB_RPC_URL);

// Parse Server configuration
const config = {
    databaseURI: process.env.MONGODB_URI || 'mongodb://localhost:27017/dev',
    appId: process.env.PARSE_APP_ID || 'myAppId',
    masterKey: process.env.PARSE_MASTER_KEY || 'myMasterKey',
    serverURL: process.env.PARSE_SERVER_URL || 'https://64.227.103.227/parse',
    publicServerURL: process.env.PARSE_SERVER_URL || 'https://64.227.103.227/parse',
    allowClientClassCreation: false,
    allowExpiredAuthDataToken: false,
    cloud: path.join(__dirname, '/cloud/main.js'),
};

// Initialize Parse Server
const parseServer = new ParseServer(config);

// Initialize Parse Dashboard with user authentication
const dashboard = new ParseDashboard({
    apps: [{
        serverURL: config.serverURL,
        publicServerURL: config.publicServerURL,
        appId: config.appId,
        masterKey: config.masterKey,
        appName: "Blockchain Tracker"
    }],
    useEncryptedPasswords: false
}, { allowInsecureHTTP: true });

// Initialize Express app and configure SSL
const app = express();
app.use(express.json());

const sslOptions = {
    key: fs.readFileSync('private.key'),
    cert: fs.readFileSync('certificate.crt'),
    ca: fs.readFileSync('ca_bundle.crt')
};

// Price feed setup
const aggregatorV3InterfaceABI = [
    {
        inputs: [],
        name: "latestRoundData",
        outputs: [
            { name: "roundId", type: "uint80" },
            { name: "answer", type: "int256" },
            { name: "startedAt", type: "uint256" },
            { name: "updatedAt", type: "uint256" },
            { name: "answeredInRound", type: "uint80" }
        ],
        stateMutability: "view",
        type: "function"
    }
];

const priceFeed = new ethers.Contract(
    CHAINLINK_BNB_USD_FEED,
    aggregatorV3InterfaceABI,
    bnbProvider
);

// BNB price function
async function getBNBPrice(blockNumber) {
    try {
        const price = await priceFeed.latestRoundData({ blockTag: blockNumber });
        return Number(price.answer) / 1e8;
    } catch (error) {
        console.error("Error getting price from Chainlink:", error);
        try {
            const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
            return parseFloat(response.data.price);
        } catch (fallbackError) {
            console.error('Error fetching BNB price from fallback:', fallbackError);
            return 0;
        }
    }
}

// Add the processTransaction function back
async function processTransaction(type, tx, isHistorical = false, block = null, className) {
    try {
        const fullWalletAddress = tx.to.toLowerCase();
        console.log("Processing transaction for", fullWalletAddress);
        
        // Check if transaction already exists
        const Transaction = Parse.Object.extend(className);
        const query = new Parse.Query(Transaction);
        query.equalTo("txHash", tx.hash);
        const exists = await query.first({ useMasterKey: true });
        
        if (exists) {
            console.log(`Transaction ${tx.hash} already exists in ${className}`);
            return;
        }

        let amountInUSD = 0;
        let tokenRewards;
        let timestamp;
        let blockNumber;
        let bnbAmount = 0;

        if (block) {
            timestamp = new Date(block.timestamp * 1000);
            blockNumber = block.number;
        } else {
            const txBlock = await bnbProvider.getBlock(tx.blockNumber);
            timestamp = new Date(txBlock.timestamp * 1000);
            blockNumber = txBlock.number;
        }
        
        if (type === 'BNB') {
            // Handle BNB amount directly (it's already in BNB units)
            bnbAmount = parseFloat(tx.value);
            const bnbPrice = await getBNBPrice(blockNumber);
            amountInUSD = bnbAmount * bnbPrice;
            console.log(`BNB Amount: ${bnbAmount} BNB`);
            console.log(`BNB Price: $${bnbPrice}`);
            console.log(`USD Amount: $${amountInUSD}`);
        } else {
            // Handle other tokens if needed
            const value = ethers.formatUnits(tx.value, 6); // Adjust decimals based on token
            amountInUSD = parseFloat(value);
        }

        console.log(`\nProcessing ${type} transaction:`);
        console.log(`Transaction Hash: ${tx.hash}`);
        console.log(`Amount in USD: $${amountInUSD}`);
        console.log(`Timestamp: ${timestamp}`);
        console.log(`Wallet Address: ${fullWalletAddress}`);

        // Calculate token rewards with the full wallet address
        tokenRewards = await calculateTokenRewards(amountInUSD, timestamp, fullWalletAddress);

        // Save transaction if USD amount is valid
        if (amountInUSD > 0) {
            const tokenPrice = await getTokenPriceForTimestamp(timestamp, fullWalletAddress);
            const bonusPercentage = await getBonusForTimestamp(timestamp, fullWalletAddress);
            
            console.log('\nFinal Transaction Details:');
            console.log(`Token Price: $${tokenPrice}`);
            console.log(`Bonus Percentage: ${bonusPercentage * 100}%`);
            console.log(`Base Tokens: ${tokenRewards.baseTokens}`);
            console.log(`Bonus Tokens: ${tokenRewards.bonusTokens}`);
            console.log(`Total Tokens: ${tokenRewards.totalTokens}`);

            const transaction = new Transaction();
            const data = {
                contributor: tx.from.toLowerCase(),
                tokenType: type,
                txHash: tx.hash,
                blockNumber: blockNumber.toString(),
                timestamp: timestamp,
                amountInUSD: amountInUSD,
                bnbAmount: type === 'BNB' ? bnbAmount : 0, // Add BNB amount to the saved data
                tokenPrice: tokenPrice,
                bonusPercentage: bonusPercentage,
                hasBonus: bonusPercentage > 0,
                baseTokens: tokenRewards.baseTokens,
                bonusTokens: tokenRewards.bonusTokens,
                tokenAwarded: tokenRewards.totalTokens,
                walletAddress: fullWalletAddress
            };

            await transaction.save(data, { useMasterKey: true });
            console.log(`Transaction saved successfully: ${tx.hash}`);
        }
    } catch (error) {
        console.error("\nError processing transaction:", error);
        console.error("Transaction details:", {
            hash: tx.hash,
            blockNumber: tx.blockNum || tx.blockNumber,
            from: tx.from,
            to: tx.to,
            value: tx.value
        });
    }
}

// Webhook endpoint
app.post('/webhook/transactions', async (req, res) => {
    try {
        if (req.body.type !== 'ADDRESS_ACTIVITY') {
            return res.status(200).json({ message: 'Not an address activity event' });
        }

        const activities = req.body.event.activity;
        if (!Array.isArray(activities)) {
            return res.status(200).json({ message: 'No activities to process' });
        }

        const WalletConfig = Parse.Object.extend("WalletConfig");
        const query = new Parse.Query(WalletConfig);
        query.equalTo("isActive", true);
        const activeWallets = await query.find({ useMasterKey: true });

        for (const activity of activities) {
            for (const walletConfig of activeWallets) {
                const walletAddress = walletConfig.get("walletAddress");
                const className = walletConfig.get("transactionClassName");

                if (activity.toAddress.toLowerCase() === walletAddress.toLowerCase()) {
                    console.log(`\nNew ${activity.asset} transaction detected for ${walletAddress}`);
                    
                    try {
                        const tx = {
                            hash: activity.hash,
                            from: activity.fromAddress,
                            to: activity.toAddress,
                            value: activity.value,
                            blockNumber: parseInt(activity.blockNum, 16),
                        };

                        const receipt = await bnbProvider.waitForTransaction(activity.hash);
                        const block = await bnbProvider.getBlock(receipt.blockNumber);
                        await processTransaction(activity.asset, tx, false, block, className);
                    } catch (error) {
                        console.error('Error processing individual transaction:', error);
                        continue;
                    }
                }
            }
        }

        res.status(200).json({ message: 'Transactions processed successfully' });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start servers
parseServer.start().then(() => {
    app.use('/parse', parseServer.app);
    app.use('/dashboard', dashboard);
    
    const httpsServer = https.createServer(sslOptions, app);
    httpsServer.listen(443, () => {
        console.log('HTTPS Server running on port 443');
    });

    http.createServer((req, res) => {
        res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
        res.end();
    }).listen(80, () => {
        console.log('HTTP redirect server running on port 80');
    });
});

// Export app for potential testing
module.exports = app;