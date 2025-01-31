// Import Parse
const Parse = require('parse/node');

// Import the functions from trackerserver.js (adjust the path as needed)
const {
    setupWalletTracking,
    updatePrice,
    updateBonus,
} = require('./trackerserver');

// Log that cloud functions are being loaded
console.log('Loading cloud functions... FUNCTIONS');

// Define cloud functions
Parse.Cloud.define('setupWalletTracking', async (request) => {
    console.log('setupWalletTracking called with params:', request.params);
    const { walletAddress, network, initialPrice, initialBonus, startDate, endDate } = request.params;
    
    if (!walletAddress) {
        throw new Error('Wallet address is required');
    }

    try {
        const result = await setupWalletTracking(
            walletAddress,
            network,
            initialPrice,
            initialBonus,
            startDate,
            endDate
        );
        console.log('Setup completed successfully');
        return result;
    } catch (error) {
        console.error('Error in setupWalletTracking:', error);
        throw error;
    }
});

Parse.Cloud.define('updatePrice', async (request) => {
    console.log('updatePrice called with params:', request.params);
    const { walletAddress, newPrice, startDate, endDate } = request.params;
    
    if (!walletAddress || !newPrice) {
        throw new Error('Wallet address and new price are required');
    }

    try {
        const result = await updatePrice(
            walletAddress,
            newPrice,
            startDate,
            endDate
        );
        console.log('Price updated successfully');
        return result;
    } catch (error) {
        console.error('Error in updatePrice:', error);
        throw error;
    }
});

Parse.Cloud.define('updateBonus', async (request) => {
    console.log('updateBonus called with params:', request.params);
    const { walletAddress, newBonus, startDate, endDate } = request.params;
    
    if (!walletAddress || newBonus === undefined) {
        throw new Error('Wallet address and new bonus are required');
    }

    try {
        const result = await updateBonus(
            walletAddress,
            newBonus,
            startDate,
            endDate
        );
        console.log('Bonus updated successfully');
        return result;
    } catch (error) {
        console.error('Error in updateBonus:', error);
        throw error;
    }
});

// Log that cloud functions have been loaded
console.log('Cloud functions loaded successfully');