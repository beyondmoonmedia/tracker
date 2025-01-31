const Parse = require('parse/node');
const { setupWalletTracking } = require('./trackerserver.js');

// Initialize Parse
Parse.initialize("myAppId", null, "myMasterKey");  // Use your actual Parse app ID and master key
Parse.serverURL = 'http://localhost:1337/parse';

// Replace with your wallet address
const walletAddress = "0xe2F90Ae1A046e77fB24Bf32706C18911F760EB1A";  // Replace with your actual wallet address
const initialPrice = 0.013;  // $0.013 per token
const initialBonus = 0.1;    // 10% bonus
const initialStart = new Date("2025-01-01T00:00:00.000Z");    // Start date
const initialEnd = new Date("2025-01-21T23:59:59.000Z");      // End date

async function setupWallets() {
    try {
        // Setup ETH tracking
        console.log('\nSetting up ETH wallet tracking...');
        const ethResult = await setupWalletTracking(
            walletAddress, 
            'ETH', 
            initialPrice, 
            initialBonus, 
            initialStart, 
            initialEnd
        );
        console.log('ETH wallet setup complete:', ethResult);

        // Setup BSC tracking
        console.log('\nSetting up BSC wallet tracking...');
        const bscResult = await setupWalletTracking(
            walletAddress, 
            'BSC', 
            initialPrice, 
            initialBonus, 
            initialStart, 
            initialEnd
        );
        console.log('BSC wallet setup complete:', bscResult);

        process.exit(0);
    } catch (error) {
        console.error('Setup failed:', error);
        process.exit(1);
    }
}

// Add command line arguments support
const args = process.argv.slice(2);
if (args.length > 0) {
    const network = args[0].toUpperCase();
    if (network === 'ETH' || network === 'BSC') {
        // Setup specific network
        async function setupSingleNetwork() {
            try {
                console.log(`\nSetting up ${network} wallet tracking...`);
                const result = await setupWalletTracking(
                    walletAddress, 
                    network, 
                    initialPrice, 
                    initialBonus, 
                    initialStart, 
                    initialEnd
                );
                console.log(`${network} wallet setup complete:`, result);
                process.exit(0);
            } catch (error) {
                console.error('Setup failed:', error);
                process.exit(1);
            }
        }
        setupSingleNetwork();
    } else {
        console.error('Invalid network specified. Use ETH or BSC');
        process.exit(1);
    }
} else {
    // Setup both networks
    setupWallets();
}