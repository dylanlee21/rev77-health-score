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

// ── GET /api/tapclicks/metadata/:service_id ──────────────────────────────────
// Get available fields for a service
router.get('/metadata/:service_id', async (req, res) => {
  try {
    const result = await tapclicks.tapclicksGet(
      `/services/${req.params.service_id}/data/cgn?metadata=1`
    );
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/dataviews/:service_id ──────────────────────────────────
// Get data view IDs for a service
router.get('/dataviews/:service_id', async (req, res) => {
  try {
    const result = await tapclicks.tapclicksGet(
      `/services/${req.params.service_id}/data/data_views`
    );
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/client/:id/data ───────────────────────────────────────
// Pull data for a specific client from key services
router.get('/client/:id/data', async (req, res) => {
  try {
    const clientId  = req.params.id;
    const daterange = req.query.daterange || '2026-05-01|2026-05-31';
    const serviceId = req.query.service_id || '137'; // default Google Ads Search

    // First get data views for this service
    const dvResult = await tapclicks.tapclicksGet(
      `/services/${serviceId}/data/data_views`
    );
    const dataViews = Array.isArray(dvResult.data) ? dvResult.data : [];
    console.log(`Data views for service ${serviceId}:`, JSON.stringify(dataViews));

    // Try each data view
    const results = [];
    const viewsToTry = dataViews.length > 0
      ? dataViews.map(dv => dv.id || dv.data_view_id || dv)
      : ['cgn']; // fallback to cgn

    for (const view of viewsToTry.slice(0, 5)) {
      try {
        // First try without client filter to see raw data structure
        const raw = await tapclicks.tapclicksGet(
          `/services/${serviceId}/data/${view}?page=0,3&daterange=${daterange}`
        );
        if (raw.data && raw.data.length > 0) {
          results.push({
            view,
            sample_fields: Object.keys(raw.data[0]),
            sample_row: raw.data[0],
          });
        }
      } catch(e) {
        results.push({ view, error: e.message });
      }
    }

    res.json({ client_id: clientId, service_id: serviceId, daterange, dataViews, results });
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

// ── GET /api/tapclicks/sample/:service_id/:view ───────────────────────────────
// Pull a small sample of raw data to see field names
router.get('/sample/:service_id/:view', async (req, res) => {
  try {
    const { service_id, view } = req.params;
    const daterange = req.query.daterange || '2026-05-01|2026-05-31';
    const clientId  = req.query.client_id || '';
    const clientFilter = clientId ? `&customer_id=${clientId}` : ''; // was cust_id — TapClicks expects customer_id

    const result = await tapclicks.tapclicksGet(
      `/services/${service_id}/data/${view}?page=0,3&daterange=${daterange}&aggregate=true${clientFilter}`
    );

    // Return field names from first row + full sample
    const sample = Array.isArray(result.data) ? result.data : [];
    res.json({
      service_id,
      view,
      daterange,
      field_names: sample.length > 0 ? Object.keys(sample[0]) : [],
      sample_rows: sample.slice(0, 2),
      total_rows:  sample.length,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/client/:id/discover ────────────────────────────────────
// Finds which TapClicks services actually have data for this client (rather
// than assuming service_id 137 / Google Ads Search for everyone), and saves
// the result to the clients table so future scoring runs don't re-guess.
const CANDIDATE_SERVICE_IDS = [34, 136, 137, 276, 63, 184];
// 34 = Google Ads, 136 = Google Ads Display, 137 = Google Ads Search,
// 276 = Google Analytics 4, 63 = Google Search Console, 184 = Google Business Profile

router.get('/client/:id/discover', async (req, res) => {
  try {
    const clientId   = req.params.id;
    const customerId = req.query.customer_id;
    const daterange   = req.query.daterange || '2026-05-01|2026-05-31';

    if (!customerId) {
      return res.status(400).json({
        error: 'customer_id query param is required (the TapClicks customer/client id, e.g. 122 for Tom\'s Mechanical)',
      });
    }

    const discovery          = await tapclicks.discoverClientServices(customerId, CANDIDATE_SERVICE_IDS, daterange);
    const connectedServices  = discovery.filter(d => d.has_data);

    // Cache the result on the client record so scoring doesn't have to
    // re-discover this on every run.
    await pool.query(
      `UPDATE clients
       SET tapclicks_service_ids = $1, tapclicks_discovered_at = NOW()
       WHERE id = $2`,
      [
        JSON.stringify(connectedServices.map(d => ({ service_id: d.service_id, view: d.matched_view }))),
        clientId,
      ]
    );

    res.json({
      client_id:          clientId,
      customer_id:        customerId,
      daterange,
      discovery,                 // full detail — every candidate service checked, and why
      connected_services: connectedServices, // just the ones that actually had data
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
