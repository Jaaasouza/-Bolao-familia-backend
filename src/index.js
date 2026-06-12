const { buildApp } = require('./app');
const { startScheduler } = require('./scheduler');

const port = process.env.PORT || 3000;
const app = buildApp();

app.listen(port, () => {
  console.log(`[server] listening on ${port}`);
  startScheduler();
});
