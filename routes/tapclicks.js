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

// ── GET /api/tapclicks/services/connected ────────────────────────────────────
// Returns only connected services with just id and name
router.get('/services/connected', async (req, res) => {
  try {
    const result   = await tapclicks.tapclicksGet('/services?page=0,200');
    const services = Array.isArray(result.data) ? result.data : [];
    const connected = services
      .filter(s => s.is_connected === true || s.is_connected === 'true' || s.is_connected === 1)
      .map(s => ({ service_id: s.service_id || s.id, name: s.name, is_connected: s.is_connected }));
    res.json({ count: connected.length, services: connected });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/services/all ──────────────────────────────────────────
// Returns all services with just id and name
router.get('/services/all', async (req, res) => {
  try {
    const result   = await tapclicks.tapclicksGet('/services?page=0,200');
    const services = Array.isArray(result.data) ? result.data : [];
    res.json({
      count: services.length,
      services: services.map(s => ({
        service_id:   s.service_id || s.id,
        name:         s.name,
        is_connected: s.is_connected,
        active:       s.active,
      })),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/client/:id/data ───────────────────────────────────────
// Try to pull data for a specific client across all services
router.get('/client/:id/data', async (req, res) => {
  try {
    const clientId  = req.params.id;
    const daterange = req.query.daterange || '2026-05-01|2026-05-31';

    // Get connected services first
    const svcResult  = await tapclicks.tapclicksGet('/services?page=0,200');
    const services   = Array.isArray(svcResult.data) ? svcResult.data : [];
    const connected  = services.filter(s => s.is_connected === true || s.is_connected === 1);

    const results = [];
    for (const svc of connected.slice(0, 10)) { // try first 10 connected services
      try {
        const svcId  = svc.service_id || svc.id;
        const data   = await tapclicks.tapclicksGet(
          `/services/${svcId}/data/cgn?groupby=customer_id&fields=customer_id,ClickCount,ImpressionCount,CTR,AverageCPC,Cost&daterange=${daterange}&customer_id=${clientId}&page=0,5`
        );
        if (data.data && data.data.length > 0) {
          results.push({ service: svc.name, service_id: svcId, data: data.data });
        }
      } catch(e) {
        // skip services that don't support this query
      }
    }
    res.json({ client_id: clientId, daterange, results });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/explore/:path(*) ──────────────────────────────────────
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
