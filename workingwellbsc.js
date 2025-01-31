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

// Constants
const USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7';
exports.USDT_ADDRESS = USDT_ADDRESS;
const CHAINLINK_ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const CHAINLINK_BNB_USD_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
exports.CHAINLINK_BNB_USD_FEED = CHAINLINK_BNB_USD_FEED;
const BNB_RPC_URL = 'https://bsc-dataseed1.binance.org';
// Express and Parse Server setup
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

// Initialize Alchemy for Ethereum Mainnet
const alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY,
    network: Network.ETH_MAINNET,
    maxRetries: 10
});
exports.alchemy = alchemy;

// Cache for ETH price
let ethPriceCache = { price: 0, lastUpdate: 0 };
const PRICE_CACHE_DURATION = 60 * 1000; // 1 minute

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

// Add these new functions after the constants
async function setupWalletConfig(walletAddress, network) {
    const WalletConfig = Parse.Object.extend("WalletConfig");
    
    // Create a unique class name for this wallet
    const walletClassName = `Transaction_${walletAddress.substring(2, 8)}_${network}`;
    
    // Check if wallet config exists
    const query = new Parse.Query(WalletConfig);
    query.equalTo("walletAddress", walletAddress.toLowerCase());
    let config = await query.first({ useMasterKey: true });
    
    if (!config) {
        // Create new wallet config
        config = new WalletConfig();
        await config.save({
            walletAddress: walletAddress.toLowerCase(),
            transactionClassName: walletClassName,
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

        const config = await setupWalletConfig(walletAddress, network);
        await setupWalletPricingAndBonus(walletAddress, initialPrice, initialBonus, startDate, endDate);

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

        // Process historical transactions
        const className = config.get("transactionClassName");
        console.log(`\nProcessing historical transactions for class: ${className}`);
        
        try {
            const incomingEth = await alchemy.core.getAssetTransfers({
                fromBlock: "0x0",
                toBlock: "latest",
                toAddress: walletAddress,
                category: ["external", "internal"],
            });

            const incomingUsdt = await alchemy.core.getAssetTransfers({
                fromBlock: "0x0",
                toBlock: "latest",
                toAddress: walletAddress,
                contractAddresses: [USDT_ADDRESS],
                category: ["erc20"],
            });

            console.log(`Found ${incomingEth.transfers.length} ETH transactions`);
            console.log(`Found ${incomingUsdt.transfers.length} USDT transactions`);

            for (const tx of incomingEth.transfers) {
                await processTransaction('ETH', tx, true, null, className);
            }

            for (const tx of incomingUsdt.transfers) {
                await processTransaction('USDT', tx, true, null, className);
            }
        } catch (error) {
            console.error(`Error processing historical transactions:`, error);
        }

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

// Add at the top with other requires

// Add the webhook endpoint
app.post('/webhook/bsc/transactions', async (req, res) => {
    try {
        // Check if it's an address activity webhook
        if (req.body.type !== 'ADDRESS_ACTIVITY') {
            return res.status(200).json({ message: 'Not an address activity event' });
        }

        const activities = req.body.event.activity;
        if (!Array.isArray(activities)) {
            return res.status(200).json({ message: 'No activities to process' });
        }
        console.log(req.body)
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

                // Convert addresses to lowercase for comparison
                const toAddress = activity.toAddress.toLowerCase();
                const trackedAddress = walletAddress.toLowerCase();
                console.log(req.body.event.network)
                console.log(className)
                if (toAddress === trackedAddress && req.body.event.network === className) {
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

                        // Get block information using BNB provider
                        const receipt = await bnbProvider.waitForTransaction(activity.hash);
                        
                        const block = await bnbProvider.getBlock(receipt.blockNumber);

                        // Process the transaction
                        console.log(className)
                        await processTransaction(activity.asset, tx, false, block, className);
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

// Create HTTPS server using the existing app
const sslOptions = {
    key: fs.readFileSync('private.key'),
    cert: fs.readFileSync('certificate.crt'),
    ca: fs.readFileSync('ca_bundle.crt')
};

// Initialize Parse Server
const parseServer = new ParseServer(config);

const dashboard = new ParseDashboard({
    apps: [{
        serverURL: config.serverURL,
        publicServerURL: config.publicServerURL,
        appId: config.appId,
        masterKey: config.masterKey,
        appName: "Blockchain Tracker"
    }],
}, { allowInsecureHTTP: true });
parseServer.start()

// Mount Parse Server and Dashboard
app.use('/parse', parseServer.app);
app.use('/dashboard', dashboard);
app.get('/', (req, res) => res.send('Server is running'));
// Start the server and blockchain tracking

const httpsServer = https.createServer(sslOptions, app);
const HTTPS_PORT = 443;

// Start HTTPS server
httpsServer.listen(HTTPS_PORT, () => {
    console.log(`HTTPS Server running on port ${HTTPS_PORT}`);
});

// Optional: HTTP to HTTPS redirect server
http.createServer((req, res) => {
    res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
    res.end();
}).listen(80, () => {
    console.log('HTTP redirect server running on port 80');
});

// Replace the existing monitorEthereumTransfers function
async function monitorEthereumTransfers() {
    const WalletConfig = Parse.Object.extend("WalletConfig");
    const query = new Parse.Query(WalletConfig);
    query.equalTo("isActive", true);
    
    // Get all active wallet configurations
    const activeWallets = await query.find({ useMasterKey: true });
    
    if (activeWallets.length === 0) {
        console.log('No active wallets to monitor');
        return;
    }

    console.log(`Starting Ethereum monitoring for ${activeWallets.length} wallets`);

    for (const walletConfig of activeWallets) {
        const walletAddress = walletConfig.get("walletAddress");
        const className = walletConfig.get("transactionClassName");
        
        // Monitor historical transactions for each wallet
        try {
            console.log(`Fetching historical transactions for ${walletAddress}...`);
            const incomingEth = await alchemy.core.getAssetTransfers({
                fromBlock: "0x0",
                toBlock: "latest",
                toAddress: walletAddress,
                category: ["external", "internal"],
            });

            const incomingUsdt = await alchemy.core.getAssetTransfers({
                fromBlock: "0x0",
                toBlock: "latest",
                toAddress: walletAddress,
                contractAddresses: [USDT_ADDRESS],
                category: ["erc20"],
            });

            // Process historical transactions
            for (const tx of incomingEth.transfers) {
                await processTransaction('ETH', tx, true, null, className);
            }

            for (const tx of incomingUsdt.transfers) {
                await processTransaction('USDT', tx, true, null, className);
            }
        } catch (error) {
            console.error(`Error processing historical transactions for ${walletAddress}:`, error);
        }
    }

    console.log('Historical transaction processing completed');
    console.log('Webhook endpoint ready at /webhook/transactions');
}

// Update processTransaction to ensure wallet address is correctly passed
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

        if (isHistorical) {
            if (tx.metadata && tx.metadata.blockTimestamp) {
                timestamp = new Date(tx.metadata.blockTimestamp);
            } else if (block) {
                timestamp = new Date(block.timestamp * 1000);
            } else {
                const txBlock = await bnbProvider.getBlock(tx.blockNum);
                timestamp = new Date(txBlock.timestamp * 1000);
            }
            
            blockNumber = tx.blockNum;
            
            if (type === 'BNB') {
                const bnbPrice = await getBNBPrice(blockNumber);
                // Value is already in BNB, just multiply by price
                amountInUSD = tx.value * bnbPrice;
            } else {
                amountInUSD = parseFloat(tx.value);
            }
        } else {
            if (block) {
                timestamp = new Date(block.timestamp * 1000);
                blockNumber = block.number;
            } else {
                const txBlock = await bnbProvider.getBlock(tx.blockNumber);
                timestamp = new Date(txBlock.timestamp * 1000);
                blockNumber = txBlock.number;
            }
            
            if (type === 'ETH') {
                const bnbPrice = await getBNBPrice(blockNumber);
                // Value is already in BNB from the webhook, no need to format
                amountInUSD = tx.value * bnbPrice;
                console.log(`BNB Amount: ${tx.value} BNB`);
                console.log(`BNB Price: $${bnbPrice}`);
                console.log(`USD Amount: $${amountInUSD}`);
            } else {
                // Handle other token amounts
                const value = ethers.formatUnits(tx.value, 6); // Adjust decimals based on token
                amountInUSD = parseFloat(value);
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

            const transaction = new Transaction();
            const data = {
                contributor: tx.from.toLowerCase(),
                tokenType: type,
                txHash: tx.hash,
                blockNumber: blockNumber.toString(),
                timestamp: timestamp,
                amountInUSD: amountInUSD,
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


// Make sure to export the app if you're using it in other files
module.exports = app;