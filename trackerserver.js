const express = require('express');
const { default: ParseServer } = require('parse-server');
const ParseDashboard = require('parse-dashboard');
const { Alchemy, Network } = require('alchemy-sdk');
const axios = require('axios');
const { ethers } = require('ethers');
require('dotenv').config();

const path = require('path');
const fs = require('fs');
// Constants
const BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'; // BSC USDT
const ETH_USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // Ethereum USDT
const CHAINLINK_BNB_USD_FEED = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE'; // BSC BNB/USD feed
const TOKEN_PRICE_USD = 0.013; // Price per token in USD
// Express and Parse Server setup
const app = express();

// ZeroSSL / Let's Encrypt domain validation (place file in .well-known/pki-validation/)
const wellKnownDir = path.join(__dirname, '.well-known', 'pki-validation');
app.get(/^\/\.well-known\/pki-validation\/([^/]+)\/?$/, (req, res) => {
    const name = (req.path.match(/^\/\.well-known\/pki-validation\/([^/]+)/) || [])[1];
    if (!name || name.includes('..')) return res.status(400).end();
    const filePath = path.join(wellKnownDir, name);
    if (!path.normalize(filePath).startsWith(path.normalize(wellKnownDir))) return res.status(400).end();
    try {
        if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
        const body = fs.readFileSync(filePath, 'utf8');
        res.type('text/plain').send(body);
    } catch (e) {
        res.status(404).send('Not found');
    }
});

app.use(express.json());
const config = {
    databaseURI: process.env.MONGODB_URI || 'mongodb://localhost:27017/dev',
    appId: process.env.PARSE_APP_ID || 'myAppId',
    masterKey: process.env.PARSE_MASTER_KEY || 'myMasterKey',
    serverURL: process.env.PARSE_SERVER_URL || 'http://localhost:1337/parse',
    publicServerURL: process.env.PARSE_SERVER_URL || 'http://localhost:1337/parse',
    allowClientClassCreation: false,
    allowExpiredAuthDataToken: false,
    cloud: path.join(__dirname, '/cloud/main.js'),
    push: { queueOptions: { disablePushWorker: true } },
};

// Initialize Alchemy for Ethereum Mainnet
const alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY,
    network: 56,
    maxRetries: 10
});

// Cache for ETH price
let ethPriceCache = { price: 0, lastUpdate: 0 };
const PRICE_CACHE_DURATION = 60 * 1000; // 1 minute

// Add this after alchemy initialization
const bscProvider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org/');
const ethProvider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || process.env.MAINNET_RPC_URL || 'https://eth.llamarpc.com');

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
    bscProvider
);

// Replace getETHPrice function with this one
async function getBNBPrice(blockNumber) {
    try {
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

async function getETHPrice() {
    const now = Date.now();
    if (ethPriceCache.price > 0 && now - ethPriceCache.lastUpdate < PRICE_CACHE_DURATION) {
        return ethPriceCache.price;
    }
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
        const price = parseFloat(response.data.price);
        if (Number.isFinite(price) && price > 0) {
            ethPriceCache = { price, lastUpdate: now };
            return price;
        }
    } catch (error) {
        console.error('Error fetching ETH price:', error.message || error);
    }
    return ethPriceCache.price || 0;
}

// Add these new functions after the constants
async function setupWalletConfig(walletAddress, network, projectName = null) {
    const WalletConfig = Parse.Object.extend("WalletConfig");

    // Create a unique class name for this wallet (use first 6 hex chars + network)
    const networkShort = network.replace('_MAINNET', '').replace('ETH', 'ETH').replace('BNB', 'BSC');
    const walletClassName = `Transaction_${walletAddress.substring(2, 8)}_${networkShort}`;

    // Check if wallet config exists for this wallet+network (+ projectName if set)
    const query = new Parse.Query(WalletConfig);
    query.equalTo("walletAddress", walletAddress.toLowerCase());
    query.equalTo("network", network);
    if (projectName) query.equalTo("projectName", projectName);
    let config = await query.first({ useMasterKey: true });

    if (!config) {
        // Create new wallet config
        config = new WalletConfig();
        const saveData = {
            walletAddress: walletAddress.toLowerCase(),
            transactionClassName: walletClassName,
            network: network,
            isActive: true
        };
        if (projectName) saveData.projectName = projectName;
        await config.save(saveData, { useMasterKey: true });

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
                throw error;
            }
        }
    } else {
        console.log(`Wallet config already exists for ${walletAddress} (${network}), continuing...`);
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
        queryBSC.ascending("timestamp");

        const queryETH = new Parse.Query(TransactionETH);
        queryETH.equalTo("contributor", refAddress.toLowerCase());
        queryETH.limit(1);
        queryETH.ascending("timestamp");

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
            return { success: false, message: 'Referral address has not contributed yet.' };
        }

        // Calculate the bonus based on the first contribution
        const firstContributionAmount = firstContribution.get("baseTokens");
        console.log(firstContributionAmount)
        const bonusTokens = firstContributionAmount * 0.10;

        // Update total bonus for refAddress if it already exists
        const existingReferralQuery = new Parse.Query(TokenReferral);
        existingReferralQuery.equalTo("refAddress", refAddress.toLowerCase());
        const existingReferral = await existingReferralQuery.first({ useMasterKey: true });

        if (existingReferral) {
            const totalBonusTokens = existingReferral.get("refBonusTokens") + bonusTokens;
            existingReferral.set("refBonusTokens", totalBonusTokens);
            await existingReferral.save(null, { useMasterKey: true });
            console.log(`Updated total bonus for ${refAddress}: ${totalBonusTokens}`);
        } else {
            // Set the referral details for the new entry
            referral_entry.set("contributor", walletAddress.toLowerCase());
            referral_entry.set("refAddress", refAddress.toLowerCase());
            referral_entry.set("refBonusTokens", bonusTokens);
            await referral_entry.save(null, { useMasterKey: true });
            console.log('Referral added successfully with bonus tokens:', bonusTokens);
        }

        // Calculate and add bonus for the walletAddress based on their first transaction
        const walletQueryBSC = new Parse.Query(TransactionBSC);
        walletQueryBSC.equalTo("contributor", walletAddress.toLowerCase());
        walletQueryBSC.limit(1);
        walletQueryBSC.ascending("timestamp");

        const walletQueryETH = new Parse.Query(TransactionETH);
        walletQueryETH.equalTo("contributor", walletAddress.toLowerCase());
        walletQueryETH.limit(1);
        walletQueryETH.ascending("timestamp");

        const [walletBSCContribution, walletETHContribution] = await Promise.all([
            walletQueryBSC.first({ useMasterKey: true }),
            walletQueryETH.first({ useMasterKey: true })
        ]);

        let walletFirstContribution;
        if (walletBSCContribution && walletETHContribution) {
            const walletBscTimestamp = walletBSCContribution.get("timestamp");
            const walletEthTimestamp = walletETHContribution.get("timestamp");
            walletFirstContribution = walletBscTimestamp < walletEthTimestamp ? walletBSCContribution : walletETHContribution;
        } else if (walletBSCContribution) {
            walletFirstContribution = walletBSCContribution;
        } else if (walletETHContribution) {
            walletFirstContribution = walletETHContribution;
        }

        if (walletFirstContribution) {
            const walletFirstContributionAmount = walletFirstContribution.get("tokenAwarded");
            const walletBonusTokens = walletFirstContributionAmount * 0.10;

            // Save the wallet bonus tokens (you can create a new entry or update an existing one)
            const walletReferralEntry = new TokenReferral();
            walletReferralEntry.set("contributor", walletAddress.toLowerCase());
            walletReferralEntry.set("refAddress", walletAddress.toLowerCase());
            walletReferralEntry.set("refBonusTokens", walletBonusTokens);
            await walletReferralEntry.save(null, { useMasterKey: true });
            console.log(`Wallet ${walletAddress} received bonus tokens: ${walletBonusTokens}`);
        }

        return referral_entry;
    } catch (error) {
        console.error('Error updating referral:', error);
        throw error;
    }
}

// Add these new functions for managing price and bonus periods
async function addPricePeriod(walletAddress, price, startDate, endDate, projectName = null, marketCap = null) {
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const price_entry = new TokenPrice();

    // Validate and format dates
    const formattedStartDate = validateISODate(startDate);
    const formattedEndDate = validateISODate(endDate);

    console.log(`\nAdding new price period for wallet ${walletAddress}:`);
    console.log(`Price: $${price}`);
    console.log(`Start Date: ${formattedStartDate}`);
    console.log(`End Date: ${formattedEndDate}`);

    const saveData = {
        walletAddress: walletAddress.toLowerCase(),
        price: price,
        startDate: new Date(formattedStartDate),
        endDate: new Date(formattedEndDate)
    };
    if (projectName) saveData.projectName = projectName;
    if (marketCap != null) saveData.marketCap = marketCap;

    try {
        await price_entry.save(saveData, { useMasterKey: true });

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
    console.log(`Start Date: ${formattedStartDate}`);
    console.log(`End Date: ${formattedEndDate}`);

    const saveData = {
        walletAddress: walletAddress.toLowerCase(),
        bonusPercentage: bonusPercentage,
        startDate: new Date(formattedStartDate),
        endDate: new Date(formattedEndDate)
    };
    if (projectName) saveData.projectName = projectName;

    try {
        await bonus_entry.save(saveData, { useMasterKey: true });

        console.log('Bonus period added successfully');
        return bonus_entry;
    } catch (error) {
        console.error('Error adding bonus period:', error);
        throw error;
    }
}

// Update setupWalletPricingAndBonus to accept date ranges and projectName
async function setupWalletPricingAndBonus(walletAddress, initialPrice, initialBonus = 0, startDate, endDate, projectName = null, marketCap = null) {
    console.log(`\nSetting up pricing and bonus for wallet ${walletAddress}`);
    console.log(`Initial price: $${initialPrice}`);
    console.log(`Initial bonus: ${initialBonus * 100}%`);

    await addPricePeriod(walletAddress, initialPrice, startDate, endDate, projectName, marketCap);
    await addBonusPeriod(walletAddress, initialBonus, startDate, endDate, projectName);

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

// Update setupWalletTracking to accept date ranges and projectName
async function setupWalletTracking(walletAddress, network, initialPrice, initialBonus, startDate, endDate, projectName = null, marketCap = null) {
    try {
        console.log(`\nSetting up wallet tracking for ${walletAddress}`);
        console.log(`Initial price: $${initialPrice}`);
        console.log(`Initial bonus: ${initialBonus * 100}%`);

        const config = await setupWalletConfig(walletAddress, network, projectName);
        await setupWalletPricingAndBonus(walletAddress, initialPrice, initialBonus, startDate, endDate, projectName, marketCap);

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
            if (network === 'ETH_MAINNET') {
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
                    contractAddresses: [ETH_USDT_ADDRESS],
                    category: ["erc20"],
                });

                console.log(`Found ${incomingEth.transfers.length} ETH transactions`);
                console.log(`Found ${incomingUsdt.transfers.length} USDT transactions`);

                for (const tx of incomingEth.transfers) {
                    await processTransaction('ETH', tx, true, null, className, walletAddress, null, projectName);
                }

                for (const tx of incomingUsdt.transfers) {
                    await processTransaction('USDT', tx, true, null, className, walletAddress, null, projectName);
                }
            } else {
                console.log(`Skipping historical transfer import for ${network}`);
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
async function getTokenPriceForTimestamp(timestamp, walletAddress, projectName = null) {
    const TokenPrice = Parse.Object.extend("TokenPrice");
    const query = new Parse.Query(TokenPrice);

    const txDate = timestamp instanceof Date ? timestamp : new Date(timestamp);

    query.lessThanOrEqualTo("startDate", txDate);
    query.greaterThanOrEqualTo("endDate", txDate);
    query.equalTo("walletAddress", walletAddress.toLowerCase());
    if (projectName) query.equalTo("projectName", projectName);

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
async function getBonusForTimestamp(timestamp, walletAddress, projectName = null) {
    const TokenBonus = Parse.Object.extend("TokenBonus");
    const query = new Parse.Query(TokenBonus);

    const txDate = timestamp instanceof Date ? timestamp : new Date(timestamp);

    query.lessThanOrEqualTo("startDate", txDate);
    query.greaterThanOrEqualTo("endDate", txDate);
    query.equalTo("walletAddress", walletAddress.toLowerCase());
    if (projectName) query.equalTo("projectName", projectName);

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
async function calculateTokenRewards(usdAmount, timestamp, walletAddress, projectName = null) {
    try {
        console.log('\nStarting Token Reward Calculation:');
        console.log(`USD Amount: $${usdAmount}`);
        console.log(`Timestamp: ${timestamp}`);
        console.log(`Wallet Address: ${walletAddress}`);

        const tokenPrice = await getTokenPriceForTimestamp(timestamp, walletAddress, projectName);
        const bonusPercentage = await getBonusForTimestamp(timestamp, walletAddress, projectName);

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

// Poll interval (ms). Many public RPCs don't support eth_newFilter/eth_getFilterChanges ("filter not found").
const BSC_POLL_INTERVAL_MS = parseInt(process.env.BSC_POLL_INTERVAL_MS || '15000', 10); // 15s default
let bscPollLastBlock = 0;

async function monitorBSCTransfers() {
    const WalletConfig = Parse.Object.extend("WalletConfig");
    const query = new Parse.Query(WalletConfig);
    query.equalTo("isActive", true);
    query.equalTo("network", "BNB_MAINNET");

    const activeWallets = await query.find({ useMasterKey: true });

    if (activeWallets.length === 0) {
        console.log('No active wallets to monitor');
        return;
    }

    const walletList = activeWallets.map((c) => ({
        walletAddress: c.get("walletAddress").toLowerCase(),
        className: c.get("transactionClassName"),
        projectName: c.get("projectName") || null,
    }));

    console.log(`Starting BSC monitoring (polling) for ${walletList.length} wallets, interval ${BSC_POLL_INTERVAL_MS}ms`);

    async function pollBlocks() {
        try {
            const latest = await bscProvider.getBlockNumber();
            const fromBlock = bscPollLastBlock
                ? bscPollLastBlock + 1
                : Math.max(0, latest - 20); // first run: only last 20 blocks
            if (fromBlock > latest) return;
            bscPollLastBlock = latest;

            for (let blockNum = fromBlock; blockNum <= latest; blockNum++) {
                const block = await bscProvider.getBlock(blockNum, true);
                if (!block || !block.prefetchedTransactions) continue;
                for (const tx of block.prefetchedTransactions) {
                    if (!tx.to) continue;
                    const to = tx.to.toLowerCase();
                    for (const { walletAddress, className, projectName } of walletList) {
                        if (tx.to?.toLowerCase() === walletAddress && tx.value && tx.value !== 0n) {
                            await processTransaction('BNB', tx, false, block, className, walletAddress, null, projectName);
                            continue;
                        }
                        if (to === BSC_USDT_ADDRESS.toLowerCase() && tx.data && tx.data.length >= 138) {
                            const iface = new ethers.Interface(['function transfer(address to, uint256 value)']);
                            try {
                                const decoded = iface.decodeFunctionData('transfer', tx.data);
                                if (decoded.to.toLowerCase() === walletAddress) {
                                    await processTransaction('USDT', tx, false, block, className, walletAddress, decoded.value, projectName);
                                }
                            } catch (_) { /* not transfer */ }
                        }
                    }
                }
            }
        } catch (error) {
            if (error.message && !error.message.includes('filter not found')) {
                console.error('BSC poll error:', error.message);
            }
        }
    }

    await pollBlocks();
    setInterval(pollBlocks, BSC_POLL_INTERVAL_MS);
    console.log('Transaction monitoring (polling) started successfully');
}

const ETH_POLL_INTERVAL_MS = parseInt(process.env.ETH_POLL_INTERVAL_MS || '15000', 10);
let ethPollLastBlock = 0;

async function monitorETHTransfers() {
    const WalletConfig = Parse.Object.extend("WalletConfig");
    const query = new Parse.Query(WalletConfig);
    query.equalTo("isActive", true);
    query.equalTo("network", "ETH_MAINNET");

    const activeWallets = await query.find({ useMasterKey: true });
    if (activeWallets.length === 0) {
        console.log('No active ETH wallets to monitor');
        return;
    }

    const walletList = activeWallets.map((c) => ({
        walletAddress: c.get("walletAddress").toLowerCase(),
        className: c.get("transactionClassName"),
        projectName: c.get("projectName") || null,
    }));

    console.log(`Starting ETH monitoring (polling) for ${walletList.length} wallets, interval ${ETH_POLL_INTERVAL_MS}ms`);

    async function pollBlocks() {
        try {
            const latest = await ethProvider.getBlockNumber();
            const fromBlock = ethPollLastBlock ? ethPollLastBlock + 1 : Math.max(0, latest - 20);
            if (fromBlock > latest) return;
            ethPollLastBlock = latest;

            for (let blockNum = fromBlock; blockNum <= latest; blockNum++) {
                const block = await ethProvider.getBlock(blockNum, true);
                if (!block || !block.prefetchedTransactions) continue;
                for (const tx of block.prefetchedTransactions) {
                    if (!tx.to) continue;
                    const to = tx.to.toLowerCase();
                    for (const { walletAddress, className, projectName } of walletList) {
                        if (to === walletAddress && tx.value && tx.value !== 0n) {
                            await processTransaction('ETH', tx, false, block, className, walletAddress, null, projectName);
                            continue;
                        }
                        if (to === ETH_USDT_ADDRESS.toLowerCase() && tx.data && tx.data.length >= 138) {
                            const iface = new ethers.Interface(['function transfer(address to, uint256 value)']);
                            try {
                                const decoded = iface.decodeFunctionData('transfer', tx.data);
                                if (decoded.to.toLowerCase() === walletAddress) {
                                    await processTransaction('USDT', tx, false, block, className, walletAddress, decoded.value, projectName);
                                }
                            } catch (_) { /* not transfer */ }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('ETH poll error:', error.message || error);
        }
    }

    await pollBlocks();
    setInterval(pollBlocks, ETH_POLL_INTERVAL_MS);
    console.log('ETH transaction monitoring (polling) started successfully');
}

// Update processTransaction to handle BNB instead of ETH
async function processTransaction(type, tx, isHistorical = false, block = null, className, targetWalletAddress = null, tokenRawAmount = null, projectName = null) {
    try {
        const fullWalletAddress = (targetWalletAddress || tx.to || '').toLowerCase();

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
            // Fix for timestamp extraction
            if (tx.metadata && tx.metadata.blockTimestamp) {
                timestamp = new Date(tx.metadata.blockTimestamp);
            } else if (block) {
                timestamp = new Date(block.timestamp * 1000);
            } else {
                // Get block information if we don't have timestamp
                const txBlock = await (type === 'ETH' ? ethProvider : bscProvider).getBlock(tx.blockNum);
                timestamp = new Date(txBlock.timestamp * 1000);
            }

            blockNumber = tx.blockNum;

            if (type === 'BNB') {
                const bnbPrice = await getBNBPrice(blockNumber);
                amountInUSD = parseFloat(tx.value) * bnbPrice;
            } else if (type === 'ETH') {
                const ethPrice = await getETHPrice();
                amountInUSD = parseFloat(tx.value) * ethPrice;
            } else {
                amountInUSD = parseFloat(tx.value);
            }
        } else {
            // ... existing non-historical processing ...
            if (block) {
                timestamp = new Date(block.timestamp * 1000);
                blockNumber = block.number;
            } else {
                const txBlock = await (type === 'ETH' ? ethProvider : bscProvider).getBlock(tx.blockNumber);
                timestamp = new Date(txBlock.timestamp * 1000);
                blockNumber = txBlock.number;
            }

            if (type === 'BNB' || type === 'ETH') {
                const nativePrice = type === 'ETH' ? await getETHPrice() : await getBNBPrice(blockNumber);
                const value = ethers.formatEther(tx.value);
                amountInUSD = parseFloat(value) * nativePrice;
            } else {
                // Handle USDT amount
                const value = ethers.formatUnits(tokenRawAmount ?? tx.value ?? 0n, 6); // USDT has 6 decimals
                amountInUSD = parseFloat(value);
            }
        }

        console.log(`\nProcessing ${type} transaction:`);
        console.log(`Transaction Hash: ${tx.hash}`);
        console.log(`Amount in USD: $${amountInUSD}`);
        console.log(`Timestamp: ${timestamp}`);
        console.log(`Wallet Address: ${fullWalletAddress}`);

        // Calculate token rewards with the full wallet address
        tokenRewards = await calculateTokenRewards(amountInUSD, timestamp, fullWalletAddress, projectName);

        // Save transaction if USD amount is valid
        if (amountInUSD > 0) {
            const tokenPrice = await getTokenPriceForTimestamp(timestamp, fullWalletAddress, projectName);
            const bonusPercentage = await getBonusForTimestamp(timestamp, fullWalletAddress, projectName);

            console.log('\nFinal Transaction Details:');
            console.log(`Token Price: $${tokenPrice}`);
            console.log(`Bonus Percentage: ${bonusPercentage * 100}%`);
            console.log(`Base Tokens: ${tokenRewards.baseTokens}`);
            console.log(`Bonus Tokens: ${tokenRewards.bonusTokens}`);
            console.log(`Total Tokens: ${tokenRewards.totalTokens}`);

            const transaction = new Transaction();
            // contributor = buyer (tx.from). walletAddress = presale deposit wallet (treasury), not the buyer.
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

    app.use('/parse', parseServer.app);
    app.use('/dashboard', dashboard);
    app.get('/', (req, res) => res.send('Server is running'));

    // Start the server
    const PORT = process.env.PORT || 1337;
    const HOST = process.env.HOST || '0.0.0.0';
    app.listen(PORT, HOST, async () => {
        const publicHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
        console.log(`Server is running — Parse API http://${publicHost}:${PORT}/parse`);
        console.log(`Parse Dashboard (browser): http://localhost:${PORT}/dashboard`);

        // Start blockchain monitoring for BSC + ETH
        monitorBSCTransfers().catch((error) => {
            console.error('Failed to start BSC monitoring:', error);
        });
        monitorETHTransfers().catch((error) => {
            console.error('Failed to start ETH monitoring:', error);
        });
    });
}).catch(error => {
    console.error('Failed to start server:', error);
});


app.post('/add-referral', async (req, res) => {
    const { walletAddress, refAddress } = req.body;

    if (!walletAddress || !refAddress) {
        return res.status(400).json({ error: 'walletAddress and refAddress are required' });
    }

    try {
        const result = await addReferral(walletAddress, refAddress);
        if (!result.success) {
            return res.status(400).json({ message: result.message }); // Respond with a message if no contributions
        }
        res.status(200).json({ message: result.message, bonusTokens: result.bonusTokens });
    } catch (error) {
        console.error('Error adding referral:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Set up a wallet for a project (payment + tracking). Creates WalletConfig, TokenPrice, TokenBonus, Transaction class.
// Body: { walletAddress, projectName, initialPrice?, initialBonus?, marketCap? }
app.post('/api/setup-project-wallet', async (req, res) => {
    const raw = req.body;
    const walletAddress = typeof raw.walletAddress === 'string' ? raw.walletAddress.trim() : raw.walletAddress;
    const projectName = typeof raw.projectName === 'string' ? raw.projectName.trim() : raw.projectName;
    const initialPrice = raw.initialPrice ?? 0.01;
    const initialBonus = raw.initialBonus ?? 0;
    const marketCap = raw.marketCap ?? 0;
    if (!walletAddress || !projectName) {
        return res.status(400).json({ error: 'walletAddress and projectName are required' });
    }
    const startDate = new Date();
    const endDate = new Date();
    endDate.setFullYear(endDate.getFullYear() + 10);
    try {
        const results = {};
        for (const network of ['BNB_MAINNET', 'ETH_MAINNET']) {
            const config = await setupWalletTracking(
                walletAddress,
                network,
                initialPrice,
                initialBonus,
                startDate.toISOString(),
                endDate.toISOString(),
                projectName,
                marketCap
            );
            results[network] = { transactionClassName: config.get('transactionClassName') };
        }
        res.status(200).json({ message: 'Wallet set up for project', walletAddress, projectName, results });
    } catch (error) {
        console.error('Error setting up project wallet:', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

module.exports = {
    setupWalletTracking,
    updatePrice,
    updateBonus,
    addPricePeriod,
    addBonusPeriod,
    monitorBSCTransfers,
    monitorETHTransfers,
    processTransaction,
    calculateTokenRewards,
    getTokenPriceForTimestamp,
    getBonusForTimestamp,
    getBNBPrice,
    getETHPrice
};