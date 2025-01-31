const express = require('express');
const { default: ParseServer } = require('parse-server');
const ParseDashboard = require('parse-dashboard');
const { Alchemy, Network } = require('alchemy-sdk');
const axios = require('axios');
const { ethers } = require('ethers');
require('dotenv').config();

// Constants
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'; // BSC USDT (USDT-BSC)
const CHAINLINK_BNB_USD_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE'; // BNB/USD price feed on BSC
const TOKEN_PRICE_USD = 0.013; // Price per token in USD
// Express and Parse Server setup
const app = express();
const config = {
  databaseURI: process.env.MONGODB_URI || 'mongodb://localhost:27017/dev',
  appId: process.env.PARSE_APP_ID || 'myAppId',
  masterKey: process.env.PARSE_MASTER_KEY || 'myMasterKey',
  serverURL: process.env.PARSE_SERVER_URL || 'http://localhost:1337/parse',
  publicServerURL: process.env.PARSE_SERVER_URL || 'http://localhost:1337/parse',
  allowClientClassCreation: false,
  allowExpiredAuthDataToken: false
};

// Cache for ETH price
let ethPriceCache = { price: 0, lastUpdate: 0 };
const PRICE_CACHE_DURATION = 60 * 1000; // 1 minute

// Update provider initialization
const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org/');

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

// Initialize Chainlink price feed contract
const priceFeed = new ethers.Contract(
    CHAINLINK_BNB_USD_FEED,
    aggregatorV3InterfaceABI,
    provider
);

// Replace getETHPrice function with this one
async function getBNBPrice(blockNumber) {
    try {
        const priceFeed = new ethers.Contract(
            CHAINLINK_BNB_USD_FEED,
            aggregatorV3InterfaceABI,
            provider
        );
        
        const price = await priceFeed.latestRoundData({ blockTag: blockNumber });
        return Number(price.answer) / 1e8; // Chainlink prices have 8 decimals
    } catch (error) {
        console.error("Error getting price from Chainlink:", error);
        // Fallback to Binance price
        try {
            const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
            return parseFloat(response.data.price);
        } catch (fallbackError) {
            console.error('Error fetching BNB price from fallback:', fallbackError);
            return 0;
        }
    }
}

// Update getTokenPriceForTimestamp to return 0 when no price is found
async function getTokenPriceForTimestamp(timestamp) {
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const query = new Parse.Query(TokenPrice);
    
    // Convert timestamp to Date if it's not already
    const txDate = timestamp instanceof Date ? timestamp : new Date(timestamp);
    
    // Find price period that contains this timestamp
    query.greaterThanOrEqualTo("endDate", txDate);
    query.lessThanOrEqualTo("startDate", txDate);
    
    const pricePeriod = await query.first({ useMasterKey: true });
    
    if (!pricePeriod) {
        console.log(`No price period found for timestamp ${txDate}, tokens will not be awarded`);
        return 0; // Return 0 instead of default price
    }
    
    return pricePeriod.get("price");
}

// Fix getBonusForTimestamp function
async function getBonusForTimestamp(timestamp) {
    const TokenBonus = Parse.Object.extend("TokenBonus");
    const query = new Parse.Query(TokenBonus);
    
    // Convert timestamp to Date if it's not already
    const txDate = timestamp instanceof Date ? timestamp : new Date(timestamp);
    
    // Find bonus period that contains this timestamp
    query.lessThanOrEqualTo("startDate", txDate);
    query.greaterThanOrEqualTo("endDate", txDate);
    
    try {
        const bonusPeriod = await query.first({ useMasterKey: true });
        
        if (!bonusPeriod) {
            console.log(`No bonus period found for timestamp ${txDate}`);
            return 0; // No bonus
        }
        
        console.log(`Found bonus period: ${bonusPeriod.get("bonusPercentage") * 100}% for ${txDate}`);
        return bonusPeriod.get("bonusPercentage");
    } catch (error) {
        console.error("Error getting bonus period:", error);
        return 0;
    }
}

// Update calculateTokenRewards with better logging and error handling
async function calculateTokenRewards(usdAmount, timestamp) {
    try {
        const tokenPrice = await getTokenPriceForTimestamp(timestamp);
        const bonusPercentage = await getBonusForTimestamp(timestamp);
        
        console.log('\nCalculating Token Rewards:');
        console.log(`Input USD Amount: $${usdAmount}`);
        console.log(`Token Price for ${new Date(timestamp)}: $${tokenPrice}`);
        console.log(`Bonus Percentage: ${bonusPercentage * 100}%`);
        
        // If price is 0, return 0 tokens
        if (tokenPrice === 0) {
            console.log('No token price available for this period - 0 tokens awarded\n');
            return { baseTokens: 0, bonusTokens: 0, totalTokens: 0 };
        }
        
        // Calculate base tokens
        const baseTokens = parseFloat((usdAmount / tokenPrice).toFixed(4));
        console.log(`Base tokens calculation: $${usdAmount} / $${tokenPrice} = ${baseTokens}`);
        
        // Calculate bonus tokens
        const bonusTokens = parseFloat((baseTokens * bonusPercentage).toFixed(4));
        console.log(`Bonus tokens calculation: ${baseTokens} * ${bonusPercentage} = ${bonusTokens}`);
        
        // Calculate total tokens
        const totalTokens = parseFloat((baseTokens + bonusTokens).toFixed(4));
        
        console.log(`Final calculations:`);
        console.log(`- Base tokens: ${baseTokens}`);
        console.log(`- Bonus tokens: ${bonusTokens}`);
        console.log(`- Total tokens: ${totalTokens}\n`);
        
        return { baseTokens, bonusTokens, totalTokens };
    } catch (error) {
        console.error("Error in calculateTokenRewards:", error);
        return { baseTokens: 0, bonusTokens: 0, totalTokens: 0 };
    }
}

// Modify monitorEthereumTransfers function to use BSC
async function monitorEthereumTransfers() {
    const walletAddress = process.env.WALLET_TO_MONITOR?.toLowerCase();
    
    if (!walletAddress) {
        throw new Error('Invalid wallet address provided');
    }

    console.log('Starting BSC monitoring for wallet:', walletAddress);

    try {
        // Instead of using Alchemy, use ethers to listen to new blocks
        provider.on('block', async (blockNumber) => {
            try {
                const block = await provider.getBlock(blockNumber, true);
                
                if (block && block.transactions) {
                    for (const tx of block.transactions) {
                        // Check for direct ETH (BNB) transfers
                        if (tx.to?.toLowerCase() === walletAddress.toLowerCase() && tx.value && tx.value !== '0x0') {
                            console.log("\nNew BNB transaction detected");
                            await processTransaction('BNB', tx, false, block);
                        }
                        
                        // Check for USDT transfers (you'll need to update USDT_ADDRESS to BSC USDT address)
                        if (tx.to?.toLowerCase() === USDT_ADDRESS.toLowerCase() && tx.data.startsWith('0xa9059cbb')) {
                            const recipient = '0x' + tx.data.slice(34, 74);
                            if (recipient.toLowerCase() === walletAddress.toLowerCase()) {
                                console.log("\nNew USDT transaction detected");
                                await processTransaction('USDT', tx, false, block);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Error processing block:', error);
            }
        });

        console.log('Transaction monitoring started successfully');

    } catch (error) {
        console.error('Error in BSC monitoring:', error);
        throw error;
    }
}

async function processTransaction(type, tx, isHistorical = false, block = null) {
    try {
        // Check if transaction already exists
        const Transaction = Parse.Object.extend("BSCTransactions");
        const query = new Parse.Query(Transaction);
        query.equalTo("txHash", tx.hash);
        const exists = await query.count() > 0;
        
        if (exists) {
            console.log(`Transaction ${tx.hash} already exists in database`);
            return;
        }

        // Remove Alchemy references
        if (!block) {
            const blockNumber = tx.blockNumber;
            if (!blockNumber) {
                console.error('No block number found for transaction:', tx.hash);
                return;
            }
            block = await provider.getBlock(blockNumber);
        }

        // Ensure we have a block number
        const blockNumber = block.number || tx.blockNum || tx.blockNumber;
        if (!blockNumber) {
            console.error('Could not determine block number for transaction:', tx.hash);
            return;
        }

        let amountInUSD, tokenRewards;
        const timestamp = new Date(block.timestamp * 1000);
        
        // Get bonus percentage first
        const bonusPercentage = await getBonusForTimestamp(timestamp);
        console.log(`Processing transaction with bonus percentage: ${bonusPercentage * 100}%`);

        if (type === 'BNB') {
            const bnbPrice = await getBNBPrice(blockNumber);
            const bnbValue = isHistorical ? 
                parseFloat(tx.value) : 
                parseFloat(ethers.formatEther(tx.value));
            amountInUSD = parseFloat((bnbValue * bnbPrice).toFixed(6));
            
            console.log('\nBNB Transaction Details:');
            console.log(`BNB Price at block ${blockNumber}: $${bnbPrice.toFixed(6)}`);
            console.log(`BNB Amount: ${bnbValue} BNB`);
            console.log(`USD Amount: $${amountInUSD.toFixed(6)}`);
            console.log(`Timestamp: ${timestamp}`);
            
            tokenRewards = await calculateTokenRewards(amountInUSD, timestamp);
        } else {
            const value = isHistorical ? 
                parseFloat(tx.value) : 
                parseFloat(tx.input.slice(74), 16) / 1e6;
            amountInUSD = parseFloat(value.toFixed(6));
            
            console.log('\nUSDT Transaction Details:');
            console.log(`USDT Amount: ${value} USDT`);
            console.log(`USD Amount: $${amountInUSD.toFixed(6)}`);
            console.log(`Timestamp: ${timestamp}`);
            
            tokenRewards = await calculateTokenRewards(amountInUSD, timestamp);
        }

        // Save transaction if USD amount is valid
        if (amountInUSD > 0) {
            const tokenPrice = await getTokenPriceForTimestamp(timestamp);
            
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
                tokenAwarded: tokenRewards.totalTokens
            };

            const transaction = new Transaction();
            await transaction.save(data, { useMasterKey: true });
            
            console.log(`\nTransaction ${tx.hash} saved to database:`);
            console.log(`- USD Amount: $${amountInUSD.toFixed(6)}`);
            console.log(`- Token Price: $${tokenPrice}`);
            console.log(`- Bonus Percentage: ${bonusPercentage * 100}%`);
            console.log(`- Base Tokens: ${tokenRewards.baseTokens}`);
            console.log(`- Bonus Tokens: ${tokenRewards.bonusTokens}`);
            console.log(`- Total Tokens: ${tokenRewards.totalTokens}`);
            console.log(`- Timestamp: ${timestamp}`);
        } else {
            console.log(`\nTransaction ${tx.hash} skipped:`);
            console.log(`- Invalid USD Amount: $${amountInUSD.toFixed(6)}`);
        }
    } catch (error) {
        console.error("\nError processing transaction:", error);
        console.error("Transaction data:", tx);
        console.error("Block data:", block);
    }
}

// Initialize Parse Server
const parseServer = new ParseServer(config);

// Start the server and blockchain tracking
parseServer.start().then(async () => {
    // Initialize Parse Dashboard
    const dashboard = new ParseDashboard({
        apps: [{
            serverURL: config.serverURL,
            publicServerURL: config.publicServerURL,
            appId: config.appId,
            masterKey: config.masterKey,
            appName: "Blockchain Tracker"
        }],
    }, { allowInsecureHTTP: true });

    // Mount Parse Server and Dashboard
    app.use('/parse', parseServer.app);
    app.use('/dashboard', dashboard);
    app.get('/', (req, res) => res.send('Server is running'));

    // Start the server
    const PORT = process.env.PORT || 1337;
    app.listen(PORT, async () => {
        console.log(`
Server is running!
        `);

        // Start blockchain monitoring
        monitorEthereumTransfers().catch((error) => {
            console.error('Failed to start monitoring:', error);
        });
    });
}).catch(error => {
    console.error('Failed to start server:', error);
});