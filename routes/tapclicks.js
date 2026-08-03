// REV77 — TapClicks API Routes
const express   = require('express');
const router    = express.Router();
const { Pool }  = require('pg');
const tapclicks = require('../tapclicks');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── GET /api/tapclicks/debug ──────────────────────────────────────────────────
router.get('/debug', (req, res) => {
  const id     = process.env.TAPCLICKS_CLIENT_ID;
  const secret = process.env.TAPCLICKS_CLIENT_SECRET;
  res.json({
    client_id_set:    !!id,
    client_id_length: id ? id.length : 0,
    secret_set:       !!secret,
    secret_length:    secret ? secret.length : 0,
  });
});

// ── GET /api/tapclicks/test ───────────────────────────────────────────────────
router.get('/test', async (req, res) => {
  try {
    const result = await tapclicks.testConnection();
    res.json(result);
  } catch(err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// ── GET /api/tapclicks/units ──────────────────────────────────────────────────
router.get('/units', async (req, res) => {
  try {
    const units = await tapclicks.getBusinessUnits();
    res.json({ count: units.length, units });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/clients ────────────────────────────────────────────────
// Lists all active clients in TapClicks
router.get('/clients', async (req, res) => {
  try {
    const clients = await tapclicks.getClients();
    res.json({
      count: clients.length,
      clients: clients.map(c => ({
        id:               c.id,
        company_name:     c.company_name,
        reporting_status: c.reporting_status,
        cluster_id:       c.cluster_id,
        created:          c.formatted_creation_time,
      })),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/channels ───────────────────────────────────────────────
// Lists all channels (Search, Social, OTT, etc.)
router.get('/channels', async (req, res) => {
  try {
    const channels = await tapclicks.getChannels();
    res.json({ count: channels.length, channels });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/explore/:path(*) ──────────────────────────────────────
// Exploration endpoint — lets us discover available API routes freely
router.get('/explore/*', async (req, res) => {
  try {
    const path  = '/' + req.params[0];
    const query = Object.keys(req.query).length
      ? '?' + new URLSearchParams(req.query).toString()
      : '';
    const result = await tapclicks.tapclicksGet(path + query);
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
