// Import required modules
const Parse = require('parse-server/lib/cloud-code/Parse.Cloud');
const path = require('path');
const { io } = require('../workingwelleth'); // Adjust the path as necessary


console.log('Loading cloud functions2...');
Parse.afterSave('Transaction_e2f90a_BSC', (request) => {
    const object = request.object;

    // Emit an event to notify clients
    io.emit('newObjectCreated', {
        id: object.id,
        data: object.toJSON(),
    });
});
Parse.afterSave('Transaction_e2f90a_ETH', (request) => {
    const object = request.object;

    // Emit an event to notify clients
    io.emit('newObjectCreated', {
        id: object.id,
        data: object.toJSON(),
    });
});


console.log('Cloud functions loaded successfully'); 