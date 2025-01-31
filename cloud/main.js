// Import required modules
const Parse = require('parse-server/lib/cloud-code/Parse.Cloud');
const path = require('path');

// Import tracker functions
const trackerServer = require('../trackerserver');

console.log('Loading cloud functions...');

Parse.define('getSchemas', async (request) => {
    if (!request.master) {
      throw new Error('Requires master key');
    }
    
    try {
      // Construct the proper URL
      const serverURL = 'http://localhost:1337/parse';  // Update this to match your server URL
      
      // Use native fetch to call the Parse REST API
      const response = await fetch(`${serverURL}/schemas`, {
        method: 'GET',
        headers: {
          'X-Parse-Application-Id': 'myAppId',  // Update this to match your Parse app ID
          'X-Parse-Master-Key': 'myMasterKey'   // Update this to match your Parse master key
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      const schemas = data.results;
      return schemas.map(schema => schema.className);
    } catch (error) {
      throw new Error('Failed to fetch schemas: ' + error.message);
    }
});

// Setup Wallet Function
Parse.define('setupWalletTracking', async (request) => {
    try {
        const { walletAddress, network, initialPrice, initialBonus, startDate, endDate } = request.params;
        
        const result = await trackerServer.setupWalletTracking(
            walletAddress,
            network,
            initialPrice,
            initialBonus,
            startDate,
            endDate
        );
        
        return { success: true, result };
    } catch (error) {
        console.error('Error in setupWalletTracking:', error);
        throw error;
    }
});

// Update Price Function
Parse.define('updatePrice', async (request) => {
    try {
        const { walletAddress, newPrice, startDate, endDate } = request.params;
        console.log('Updating price for:', walletAddress);
        
        const result = await trackerServer.updatePrice(
            walletAddress,
            newPrice,
            startDate,
            endDate
        );
        
        return { success: true, result };
    } catch (error) {
        console.error('Error in updatePrice:', error);
        throw error;
    }
});

// Update Bonus Function
Parse.define('updateBonus', async (request) => {
    try {
        const { walletAddress, newBonus, startDate, endDate } = request.params;
        console.log('Updating bonus for:', walletAddress);
        
        const result = await trackerServer.updateBonus(
            walletAddress,
            newBonus,
            startDate,
            endDate
        );
        
        return { success: true, result };
    } catch (error) {
        console.error('Error in updateBonus:', error);
        throw error;
    }
});

console.log('Cloud functions loaded successfully'); 