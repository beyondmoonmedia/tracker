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

const { Connection, clusterApiUrl } = require('@solana/web3.js');

const solanaConnection = new Connection(clusterApiUrl('mainnet-beta'));
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

// 🔥 Helper to get live SOL price from CoinGecko
async function getLiveSOLPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'solana',
                vs_currencies: 'usd'
            }
        });
        return res.data.solana.usd || 20;
    } catch (err) {
        console.error("Error fetching SOL price from CoinGecko:", err);
        return 20;
    }
}

// 🔥 Helper to get block timestamp
async function getSolBlockTime(slot) {
    try {
        const blockTime = await solanaConnection.getBlockTime(slot);
        if (blockTime) return new Date(blockTime * 1000);
    } catch (err) {
        console.error(`Error fetching block time for slot ${slot}:`, err);
    }
    return new Date();
}


// Add these new functions after the constants
async function setupWalletConfig(walletAddress, network, projectName = null) {
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
    if (projectName) {
        query.equalTo("projectName", projectName);
    }
    let config = await query.first({ useMasterKey: true });
    console.log(walletClassName)
    if (!config) {
        // Create new wallet config
        config = new WalletConfig();
        const configData = {
            walletAddress: walletAddress.toLowerCase(),
            transactionClassName: walletClassName,
            network: net,
            isActive: true
        };
        
        if (projectName) {
            configData.projectName = projectName;
        }
        
        await config.save(configData, { useMasterKey: true });

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
                .addNumber('marketCap')
                .addString('projectName')
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
async function addPricePeriod(walletAddress, price, startDate, endDate, projectName = null) {
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const price_entry = new TokenPrice();

    // Validate and format dates
    const formattedStartDate = validateISODate(startDate);
    const formattedEndDate = validateISODate(endDate);

    console.log(`\nAdding new price period for wallet ${walletAddress}:`);
    console.log(`Price: $${price}`);
    console.log(`Project: ${projectName || 'Default'}`);
    console.log(`Start Date: ${formattedStartDate}`);
    console.log(`End Date: ${formattedEndDate}`);

    try {
        const priceData = {
            walletAddress: walletAddress.toLowerCase(),
            price: price,
            startDate: new Date(formattedStartDate),
            endDate: new Date(formattedEndDate)
        };
        
        if (projectName) {
            priceData.projectName = projectName;
        }
        
        await price_entry.save(priceData, { useMasterKey: true });

        console.log('Price period added successfully');
        return price_entry;
    } catch (error) {
        console.error('Error adding price period:', error);
        throw error;
    }
}

async function addBonusPeriod(walletAddress, bonusPercentage, startDate, endDate, projectName = null) {
    const TokenBonus = Parse.Object.extend("TokenBonus");
    const bonus_entry = new TokenBonus();

    // Validate and format dates
    const formattedStartDate = validateISODate(startDate);
    const formattedEndDate = validateISODate(endDate);

    console.log(`\nAdding new bonus period for wallet ${walletAddress}:`);
    console.log(`Bonus: ${bonusPercentage * 100}%`);
    console.log(`Project: ${projectName || 'Default'}`);
    console.log(`Start Date: ${formattedStartDate}`);
    console.log(`End Date: ${formattedEndDate}`);

    try {
        const bonusData = {
            walletAddress: walletAddress.toLowerCase(),
            bonusPercentage: bonusPercentage,
            startDate: new Date(formattedStartDate),
            endDate: new Date(formattedEndDate)
        };
        
        if (projectName) {
            bonusData.projectName = projectName;
        }
        
        await bonus_entry.save(bonusData, { useMasterKey: true });

        console.log('Bonus period added successfully');
        return bonus_entry;
    } catch (error) {
        console.error('Error adding bonus period:', error);
        throw error;
    }
}

// Update setupWalletPricingAndBonus to accept date ranges and project
async function setupWalletPricingAndBonus(walletAddress, initialPrice, initialBonus = 0, startDate, endDate, projectName = null) {
    console.log(`\nSetting up pricing and bonus for wallet ${walletAddress}`);
    console.log(`Initial price: $${initialPrice}`);
    console.log(`Initial bonus: ${initialBonus * 100}%`);
    console.log(`Project: ${projectName || 'Default'}`);

    await addPricePeriod(walletAddress, initialPrice, startDate, endDate, projectName);
    await addBonusPeriod(walletAddress, initialBonus, startDate, endDate, projectName);

    // Verify the setup
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const TokenBonus = Parse.Object.extend("TokenBonus");

    const priceQuery = new Parse.Query(TokenPrice)
        .equalTo("walletAddress", walletAddress.toLowerCase());
    if (projectName) {
        priceQuery.equalTo("projectName", projectName);
    }
    const savedPrice = await priceQuery.first({ useMasterKey: true });
    
    const bonusQuery = new Parse.Query(TokenBonus)
        .equalTo("walletAddress", walletAddress.toLowerCase());
    if (projectName) {
        bonusQuery.equalTo("projectName", projectName);
    }
    const savedBonus = await bonusQuery.first({ useMasterKey: true });

    console.log('\nVerifying setup:');
    console.log(`Saved price: $${savedPrice.get("price")}`);
    console.log(`Saved bonus: ${savedBonus.get("bonusPercentage") * 100}%`);
    console.log(`Price period: ${savedPrice.get("startDate").toISOString()}`);
    console.log(`Bonus period: ${savedBonus.get("startDate").toISOString()}`);
}

// Update setupWalletTracking to accept date ranges and project
async function setupWalletTracking(walletAddress, network, initialPrice, initialBonus, startDate, endDate, projectName = null) {
    try {
        console.log(`\nSetting up wallet tracking for ${walletAddress}`);
        console.log(`Initial price: $${initialPrice}`);
        console.log(`Initial bonus: ${initialBonus * 100}%`);
        console.log(`Project: ${projectName || 'Default'}`);

        const config = await setupWalletConfig(walletAddress.toLowerCase(), network, projectName);
        await setupWalletPricingAndBonus(walletAddress.toLowerCase(), initialPrice, initialBonus, startDate, endDate, projectName);

        // Verify the setup worked
        const TokenPrice = Parse.Object.extend("TokenPrice");
        const TokenBonus = Parse.Object.extend("TokenBonus");

        const priceQuery = new Parse.Query(TokenPrice)
            .equalTo("walletAddress", walletAddress.toLowerCase());
        if (projectName) {
            priceQuery.equalTo("projectName", projectName);
        }
        const priceCheck = await priceQuery.first({ useMasterKey: true });
        
        const bonusQuery = new Parse.Query(TokenBonus)
            .equalTo("walletAddress", walletAddress.toLowerCase());
        if (projectName) {
            bonusQuery.equalTo("projectName", projectName);
        }
        const bonusCheck = await bonusQuery.first({ useMasterKey: true });

        console.log('\nVerifying wallet setup:');
        console.log(`Price setup: ${priceCheck ? 'Success' : 'Failed'}`);
        console.log(`Bonus setup: ${bonusCheck ? 'Success' : 'Failed'}`);


        return config;
    } catch (error) {
        console.error('Error in setupWalletTracking:', error);
        throw error;
    }
}

// Enhanced function to get token price and market cap with automatic tier progression
async function getTokenPriceForTimestamp(timestamp, walletAddress, projectName = null) {
    console.log(`\n🔍 === PRICE CALCULATION DEBUG START ===`);
    console.log(`📝 Wallet Address: ${walletAddress}`);
    console.log(`📝 Project Name: ${projectName || 'All Projects'}`);
    console.log(`📝 Timestamp: ${timestamp || 'N/A (not used)'}`);
    
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const query = new Parse.Query(TokenPrice);

    query.equalTo("walletAddress", walletAddress.toLowerCase());
    if (projectName) {
        query.equalTo("projectName", projectName);
    }
    query.ascending("marketCap"); // Order by market cap ascending

    console.log(`🔍 Querying TokenPrice for wallet: ${walletAddress.toLowerCase()}, project: ${projectName || 'All'}`);

    const pricePeriods = await query.find({ useMasterKey: true });

    if (!pricePeriods || pricePeriods.length === 0) {
        console.log(`❌ No price periods found for wallet ${walletAddress}${projectName ? ` and project ${projectName}` : ''}`);
        return { price: 0, marketCap: 0 };
    }

    console.log(`✅ Found ${pricePeriods.length} price periods:`);
    pricePeriods.forEach((period, index) => {
        console.log(`  📊 ${index + 1}. Price: $${period.get("price")}, Market Cap: $${period.get("marketCap")}, Project: ${period.get("projectName")}`);
    });

    // Calculate total amountInUSD for this wallet and project
    console.log(`\n💰 === CALCULATING TOTAL AMOUNT ===`);
    const totalAmountInUSD = await calculateTotalAmountInUSD(walletAddress, projectName);
    console.log(`💰 Total amountInUSD for wallet ${walletAddress}${projectName ? ` and project ${projectName}` : ''}: $${totalAmountInUSD}`);

    // Find the appropriate price tier based on total amount
    let selectedPricePeriod = null;

    // Sort price periods by market cap ascending to ensure proper tier selection
    pricePeriods.sort((a, b) => a.get("marketCap") - b.get("marketCap"));

    console.log(`\n📈 === TIER SELECTION PROCESS ===`);
    console.log(`📈 Sorted price periods by market cap:`);
    pricePeriods.forEach((period, index) => {
        console.log(`  📊 ${index + 1}. Price: $${period.get("price")}, Market Cap: $${period.get("marketCap")}`);
    });

    // Find the LOWEST tier where total amount is still within the market cap
    console.log(`\n🎯 === SELECTING APPROPRIATE TIER ===`);
    for (let i = 0; i < pricePeriods.length; i++) {
        const pricePeriod = pricePeriods[i];
        const marketCap = pricePeriod.get("marketCap");
        
        console.log(`🎯 Checking tier ${i + 1}: Market Cap $${marketCap}`);
        
        if (totalAmountInUSD < marketCap) {
            selectedPricePeriod = pricePeriod;
            console.log(`✅ SELECTED TIER: Total $${totalAmountInUSD} < Market Cap $${marketCap}`);
            console.log(`✅ Selected Price: $${pricePeriod.get("price")}`);
            break;
        } else {
            console.log(`❌ Skipping tier: Total $${totalAmountInUSD} >= Market Cap $${marketCap}`);
        }
    }
    
    // If no tier found (total amount exceeds all market caps), use the highest tier
    if (!selectedPricePeriod) {
        selectedPricePeriod = pricePeriods[pricePeriods.length - 1];
        console.log(`⚠️ Using highest tier: Total $${totalAmountInUSD} exceeds all market caps`);
    }

    const price = selectedPricePeriod.get("price");
    const marketCap = selectedPricePeriod.get("marketCap");
    
    console.log(`\n🎉 === FINAL RESULT ===`);
    console.log(`🎉 Selected price tier:`);
    console.log(`🎉 - Price: $${price}`);
    console.log(`🎉 - Market Cap: $${marketCap}`);
    console.log(`🎉 - Total Amount: $${totalAmountInUSD}`);
    console.log(`🔍 === PRICE CALCULATION DEBUG END ===\n`);

    return { price, marketCap };
}

// Function to calculate total amountInUSD for a wallet and project
async function calculateTotalAmountInUSD(walletAddress, projectName = null) {
    try {
        console.log(`\n💰 === CALCULATING TOTAL AMOUNT START ===`);
        console.log(`💰 Wallet Address: ${walletAddress}`);
        console.log(`💰 Project Name: ${projectName || 'All Projects'}`);
        
        // Normalize wallet address (remove 0x prefix if present)
        const normalizedAddress = walletAddress.toLowerCase().replace(/^0x/, '');
        console.log(`💰 Normalized address: ${normalizedAddress}`);
        
        let totalAmount = 0;
        
        // Define the transaction classes to check based on the wallet address
        const transactionClasses = [
            `Transaction_${normalizedAddress.substring(0, 6)}_BSC`,
            `Transaction_${normalizedAddress.substring(0, 6)}_ETH`,
            `Transaction_MZFrKi_SOL` // SOL handler as specified
        ];
        
        console.log(`💰 Checking transaction classes: ${transactionClasses.join(', ')}`);
        
        for (const className of transactionClasses) {
            console.log(`\n🔍 Checking class: ${className}`);
            try {
                const Transaction = Parse.Object.extend(className);
                const query = new Parse.Query(Transaction);
                
                // Query by walletAddress field - try both with and without 0x prefix
                query.equalTo("walletAddress", walletAddress.toLowerCase());
                
                // Add project filtering if specified
                if (projectName) {
                    query.equalTo("projectName", projectName);
                }
                
                const transactions = await query.find({ useMasterKey: true });
                
                console.log(`🔍 Found ${transactions.length} transactions in ${className} for address: ${walletAddress.toLowerCase()}${projectName ? ` and project: ${projectName}` : ''}`);
                
                for (const transaction of transactions) {
                    const amountInUSD = transaction.get("amountInUSD") || 0;
                    totalAmount += amountInUSD;
                    console.log(`  💵 Transaction ${transaction.id}: $${amountInUSD}${projectName ? ` (Project: ${transaction.get("projectName") || 'N/A'})` : ''}`);
                }
                
                // Also try querying with 0x prefix if no transactions found
                if (transactions.length === 0 && !walletAddress.startsWith('0x')) {
                    console.log(`🔍 Trying with 0x prefix for ${className}...`);
                    const queryWithPrefix = new Parse.Query(Transaction);
                    queryWithPrefix.equalTo("walletAddress", `0x${walletAddress.toLowerCase()}`);
                    
                    // Add project filtering if specified
                    if (projectName) {
                        queryWithPrefix.equalTo("projectName", projectName);
                    }
                    
                    const transactionsWithPrefix = await queryWithPrefix.find({ useMasterKey: true });
                    
                    console.log(`🔍 Found ${transactionsWithPrefix.length} transactions with 0x prefix in ${className}`);
                    
                    for (const transaction of transactionsWithPrefix) {
                        const amountInUSD = transaction.get("amountInUSD") || 0;
                        totalAmount += amountInUSD;
                        console.log(`  💵 Transaction ${transaction.id}: $${amountInUSD}${projectName ? ` (Project: ${transaction.get("projectName") || 'N/A'})` : ''}`);
                    }
                }
            } catch (classError) {
                console.log(`❌ Class ${className} not found or error: ${classError.message}`);
                // Continue with other classes even if one fails
            }
        }
        
        console.log(`\n💰 === CALCULATING TOTAL AMOUNT END ===`);
        console.log(`💰 Total amountInUSD for ${walletAddress}${projectName ? ` and project ${projectName}` : ''}: $${totalAmount}`);
        console.log(`💰 === CALCULATING TOTAL AMOUNT END ===\n`);
        
        return totalAmount;
    } catch (error) {
        console.error("❌ Error calculating total amountInUSD:", error);
        return 0;
    }
}

// Replace the existing getBonusForTimestamp function
async function getBonusForTimestamp(timestamp, walletAddress, projectName = null) {
    const TokenBonus = Parse.Object.extend("TokenBonus");
    const query = new Parse.Query(TokenBonus);

    const txDate = timestamp instanceof Date ? timestamp : new Date(timestamp);

    query.lessThanOrEqualTo("startDate", txDate);
    query.greaterThanOrEqualTo("endDate", txDate);
    query.equalTo("walletAddress", walletAddress.toLowerCase());
    
    if (projectName) {
        query.equalTo("projectName", projectName);
    }

    console.log(`\nLooking up bonus for wallet ${walletAddress}${projectName ? ` and project ${projectName}` : ''} at ${txDate}`);

    try {
        const bonusPeriod = await query.first({ useMasterKey: true });

        if (!bonusPeriod) {
            console.log(`No bonus period found for wallet ${walletAddress}${projectName ? ` and project ${projectName}` : ''} at timestamp ${txDate}`);
            return 0;
        }

        const bonus = bonusPeriod.get("bonusPercentage");
        console.log(`Found bonus period: ${bonus * 100}% for ${txDate}${projectName ? ` (Project: ${projectName})` : ''}`);
        return bonus;
    } catch (error) {
        console.error("Error getting bonus period:", error);
        return 0;
    }
}

// Replace the existing calculateTokenRewards function
async function calculateTokenRewards(usdAmount, walletAddress, projectName = null) {
    try {
        console.log('\n🎁 === TOKEN REWARD CALCULATION START ===');
        console.log(`🎁 USD Amount: $${usdAmount}`);
        console.log(`🎁 Wallet Address: ${walletAddress}`);
        console.log(`🎁 Project Name: ${projectName || 'All Projects'}`);

        const priceData = await getTokenPriceForTimestamp(null, walletAddress, projectName);
        const tokenPrice = priceData.price;
        const marketCap = priceData.marketCap;
        const bonusPercentage = await getBonusForTimestamp(new Date(), walletAddress, projectName);

        console.log(`🎁 Retrieved price data:`);
        console.log(`🎁 - Token Price: $${tokenPrice}`);
        console.log(`🎁 - Market Cap: $${marketCap}`);
        console.log(`🎁 - Bonus Percentage: ${bonusPercentage * 100}%`);

        if (tokenPrice === 0) {
            console.log('❌ No token price available - 0 tokens awarded');
            return { baseTokens: 0, bonusTokens: 0, totalTokens: 0, price: 0, marketCap: 0 };
        }

        const baseTokens = parseFloat((usdAmount / tokenPrice).toFixed(4));
        const bonusTokens = parseFloat((baseTokens * bonusPercentage).toFixed(4));
        const totalTokens = parseFloat((baseTokens + bonusTokens).toFixed(4));

        console.log(`🎁 Token calculations:`);
        console.log(`🎁 - Base Tokens: ${baseTokens}`);
        console.log(`🎁 - Bonus Tokens: ${bonusTokens}`);
        console.log(`🎁 - Total Tokens: ${totalTokens}`);
        console.log(`🎁 === TOKEN REWARD CALCULATION END ===\n`);

        return { baseTokens, bonusTokens, totalTokens, price: tokenPrice, marketCap };
    } catch (error) {
        console.error("❌ Error calculating token rewards:", error);
        return { baseTokens: 0, bonusTokens: 0, totalTokens: 0, price: 0, marketCap: 0 };
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
    const { walletAddress, newBonus, startDate, endDate, projectName } = req.body;

    if (!walletAddress || !newBonus || !startDate || !endDate) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const result = await updateBonus(walletAddress, newBonus, startDate, endDate, projectName);
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

// Add endpoint for updating price and market cap
app.post('/api/update-price', async (req, res) => {
    const { walletAddress, price, marketCap, projectName } = req.body;

    if (!walletAddress || !price || !marketCap || !projectName) {
        return res.status(400).json({ success: false, error: "Missing required fields: walletAddress, price, marketCap, projectName" });
    }

    try {
        // Create new price entry
        const TokenPrice = Parse.Object.extend("TokenPrice");
        const priceEntry = new TokenPrice();
        
        await priceEntry.save({
            walletAddress: walletAddress.toLowerCase(),
            projectName: projectName,
            price: parseFloat(price),
            marketCap: parseFloat(marketCap)
        }, { useMasterKey: true });

        res.json({ success: true, message: 'Price updated successfully', priceEntry });
    } catch (error) {
        console.error('Error updating price:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add endpoint for getting current price
app.get('/api/current-price/:walletAddress', async (req, res) => {
    try {
        const { walletAddress } = req.params;
        const { projectName } = req.query;
        const priceData = await getTokenPriceForTimestamp(null, walletAddress, projectName);
        
        res.json({
            success: true,
            walletAddress,
            projectName: projectName || 'All Projects',
            price: priceData.price,
            marketCap: priceData.marketCap
        });
    } catch (error) {
        console.error('Error fetching current price:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add endpoint for getting price history
app.get('/api/price-history/:walletAddress', async (req, res) => {
    try {
        const { walletAddress } = req.params;
        const { projectName } = req.query;
        const query = new Parse.Query("TokenPrice");
        query.equalTo("walletAddress", walletAddress.toLowerCase());
        if (projectName) {
            query.equalTo("projectName", projectName);
        }
        query.ascending("marketCap");
        const results = await query.find({ useMasterKey: true });
        
        const priceHistory = results.map(price => ({
            id: price.id,
            price: price.get("price"),
            marketCap: price.get("marketCap"),
            projectName: price.get("projectName"),
            createdAt: price.get("createdAt")
        }));

        res.json({ 
            success: true, 
            walletAddress,
            projectName: projectName || 'All Projects',
            priceHistory 
        });
    } catch (error) {
        console.error('Error fetching price history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
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
// ✅ Main SOL transaction processor
async function processTransactionSOL(tx, className, projectName = null) {
    try {
        let blockNumber = tx.slot || 0;

        // ✅ Forcing timestamp to NOW for stable bonus & price lookups
        const timestamp = new Date();

        const solPrice = await getLiveSOLPrice();

        // ✅ Find max positive balance delta
        let maxDiffInSOL = 0;
        let walletIndex = -1;

        for (let i = 0; i < tx.preBalances.length; i++) {
            const pre = tx.preBalances[i];
            const post = tx.postBalances[i];
            const diffInSOL = (post - pre) / 1e9;

            console.log(`Balance delta index ${i}: ${diffInSOL} SOL (pre: ${pre}, post: ${post})`);

            if (diffInSOL > maxDiffInSOL) {
                maxDiffInSOL = diffInSOL;
                walletIndex = i;
            }
        }

        const amountInUSD = maxDiffInSOL * solPrice;

        console.log(`\nProcessing SOL transaction:`);
        console.log(`Signature: ${tx.signature}`);
        console.log(`Slot: ${tx.slot}`);
        console.log(`Detected max SOL received: ${maxDiffInSOL} SOL ~ $${amountInUSD}`);
        console.log(`Live SOL price: $${solPrice}`);
        console.log(`Tracked wallet (by index): ${walletIndex}`);
        console.log(`Block timestamp (forced now): ${timestamp}`);

        // ✅ Check if transaction already exists
        const Transaction = Parse.Object.extend(className);
        const query = new Parse.Query(Transaction);
        query.equalTo("txHash", tx.signature);
        const exists = await query.first({ useMasterKey: true });

        if (exists) {
            console.log(`Transaction ${tx.signature} already exists in ${className}`);
            return;
        }

        if (amountInUSD > 0) {
            console.log(`\n🚀 === PROCESSING SOL TRANSACTION ===`);
            console.log(`🚀 Amount in USD: $${amountInUSD}`);
            console.log(`🚀 Wallet Address: ${tx.walletAddress.toLowerCase()}`);
            
            const tokenRewards = await calculateTokenRewards(amountInUSD, tx.walletAddress.toLowerCase(), projectName);
            const bonusPercentage = await getBonusForTimestamp(timestamp, tx.walletAddress.toLowerCase());

            console.log(`\n🚀 === SOL TRANSACTION FINAL DETAILS ===`);
            console.log(`🚀 Token Price: $${tokenRewards.price}`);
            console.log(`🚀 Market Cap: $${tokenRewards.marketCap}`);
            console.log(`🚀 Bonus Percentage: ${bonusPercentage * 100}%`);
            console.log(`🚀 Base Tokens: ${tokenRewards.baseTokens}`);
            console.log(`🚀 Bonus Tokens: ${tokenRewards.bonusTokens}`);
            console.log(`🚀 Total Tokens: ${tokenRewards.totalTokens}`);
            console.log(`🚀 === SOL TRANSACTION FINAL DETAILS END ===\n`);

            // ✅ Save to Parse
            const transaction = new Transaction();
            const data = {
                contributor: tx.walletAddress.toLowerCase(),
                tokenType: "SOL",
                txHash: tx.signature,
                blockNumber: blockNumber.toString(),
                timestamp: timestamp,
                amountInUSD: amountInUSD,
                amountInToken: maxDiffInSOL,
                tokenPrice: tokenRewards.price,
                marketCap: tokenRewards.marketCap,
                projectName: projectName,
                bonusPercentage: bonusPercentage,
                hasBonus: bonusPercentage > 0,
                baseTokens: tokenRewards.baseTokens,
                bonusTokens: tokenRewards.bonusTokens,
                tokenAwarded: tokenRewards.totalTokens,
                walletAddress: tx.walletAddress.toLowerCase()
            };

            await transaction.save(data, { useMasterKey: true });
            console.log(`✅ SOL transaction saved successfully: ${tx.signature}`);
        } else {
            console.log(`No SOL received (amountInUSD <= 0), transaction skipped.`);
        }
    } catch (error) {
        console.error("\n❌ Error processing SOL transaction:", error);
        console.error("Transaction details:", {
            signature: tx.signature,
            slot: tx.slot,
            fee: tx.fee,
            walletAddress: tx.walletAddress
        });
    }
}



// Update processTransaction to ensure wallet address is correctly passed
async function processTransaction(type, tx, isHistorical = false, block = null, className, networks, projectName = null) {
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
            else if (type === "USDT")
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
            else if (type === "USDT")
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

        console.log(`\n🚀 === PROCESSING ${type} TRANSACTION ===`);
        console.log(`🚀 Transaction Hash: ${tx.hash}`);
        console.log(`🚀 Amount in USD: $${amountInUSD}`);
        console.log(`🚀 Timestamp: ${timestamp}`);
        console.log(`🚀 Wallet Address: ${fullWalletAddress}`);

        // Calculate token rewards with the full wallet address
        tokenRewards = await calculateTokenRewards(amountInUSD, fullWalletAddress, projectName);
        
        console.log(`\n🚀 === ${type} TRANSACTION FINAL DETAILS ===`);
        console.log(`🚀 Token Price: $${tokenRewards.price}`);
        console.log(`🚀 Market Cap: $${tokenRewards.marketCap}`);
        console.log(`🚀 Base Tokens: ${tokenRewards.baseTokens}`);
        console.log(`🚀 Bonus Tokens: ${tokenRewards.bonusTokens}`);
        console.log(`🚀 Total Tokens: ${tokenRewards.totalTokens}`);
        console.log(`🚀 === ${type} TRANSACTION FINAL DETAILS END ===\n`);

        // Save transaction if USD amount is valid
        if (amountInUSD > 0) {
            const bonusPercentage = await getBonusForTimestamp(timestamp, fullWalletAddress);

            console.log('\nFinal Transaction Details:');
            console.log(`Token Price: $${tokenRewards.price}`);
            console.log(`Market Cap: $${tokenRewards.marketCap}`);
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
                tokenPrice: tokenRewards.price,
                marketCap: tokenRewards.marketCap,
                projectName: projectName,
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
async function updatePrice(walletAddress, newPrice, startDate, endDate, projectName = null) {
    try {
        const formattedStartDate = validateISODate(startDate);
        const now = new Date();

        if (new Date(formattedStartDate) < now) {
            throw new Error("Cannot update price for past periods");
        }

        await addPricePeriod(walletAddress, newPrice, startDate, endDate, projectName);
        console.log('Price updated successfully');
    } catch (error) {
        console.error('Error updating price:', error);
        throw error;
    }
}

// Add a function to update bonus for future periods
async function updateBonus(walletAddress, newBonus, startDate, endDate, projectName = null) {
    try {
        const formattedStartDate = validateISODate(startDate);
        const now = new Date();

        if (new Date(formattedStartDate) < now) {
            throw new Error("Cannot update bonus for past periods");
        }

        await addBonusPeriod(walletAddress, newBonus, startDate, endDate, projectName);
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
    const { walletAddress, network, initialPrice, initialBonus, startDate, endDate, projectName } = req.body;

    try {
        // Call the setupWalletTracking function with the provided parameters
        const config = await setupWalletTracking(walletAddress, network, initialPrice, initialBonus, startDate, endDate, projectName);
        res.status(200).json({ message: 'Wallet tracking setup successfully', config });
    } catch (error) {
        console.error('Error in setupWalletTracking:', error);
        res.status(500).json({ error: 'Failed to setup wallet tracking' });
    }
    console.log("visited")
});

// Debug endpoint to test price calculation
app.get('/api/debug-price/:walletAddress', async (req, res) => {
    try {
        const { walletAddress } = req.params;
        const { projectName } = req.query;
        console.log(`\n=== DEBUG PRICE CALCULATION FOR ${walletAddress}${projectName ? ` (Project: ${projectName})` : ''} ===`);
        
        const priceData = await getTokenPriceForTimestamp(null, walletAddress, projectName);
        const totalAmount = await calculateTotalAmountInUSD(walletAddress, projectName);
        
        res.json({
            walletAddress,
            projectName: projectName || 'All Projects',
            totalAmountInUSD: totalAmount,
            selectedPrice: priceData.price,
            selectedMarketCap: priceData.marketCap
        });
    } catch (error) {
        console.error('Error in debug price calculation:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enhanced debug endpoint with detailed logging
app.get('/api/debug-detailed/:walletAddress', async (req, res) => {
    try {
        const { walletAddress } = req.params;
        const { projectName } = req.query;
        
        console.log(`\n🔍 === DETAILED DEBUG START ===`);
        console.log(`🔍 Wallet Address: ${walletAddress}`);
        console.log(`🔍 Project Name: ${projectName || 'All Projects'}`);
        
        // Test TokenPrice query
        const TokenPrice = Parse.Object.extend("TokenPrice");
        const query = new Parse.Query(TokenPrice);
        query.equalTo("walletAddress", walletAddress.toLowerCase());
        if (projectName) {
            query.equalTo("projectName", projectName);
        }
        query.ascending("marketCap");
        
        const pricePeriods = await query.find({ useMasterKey: true });
        console.log(`🔍 Found ${pricePeriods.length} price periods`);
        
        // Test transaction calculation
        const totalAmount = await calculateTotalAmountInUSD(walletAddress, projectName);
        console.log(`🔍 Total amount calculated: $${totalAmount}`);
        
        // Test price selection
        const result = await getTokenPriceForTimestamp(null, walletAddress, projectName);
        
        console.log(`🔍 === DETAILED DEBUG END ===\n`);
        
        res.json({
            success: true,
            walletAddress,
            projectName: projectName || 'All Projects',
            pricePeriods: pricePeriods.map(p => ({
                price: p.get("price"),
                marketCap: p.get("marketCap"),
                projectName: p.get("projectName")
            })),
            totalAmount,
            selectedResult: result
        });
    } catch (error) {
        console.error('Detailed debug error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Make sure to export the app if you're using it in other files
module.exports = app;