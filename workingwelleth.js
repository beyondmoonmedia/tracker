const express = require('express');
const { default: ParseServer } = require('parse-server');
const ParseDashboard = require('parse-dashboard');
const { Alchemy, Network } = require('alchemy-sdk');
const axios = require('axios');
const { ethers } = require('ethers');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

// Constants
const USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7';
exports.USDT_ADDRESS = USDT_ADDRESS;
const CHAINLINK_BNB_USD_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
exports.CHAINLINK_BNB_USD_FEED = CHAINLINK_BNB_USD_FEED;
const BNB_RPC_URL = 'https://bsc-dataseed1.binance.org';
const CHAINLINK_ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
// Express and Parse Server setup
const config = {
    databaseURI: process.env.MONGODB_URI || 'mongodb+srv://dev:MgyKxSP9JyhzzKrf@cluster0.dydl7.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
    appId: process.env.PARSE_APP_ID || 'myAppId',
    masterKey: process.env.PARSE_MASTER_KEY || 'myMasterKey',
    serverURL: process.env.PARSE_SERVER_URL || 'https://64.227.103.227/parse',
    publicServerURL: process.env.PARSE_SERVER_URL || 'https://64.227.103.227/parse',
    allowClientClassCreation: false,
    allowExpiredAuthDataToken: false,
    cloud: path.join(__dirname, '/cloud/main.js'),
    liveQuery: {
        classNames: ['Transaction_e2f90a_BSC', 'Transaction_e2f90a_ETH']
    },
    allowOrigin: '*'
};

// Initialize Alchemy for Ethereum Mainnet
const alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.ETH_MAINNET,
    maxRetries: 10
});
exports.alchemy = alchemy;

// Initialize Alchemy for Ethereum Mainnet
const bscalchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.BNB_MAINNET,
    maxRetries: 10
});
exports.bscalchemy = bscalchemy;


// Add this after alchemy initialization
const provider = new ethers.JsonRpcProvider(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
exports.provider = provider;

// Add these constants at the top
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
exports.aggregatorV3InterfaceABI = aggregatorV3InterfaceABI;

// Initialize Chainlink price feed contract
const priceFeed = new ethers.Contract(
    CHAINLINK_ETH_USD_FEED,
    aggregatorV3InterfaceABI,
    provider
);

// Initialize Chainlink price feed contract for BNB
const bnbProvider = new ethers.JsonRpcProvider(BNB_RPC_URL);
exports.bnbProvider = bnbProvider;
const priceFeedBNB = new ethers.Contract(
    CHAINLINK_BNB_USD_FEED,
    aggregatorV3InterfaceABI,
    bnbProvider  // Use BSC provider instead of Ethereum provider
);
// Replace getBNBPrice function with this one
async function getBNBPrice(blockNumber) {
    try {
        const price = await priceFeedBNB.latestRoundData({ blockTag: blockNumber });
        return Number(price.answer) / 1e8; // Chainlink prices have 8 decimals
    } catch (error) {
        console.error("Error getting price from Chainlink:", error);
        // Fallback to Binance price if Chainlink fails
        try {
            const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
            return parseFloat(response.data.price);
        } catch (fallbackError) {
            console.error('Error fetching BNB price from fallback:', fallbackError);
            return 0;
        }
    }
}
// Replace getETHPrice function with this one
async function getETHPrice(blockNumber) {
    try {
        const price = await priceFeed.latestRoundData({ blockTag: blockNumber });
        return Number(price.answer) / 1e8; // Chainlink prices have 8 decimals
    } catch (error) {
        console.error("Error getting price from Chainlink:", error);
        // Fallback to Binance price if Chainlink fails
        try {
            const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
            return parseFloat(response.data.price);
        } catch (fallbackError) {
            console.error('Error fetching ETH price from fallback:', fallbackError);
            return 0;
        }
    }
}


// Add these new functions after the constants
async function setupWalletConfig(walletAddress, network) {
    const WalletConfig = Parse.Object.extend("WalletConfig");

    // Create a unique class name for this wallet
    const walletClassName = `Transaction_${walletAddress.substring(2, 8)}_${network}`;

    let net = network;
    if (net === "BSC")
        net = "BNB_MAINNET"
    else
        net = "ETH_MAINNET"
    // Check if wallet config exists
    const query = new Parse.Query(WalletConfig);
    query.equalTo("walletAddress", walletAddress.toLowerCase());
    query.equalTo("network", net);
    let config = await query.first({ useMasterKey: true });
    console.log(walletClassName)
    if (!config) {
        // Create new wallet config
        config = new WalletConfig();
        await config.save({
            walletAddress: walletAddress.toLowerCase(),
            transactionClassName: walletClassName,
            network: net,
            isActive: true
        }, { useMasterKey: true });

        try {
            // Attempt to create new Transaction class for this wallet
            const schema = new Parse.Schema(walletClassName);
            await schema.addString('contributor')
                .addString('tokenType')
                .addString('txHash')
                .addString('blockNumber')
                .addDate('timestamp')
                .addNumber('amountInUSD')
                .addNumber('tokenPrice')
                .addNumber('bonusPercentage')
                .addBoolean('hasBonus')
                .addNumber('baseTokens')
                .addNumber('bonusTokens')
                .addNumber('tokenAwarded')
                .addString('walletAddress')
                .save();
            console.log(`Created new transaction class: ${walletClassName} and ${network}`);
        } catch (error) {
            // If class already exists, just log and continue
            if (error.code === 103) { // Parse error code for 'Class already exists'
                console.log(`Transaction class ${walletClassName} already exists, continuing...`);
            } else {
                // If it's a different error, we should still throw it
                throw error;
            }
        }
    } else {
        console.log(`Wallet config already exists for ${walletAddress}, continuing...`);
    }

    return config;
}

// Helper function to validate and format ISO date string
function validateISODate(dateString) {
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            throw new Error('Invalid date');
        }
        // Ensure consistent format: YYYY-MM-DDThh:mm:ss.000Z
        return date.toISOString();
    } catch (error) {
        throw new Error(`Invalid date format: ${dateString}. Expected format: YYYY-MM-DDThh:mm:ss.000Z`);
    }
}

// Add these new functions for managing price and bonus periods
async function addPricePeriod(walletAddress, price, startDate, endDate) {
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const price_entry = new TokenPrice();

    // Validate and format dates
    const formattedStartDate = validateISODate(startDate);
    const formattedEndDate = validateISODate(endDate);

    console.log(`\nAdding new price period for wallet ${walletAddress}:`);
    console.log(`Price: $${price}`);
    console.log(`Start Date: ${formattedStartDate}`);
    console.log(`End Date: ${formattedEndDate}`);

    try {
        await price_entry.save({
            walletAddress: walletAddress.toLowerCase(),
            price: price,
            startDate: new Date(formattedStartDate),
            endDate: new Date(formattedEndDate)
        }, { useMasterKey: true });

        console.log('Price period added successfully');
        return price_entry;
    } catch (error) {
        console.error('Error adding price period:', error);
        throw error;
    }
}

async function addBonusPeriod(walletAddress, bonusPercentage, startDate, endDate) {
    const TokenBonus = Parse.Object.extend("TokenBonus");
    const bonus_entry = new TokenBonus();

    // Validate and format dates
    const formattedStartDate = validateISODate(startDate);
    const formattedEndDate = validateISODate(endDate);

    console.log(`\nAdding new bonus period for wallet ${walletAddress}:`);
    console.log(`Bonus: ${bonusPercentage * 100}%`);
    console.log(`Start Date: ${formattedStartDate}`);
    console.log(`End Date: ${formattedEndDate}`);

    try {
        await bonus_entry.save({
            walletAddress: walletAddress.toLowerCase(),
            bonusPercentage: bonusPercentage,
            startDate: new Date(formattedStartDate),
            endDate: new Date(formattedEndDate)
        }, { useMasterKey: true });

        console.log('Bonus period added successfully');
        return bonus_entry;
    } catch (error) {
        console.error('Error adding bonus period:', error);
        throw error;
    }
}

// Update setupWalletPricingAndBonus to accept date ranges
async function setupWalletPricingAndBonus(walletAddress, initialPrice, initialBonus = 0, startDate, endDate) {
    console.log(`\nSetting up pricing and bonus for wallet ${walletAddress}`);
    console.log(`Initial price: $${initialPrice}`);
    console.log(`Initial bonus: ${initialBonus * 100}%`);

    await addPricePeriod(walletAddress, initialPrice, startDate, endDate);
    await addBonusPeriod(walletAddress, initialBonus, startDate, endDate);

    // Verify the setup
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const TokenBonus = Parse.Object.extend("TokenBonus");

    const savedPrice = await new Parse.Query(TokenPrice)
        .equalTo("walletAddress", walletAddress.toLowerCase())
        .first({ useMasterKey: true });
    const savedBonus = await new Parse.Query(TokenBonus)
        .equalTo("walletAddress", walletAddress.toLowerCase())
        .first({ useMasterKey: true });

    console.log('\nVerifying setup:');
    console.log(`Saved price: $${savedPrice.get("price")}`);
    console.log(`Saved bonus: ${savedBonus.get("bonusPercentage") * 100}%`);
    console.log(`Price period: ${savedPrice.get("startDate").toISOString()}`);
    console.log(`Bonus period: ${savedBonus.get("startDate").toISOString()}`);
}

// Update setupWalletTracking to accept date ranges
async function setupWalletTracking(walletAddress, network, initialPrice, initialBonus, startDate, endDate) {
    try {
        console.log(`\nSetting up wallet tracking for ${walletAddress}`);
        console.log(`Initial price: $${initialPrice}`);
        console.log(`Initial bonus: ${initialBonus * 100}%`);

        const config = await setupWalletConfig(walletAddress.toLowerCase(), network);
        await setupWalletPricingAndBonus(walletAddress.toLowerCase(), initialPrice, initialBonus, startDate, endDate);

        // Verify the setup worked
        const TokenPrice = Parse.Object.extend("TokenPrice");
        const TokenBonus = Parse.Object.extend("TokenBonus");

        const priceCheck = await new Parse.Query(TokenPrice)
            .equalTo("walletAddress", walletAddress.toLowerCase())
            .first({ useMasterKey: true });
        const bonusCheck = await new Parse.Query(TokenBonus)
            .equalTo("walletAddress", walletAddress.toLowerCase())
            .first({ useMasterKey: true });

        console.log('\nVerifying wallet setup:');
        console.log(`Price setup: ${priceCheck ? 'Success' : 'Failed'}`);
        console.log(`Bonus setup: ${bonusCheck ? 'Success' : 'Failed'}`);


        return config;
    } catch (error) {
        console.error('Error in setupWalletTracking:', error);
        throw error;
    }
}

// Replace the existing getTokenPriceForTimestamp function
async function getTokenPriceForTimestamp(timestamp, walletAddress) {
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const query = new Parse.Query(TokenPrice);

    const txDate = timestamp instanceof Date ? timestamp : new Date(timestamp);

    query.greaterThanOrEqualTo("endDate", txDate);
    query.lessThanOrEqualTo("startDate", txDate);
    query.equalTo("walletAddress", walletAddress.toLowerCase());

    console.log(`\nLooking up price for wallet ${walletAddress} at ${txDate}`);

    const pricePeriod = await query.first({ useMasterKey: true });

    if (!pricePeriod) {
        console.log(`No price period found for wallet ${walletAddress} at timestamp ${txDate}`);
        return 0;
    }

    const price = pricePeriod.get("price");
    console.log(`Found price: $${price}`);
    return price;
}

// Replace the existing getBonusForTimestamp function
async function getBonusForTimestamp(timestamp, walletAddress) {
    const TokenBonus = Parse.Object.extend("TokenBonus");
    const query = new Parse.Query(TokenBonus);

    const txDate = timestamp instanceof Date ? timestamp : new Date(timestamp);

    query.lessThanOrEqualTo("startDate", txDate);
    query.greaterThanOrEqualTo("endDate", txDate);
    query.equalTo("walletAddress", walletAddress.toLowerCase());

    console.log(`\nLooking up bonus for wallet ${walletAddress} at ${txDate}`);

    try {
        const bonusPeriod = await query.first({ useMasterKey: true });

        if (!bonusPeriod) {
            console.log(`No bonus period found for wallet ${walletAddress} at timestamp ${txDate}`);
            return 0;
        }

        const bonus = bonusPeriod.get("bonusPercentage");
        console.log(`Found bonus period: ${bonus * 100}% for ${txDate}`);
        return bonus;
    } catch (error) {
        console.error("Error getting bonus period:", error);
        return 0;
    }
}

// Replace the existing calculateTokenRewards function
async function calculateTokenRewards(usdAmount, timestamp, walletAddress) {
    try {
        console.log('\nStarting Token Reward Calculation:');
        console.log(`USD Amount: $${usdAmount}`);
        console.log(`Timestamp: ${timestamp}`);
        console.log(`Wallet Address: ${walletAddress}`);

        const tokenPrice = await getTokenPriceForTimestamp(timestamp, walletAddress);
        const bonusPercentage = await getBonusForTimestamp(timestamp, walletAddress);

        if (tokenPrice === 0) {
            console.log('No token price available - 0 tokens awarded');
            return { baseTokens: 0, bonusTokens: 0, totalTokens: 0 };
        }

        const baseTokens = parseFloat((usdAmount / tokenPrice).toFixed(4));
        const bonusTokens = parseFloat((baseTokens * bonusPercentage).toFixed(4));
        const totalTokens = parseFloat((baseTokens + bonusTokens).toFixed(4));

        console.log('Token Reward Results:');
        console.log(`- Token Price: $${tokenPrice}`);
        console.log(`- Bonus Percentage: ${bonusPercentage * 100}%`);
        console.log(`- Base Tokens: ${baseTokens}`);
        console.log(`- Bonus Tokens: ${bonusTokens}`);
        console.log(`- Total Tokens: ${totalTokens}`);

        return { baseTokens, bonusTokens, totalTokens };
    } catch (error) {
        console.error("Error calculating token rewards:", error);
        return { baseTokens: 0, bonusTokens: 0, totalTokens: 0 };
    }
}

const app = express();

// Add body-parser middleware
app.use(express.json());

// Enable CORS for all routes
app.use(cors({
    origin: 'http://localhost:3000', // Replace with your frontend's URL
    methods: ['GET', 'POST'],
    credentials: true
}));

app.post('/update-bonus', async (req, res) => {
    const { walletAddress, newBonus, startDate, endDate } = req.body;

    if (!walletAddress || !newBonus || !startDate || !endDate) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const result = await updateBonus(walletAddress, newBonus, startDate, endDate);
    res.json(result);
});

app.post('/add-referral', async (req, res) => {
    const { walletAddress, refAddress } = req.body;

    if (!walletAddress || !refAddress) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const result = await addReferral(walletAddress, refAddress);
    res.json(result);
});

app.post('/webhook/bsc/transactions', async (req, res) => {
    try {
        console.log(req.body)
        // Check if it's an address activity webhook
        if (req.body.type !== 'ADDRESS_ACTIVITY') {
            return res.status(200).json({ message: 'Not an address activity event' });
        }

        const activities = req.body.event.activity;
        if (!Array.isArray(activities)) {
            return res.status(200).json({ message: 'No activities to process' });
        }
        // // Get all active wallets
        const WalletConfig = Parse.Object.extend("WalletConfig");
        const query = new Parse.Query(WalletConfig);
        query.equalTo("isActive", true);

        const activeWallets = await query.find({ useMasterKey: true });
        // Process each activity
        for (const activity of activities) {
            for (const walletConfig of activeWallets) {
                const walletAddress = walletConfig.get("walletAddress");
                const className = walletConfig.get("transactionClassName");
                const networks = walletConfig.get("network");

                // Convert addresses to lowercase for comparison
                const toAddress = activity.toAddress.toLowerCase();
                const trackedAddress = walletAddress.toLowerCase();
                if (toAddress === trackedAddress && req.body.event.network === networks) {
                    console.log(`\nNew ${activity.asset} transaction detected for ${walletAddress}`);
                    if (activity.category === "token") {
                        const tx = await bnbProvider.getTransaction(activity.hash);

                        console.log("tx")
                        console.log(tx)
                        // If it's a token transfer, decode the input data
                        if (tx.data && tx.to) {
                            // Add ERC20/BEP20 standard interface for decimals
                            const tokenInterface = new ethers.Interface([
                                'function transfer(address to, uint256 value)',
                                'function decimals() view returns (uint8)'
                            ]);

                            try {
                                const decodedData = tokenInterface.decodeFunctionData('transfer', tx.data);
                                console.log("decodedData")
                                console.log(decodedData)
                                // Get token decimals
                                const tokenContract = new ethers.Contract(tx.to, tokenInterface, bnbProvider);
                                const decimals = await tokenContract.decimals();

                                // Format the value using the decimals
                                const formattedValue = ethers.formatUnits(decodedData.value, decimals);

                                try {
                                    // Create transaction object
                                    const tx = {
                                        hash: activity.hash,
                                        from: activity.fromAddress,
                                        to: activity.toAddress,
                                        value: formattedValue.toString(),
                                        blockNumber: parseInt(activity.blockNum, 16),
                                    };
                                    console.log("receipt")

                                    // Get block information using BNB provider
                                    const receipt = await bnbProvider.waitForTransaction(activity.hash);
                                    console.log(receipt)
                                    console.log("block")

                                    const block = await bnbProvider.getBlock(receipt.blockNumber);
                                    // Process the transaction
                                    console.log(block)
                                    console.log(className)
                                    await processTransaction("USDT", tx, false, block, className, "BNB");
                                    console.log('Transaction processed successfully');
                                } catch (error) {
                                    console.error('Error processing individual transaction:', error);
                                    // Continue with next transaction instead of failing the whole webhook
                                    continue;
                                }

                            } catch (error) {
                                console.error('Error decoding transaction data:', error);
                            }
                        }
                    }
                    else {
                        try {
                            // Create transaction object
                            const tx = {
                                hash: activity.hash,
                                from: activity.fromAddress,
                                to: activity.toAddress,
                                value: activity.value.toString(),
                                blockNumber: parseInt(activity.blockNum, 16),
                            };

                            // Get block information using BNB provider
                            const receipt = await bnbProvider.waitForTransaction(activity.hash);

                            const block = await bnbProvider.getBlock(receipt.blockNumber);

                            // Process the transaction
                            console.log(className)
                            await processTransaction(activity.asset, tx, false, block, className, "BNB");
                            console.log('Transaction processed successfully');
                        } catch (error) {
                            console.error('Error processing individual transaction:', error);
                            // Continue with next transaction instead of failing the whole webhook
                            continue;
                        }
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

// Add the webhook endpoint
app.post('/webhook/eth/transactions', async (req, res) => {
    try {
        console.log(req.body.event.activity)
        // Check if it's an address activity webhook
        if (req.body.type !== 'ADDRESS_ACTIVITY') {
            return res.status(200).json({ message: 'Not an address activity event' });
        }

        const activities = req.body.event.activity;
        if (!Array.isArray(activities)) {
            return res.status(200).json({ message: 'No activities to process' });
        }

        // Get all active wallets
        const WalletConfig = Parse.Object.extend("WalletConfig");
        const query = new Parse.Query(WalletConfig);
        query.equalTo("isActive", true);
        const activeWallets = await query.find({ useMasterKey: true });

        // Process each activity
        for (const activity of activities) {
            for (const walletConfig of activeWallets) {
                const walletAddress = walletConfig.get("walletAddress");
                const className = walletConfig.get("transactionClassName");
                const networks = walletConfig.get("network");

                // Convert addresses to lowercase for comparison
                const toAddress = activity.toAddress.toLowerCase();
                const trackedAddress = walletAddress.toLowerCase();

                if (toAddress === trackedAddress && req.body.event.network === networks) {
                    console.log(`\nNew ${activity.asset} transaction detected for ${walletAddress}`);

                    try {
                        // Create transaction object
                        const tx = {
                            hash: activity.hash,
                            from: activity.fromAddress,
                            to: activity.toAddress,
                            value: activity.value.toString(),
                            blockNumber: parseInt(activity.blockNum, 16),
                        };

                        // Get block information using ETH provider
                        const receipt = await provider.waitForTransaction(activity.hash);

                        const block = await provider.getBlock(receipt.blockNumber);

                        // Process the transaction
                        await processTransaction(activity.asset, tx, false, block, className, "ETH");
                        console.log('Transaction processed successfully');
                    } catch (error) {
                        console.error('Error processing individual transaction:', error);
                        // Continue with next transaction instead of failing the whole webhook
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
// SOLANA WEBHOOK ENDPOINT
app.post('/webhook/sol/transactions', async (req, res) => {
    try {
        console.log('Received Solana webhook payload:', JSON.stringify(req.body, null, 2));

        // Check if it's an address activity webhook
        if (req.body.type !== 'ADDRESS_ACTIVITY') {
            return res.status(200).json({ message: 'Not an address activity event' });
        }

        const transactions = req.body.event.transaction;
        if (!Array.isArray(transactions)) {
            return res.status(200).json({ message: 'No transactions to process' });
        }

        // Get all active wallets
        const WalletConfig = Parse.Object.extend("WalletConfig");
        const query = new Parse.Query(WalletConfig);
        query.equalTo("isActive", true);
        const activeWallets = await query.find({ useMasterKey: true });

        for (const txEvent of transactions) {
            const signature = txEvent.signature;
            const slot = txEvent.slot;
            const accountKeys = txEvent.transaction?.[0]?.message?.[0]?.account_keys || [];

            for (const walletConfig of activeWallets) {
                const walletAddress = walletConfig.get("walletAddress");
                const className = walletConfig.get("transactionClassName");
                const networks = walletConfig.get("network");

                if (req.body.event.network !== networks) continue;

                const isInvolved = accountKeys.some(acc => acc === walletAddress);
                if (!isInvolved) continue;

                console.log(`\nNew SOL transaction detected for ${walletAddress}`);

                try {
                    const tx = {
                        signature: signature,
                        slot: slot,
                        fee: txEvent.meta?.[0]?.fee || 0,
                        preBalances: txEvent.meta?.[0]?.pre_balances || [],
                        postBalances: txEvent.meta?.[0]?.post_balances || [],
                        logs: txEvent.meta?.[0]?.log_messages || [],
                        walletAddress: walletAddress
                    };

                    await processTransactionSOL(tx, className);
                } catch (error) {
                    console.error('Error processing Solana transaction:', error);
                    continue;
                }
            }
        }

        res.status(200).json({ message: 'Solana transactions processed successfully' });

    } catch (error) {
        console.error('Error processing Solana webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create HTTPS server using the existing app
const sslOptions = {
    key: fs.readFileSync('private.key'),
    cert: fs.readFileSync('certificate.crt'),
    ca: fs.readFileSync('ca_bundle.crt')
};

// Initialize Parse Server
const api = new ParseServer(config);

const dashboard = new ParseDashboard({
    apps: [{
        serverURL: config.serverURL,
        publicServerURL: config.publicServerURL,
        appId: config.appId,
        masterKey: config.masterKey,
        appName: "Blockchain Tracker"
    }],
}, { allowInsecureHTTP: true });
api.start()

// Mount Parse Server and Dashboard
app.use('/parse', api.app);
app.use('/dashboard', dashboard);
app.get('/', (req, res) => res.send('Server is running'));
// Start the server and blockchain tracking

const httpsServer = https.createServer(sslOptions, app);
const HTTPS_PORT = 443;

// Start HTTPS server
httpsServer.listen(HTTPS_PORT, () => {
    console.log(`HTTPS Server running on port ${HTTPS_PORT}`);
});

const io = socketIo(httpsServer, {
    cors: {
        origin: "http://localhost:3000", // Allow your React app's origin
        methods: ["GET", "POST"],
        allowedHeaders: ["my-custom-header"],
        credentials: true
    }
});


// Socket.IO connection
// Export the io instance for use in Cloud Code
module.exports = { io };
io.on('connection', (socket) => {
    console.log('A user connected');

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});
// Initialize Parse LiveQuery Server
const parseLiveQueryServer = ParseServer.createLiveQueryServer(httpsServer);

// Add LiveQuery connection logging
if (parseLiveQueryServer.server) {
    parseLiveQueryServer.server.on('connection', (ws) => {
        console.log('New LiveQuery connection established');

        ws.on('close', () => {
            console.log('LiveQuery connection closed');
        });

        ws.on('error', (error) => {
            console.error('LiveQuery connection error:', error);
        });
    });
}

async function processTransactionSOL(tx, className) {
    try {
        let timestamp = new Date();  // fallback timestamp
        let blockNumber = tx.slot || 0;  // slot as block equivalent

        // Estimate USD (fee in lamports -> SOL)
        const feeInSOL = tx.fee / 1e9;
        const estSOLPrice = 20;  // adjust or fetch real
        const amountInUSD = feeInSOL * estSOLPrice;

        console.log(`\nProcessing SOL transaction:`);
        console.log(`Signature: ${tx.signature}`);
        console.log(`Slot: ${tx.slot}`);
        console.log(`Fee: ${tx.fee} lamports (${feeInSOL} SOL ~ $${amountInUSD})`);
        console.log(`Tracked wallet involved: ${tx.walletAddress}`);

        // Check if transaction already exists
        const Transaction = Parse.Object.extend(className);
        const query = new Parse.Query(Transaction);
        query.equalTo("txHash", tx.signature);
        const exists = await query.first({ useMasterKey: true });

        if (exists) {
            console.log(`Transaction ${tx.signature} already exists in ${className}`);
            return;
        }

        // Calculate rewards
        const tokenRewards = await calculateTokenRewards(amountInUSD, timestamp, tx.walletAddress.toLowerCase());
        const tokenPrice = await getTokenPriceForTimestamp(timestamp, tx.walletAddress.toLowerCase());
        const bonusPercentage = await getBonusForTimestamp(timestamp, tx.walletAddress.toLowerCase());

        console.log('\nFinal Transaction Details:');
        console.log(`Token Price: $${tokenPrice}`);
        console.log(`Bonus Percentage: ${bonusPercentage * 100}%`);
        console.log(`Base Tokens: ${tokenRewards.baseTokens}`);
        console.log(`Bonus Tokens: ${tokenRewards.bonusTokens}`);
        console.log(`Total Tokens: ${tokenRewards.totalTokens}`);

        // Save transaction
        if (amountInUSD > 0) {
            const transaction = new Transaction();
            const data = {
                contributor: tx.walletAddress.toLowerCase(),
                tokenType: "SOL",
                txHash: tx.signature,
                blockNumber: blockNumber.toString(),
                timestamp: timestamp,
                amountInUSD: amountInUSD,
                amountInToken: feeInSOL,
                tokenPrice: tokenPrice,
                bonusPercentage: bonusPercentage,
                hasBonus: bonusPercentage > 0,
                baseTokens: tokenRewards.baseTokens,
                bonusTokens: tokenRewards.bonusTokens,
                tokenAwarded: tokenRewards.totalTokens,
                walletAddress: tx.walletAddress.toLowerCase()
            };

            await transaction.save(data, { useMasterKey: true });
            console.log(`SOL transaction saved successfully: ${tx.signature}`);
        }
    } catch (error) {
        console.error("\nError processing SOL transaction:", error);
        console.error("Transaction details:", {
            signature: tx.signature,
            slot: tx.slot,
            fee: tx.fee,
            walletAddress: tx.walletAddress
        });
    }
}



// Update processTransaction to ensure wallet address is correctly passed
async function processTransaction(type, tx, isHistorical = false, block = null, className, networks) {
    try {
        const fullWalletAddress = tx.to.toLowerCase();
        console.log("Processing transaction for", fullWalletAddress);
        console.log("Processing transaction for type: ", type);
        console.log("Processing transaction for network:", networks);

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


        if (block) {
            timestamp = new Date(block.timestamp * 1000);
            blockNumber = block.number;
        } else {
            const txBlock = await bnbProvider.getBlock(tx.blockNumber);
            timestamp = new Date(txBlock.timestamp * 1000);
            blockNumber = txBlock.number;
        }
        if (networks === 'ETH') {
            if (type === "USDT")
                amountInUSD = Number(tx.value);
            else if (type === "ETH") {
                const ethPrice = await getETHPrice(blockNumber);
                amountInUSD = tx.value * ethPrice;
                console.log(`ETH Amount: ${tx.value} ETH`);
                console.log(`ETH Price: $${ethPrice}`);
                console.log(`USD Amount: $${amountInUSD}`);

            }
            else {
                return;
            }
        } else if (networks === 'BNB') {

            if (type === "USDT")
                amountInUSD = Number(tx.value);
            else if (type === "ETH") {
                const bnbPrice = await getBNBPrice(blockNumber);
                // Value is already in ETH from the webhook, no need to format
                console.log("bnbPrice", bnbPrice)
                amountInUSD = tx.value * bnbPrice;
                console.log(`BNB Amount: ${tx.value} BNB`);
                console.log(`BNB Price: $${bnbPrice}`);
                console.log(`USD Amount: $${amountInUSD}`);
            }
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

            console.log(`amountInUSD: ${amountInUSD}`);

            const transaction = new Transaction();
            // if (type === "USDT")
            //     networks = "USDT"
            const data = {
                contributor: tx.from.toLowerCase(),
                tokenType: networks,
                txHash: tx.hash,
                blockNumber: blockNumber.toString(),
                timestamp: timestamp,
                amountInUSD: amountInUSD,
                amountInToken: tx.value,
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

// Add a function to update price for future periods
async function updatePrice(walletAddress, newPrice, startDate, endDate) {
    try {
        const formattedStartDate = validateISODate(startDate);
        const now = new Date();

        if (new Date(formattedStartDate) < now) {
            throw new Error("Cannot update price for past periods");
        }

        await addPricePeriod(walletAddress, newPrice, startDate, endDate);
        console.log('Price updated successfully');
    } catch (error) {
        console.error('Error updating price:', error);
        throw error;
    }
}

// Add a function to update bonus for future periods
async function updateBonus(walletAddress, newBonus, startDate, endDate) {
    try {
        const formattedStartDate = validateISODate(startDate);
        const now = new Date();

        if (new Date(formattedStartDate) < now) {
            throw new Error("Cannot update bonus for past periods");
        }

        await addBonusPeriod(walletAddress, newBonus, startDate, endDate);
        console.log('Bonus updated successfully');
    } catch (error) {
        console.error('Error updating bonus:', error);
        throw error;
    }
}

// Add a function to update bonus for future periods
async function addReferral(walletAddress, refAddress) {
    try {
        const TokenReferral = Parse.Object.extend("Transaction_7846e7_BSC");
        const referral_entry = new TokenReferral();

        // Check contributions in both Transaction_7846e7_BSC and Transaction_7846e7_ETH tables
        const TransactionBSC = Parse.Object.extend("Transaction_7846e7_BSC");
        const TransactionETH = Parse.Object.extend("Transaction_7846e7_ETH");

        const queryBSC = new Parse.Query(TransactionBSC);
        queryBSC.equalTo("contributor", refAddress.toLowerCase());
        queryBSC.limit(1);
        queryBSC.ascending("timestamp"); // Assuming you have a timestamp field to sort by

        const queryETH = new Parse.Query(TransactionETH);
        queryETH.equalTo("contributor", refAddress.toLowerCase());
        queryETH.limit(1);
        queryETH.ascending("timestamp"); // Assuming you have a timestamp field to sort by

        // Execute both queries in parallel
        const [bscContribution, ethContribution] = await Promise.all([
            queryBSC.first({ useMasterKey: true }),
            queryETH.first({ useMasterKey: true })
        ]);

        // Determine which contribution is first
        let firstContribution;
        if (bscContribution && ethContribution) {
            const bscTimestamp = bscContribution.get("timestamp");
            const ethTimestamp = ethContribution.get("timestamp");

            firstContribution = bscTimestamp < ethTimestamp ? bscContribution : ethContribution;
        } else if (bscContribution) {
            firstContribution = bscContribution;
        } else if (ethContribution) {
            firstContribution = ethContribution;
        } else {
            console.log(`Referral address ${refAddress} has not contributed yet.`);
            throw new Error('Referral address has not contributed yet.');
        }

        // Calculate the bonus based on the first contribution
        const firstContributionAmount = firstContribution.get("tokenAwarded"); // Assuming you have this field
        const bonusTokens = firstContributionAmount * 0.10; // Calculate 10% bonus

        // Set the referral details
        referral_entry.set("contributor", walletAddress.toLowerCase());
        referral_entry.set("refAddress", refAddress.toLowerCase());
        referral_entry.set("refBonusTokens", bonusTokens); // Save the calculated bonus tokens

        try {
            await referral_entry.save(null, { useMasterKey: true });
            console.log('Referral added successfully with bonus tokens:', bonusTokens);
            return referral_entry;
        } catch (error) {
            console.error('Error adding referral:', error);
            throw error;
        }
    } catch (error) {
        console.error('Error updating referral:', error);
        throw error;
    }
}

// Add this new endpoint for setting up wallet tracking
app.post('/api/setupWalletTracking', async (req, res) => {
    const { walletAddress, network, initialPrice, initialBonus, startDate, endDate } = req.body;

    try {
        // Call the setupWalletTracking function with the provided parameters
        const config = await setupWalletTracking(walletAddress, network, initialPrice, initialBonus, startDate, endDate);
        res.status(200).json({ message: 'Wallet tracking setup successfully', config });
    } catch (error) {
        console.error('Error in setupWalletTracking:', error);
        res.status(500).json({ error: 'Failed to setup wallet tracking' });
    }
    console.log("visited")
});

// Make sure to export the app if you're using it in other files
module.exports = app;