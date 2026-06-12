const express = require('express');
const cors = require('cors');

// Builds the Express app without listening — so tests can drive it with
// supertest and src/index.js can add listen() + the scheduler.
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // curl, health checks, same-origin
        if (!allowed.length || allowed.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: ${origin} not allowed`));
      },
      credentials: true,
    })
  );

  app.use(require('./routes/health'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/phoneAuth'));
  app.use(require('./routes/scorePicks'));
  app.use(require('./routes/push'));
  app.use(require('./routes/config'));
  app.use(require('./routes/state'));
  app.use(require('./routes/matches'));
  app.use(require('./routes/players'));
  app.use(require('./routes/phases'));
  app.use(require('./routes/standings'));
  app.use(require('./routes/sync'));
  app.use(require('./routes/chat'));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });

  return app;
}

module.exports = { buildApp };
