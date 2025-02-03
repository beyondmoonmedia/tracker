Parse.initialize('myAppId');
Parse.serverURL = 'http://localhost:1337/parse';

// Subscribe to LiveQuery
const query = new Parse.Query('YourClassName');
const subscription = query.subscribe();

subscription.on('create', (object) => {
  console.log('New object created:', object);
});

subscription.on('update', (object) => {
  console.log('Object updated:', object);
});