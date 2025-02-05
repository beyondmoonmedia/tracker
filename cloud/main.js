// Import required modules
const Parse = require('parse-server/lib/cloud-code/Parse.Cloud');
const path = require('path');
const { io } = require('../workingwelleth'); // Adjust the path as necessary

// Import tracker functions
const trackerServer = require('../trackerserver');

console.log('Loading cloud functions...');
Parse.afterSave('Transaction_e2f90a_BSC', (request) => {
    const object = request.object;

    // Emit an event to notify clients
    io.emit('newObjectCreated', {
        id: object.id,
        data: object.toJSON(),
    });
});

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


console.log('Cloud functions loaded successfully'); 