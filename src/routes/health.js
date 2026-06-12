const router = require('express').Router();

// Bump this on changes you want to confirm went live. Open /api/version in a
// browser to verify the deployed backend includes a given fix.
const VERSION = 'faster-poll';

// Trivial liveness probe for Railway. No deep checks here.
router.get('/health', (req, res) => res.status(200).json({ ok: true, version: VERSION }));

// Public version marker — lets us confirm a deploy actually landed.
router.get('/api/version', (req, res) => res.status(200).json({ version: VERSION, at: Date.now() }));

module.exports = router;
