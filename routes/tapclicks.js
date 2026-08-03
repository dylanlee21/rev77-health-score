// REV77 — TapClicks API Routes
const express   = require('express');
const router    = express.Router();
const { Pool }  = require('pg');
const tapclicks = require('../tapclicks');
const scoring   = require('../scoring');

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
    const daterange = req.query.daterange || tapclicks.getCurrentScoringPeriod();
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
    const daterange = req.query.daterange || tapclicks.getCurrentScoringPeriod();
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
    const daterange   = req.query.daterange || tapclicks.getCurrentScoringPeriod();

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

// ── GET /api/tapclicks/client/:id/campaign-metrics ────────────────────────────
// The full pipeline in one call: reads the client's cached TapClicks service
// mapping (running /discover on the fly if it hasn't been cached yet), then
// pulls normalized Campaign Performance metrics for the current scoring
// period (most recently completed month vs the one before it) — ready to
// hand straight to scoring.js's calcTier1Score().
router.get('/client/:id/campaign-metrics', async (req, res) => {
  try {
    const clientId   = req.params.id;
    const customerId = req.query.customer_id;
    const daterange   = req.query.daterange || tapclicks.getCurrentScoringPeriod();

    if (!customerId) {
      return res.status(400).json({
        error: 'customer_id query param is required (the TapClicks customer/client id, e.g. 122 for Tom\'s Mechanical)',
      });
    }

    // 1. Check for a cached service mapping first
    const clientRow = await pool.query(
      `SELECT tapclicks_service_ids FROM clients WHERE id = $1`,
      [clientId]
    );

    let connectedServices = clientRow.rows[0]?.tapclicks_service_ids || null;

    // 2. No cache yet (or empty) — run discovery now and save it
    if (!connectedServices || connectedServices.length === 0) {
      const discovery = await tapclicks.discoverClientServices(customerId, CANDIDATE_SERVICE_IDS, daterange);
      connectedServices = discovery
        .filter(d => d.has_data)
        .map(d => ({ service_id: d.service_id, view: d.matched_view }));

      await pool.query(
        `UPDATE clients SET tapclicks_service_ids = $1, tapclicks_discovered_at = NOW() WHERE id = $2`,
        [JSON.stringify(connectedServices), clientId]
      );
    }

    if (connectedServices.length === 0) {
      return res.json({
        client_id:   clientId,
        customer_id: customerId,
        daterange,
        connected_services: [],
        metrics: null,
        note: 'No connected TapClicks services found for this client — nothing to score from TapClicks.',
      });
    }

    // 3. Pull normalized metrics (current period vs prior month, handled
    //    internally by getCampaignMetrics)
    const metrics = await tapclicks.getCampaignMetrics(customerId, connectedServices, daterange);

    res.json({
      client_id:   clientId,
      customer_id: customerId,
      daterange,
      prior_range: tapclicks.getPriorMonthRange(daterange),
      connected_services: connectedServices,
      metrics,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/tapclicks/client/:id/auto-score ──────────────────────────────────
// The full automation: pulls TapClicks metrics for the current scoring
// period, runs them through scoring.js exactly like the manual /api/scores
// entry point does, and saves the result to the scores table — so it shows
// up on the dashboard's Campaign Performance tab automatically, with the
// raw current/prior numbers visible for manual sanity-checking.
router.get('/client/:id/auto-score', async (req, res) => {
  try {
    const clientId   = req.params.id;
    const customerId = req.query.customer_id;
    const daterange   = req.query.daterange || tapclicks.getCurrentScoringPeriod();

    // Keyword rankings aren't sourced from TapClicks (no SEO rank tracker
    // connected yet) — pass them in manually via query params if you have
    // them, otherwise the campaign score is Tier 1 only, same as it already
    // gracefully handles when keywords are unknown.
    const brandedPos = req.query.branded_keyword_pos ? Number(req.query.branded_keyword_pos) : null;
    const localPos    = req.query.local_keyword_pos   ? Number(req.query.local_keyword_pos)   : null;

    if (!customerId) {
      return res.status(400).json({
        error: 'customer_id query param is required (the TapClicks customer/client id)',
      });
    }

    // 1. Get cached service mapping, discover if missing (same as /campaign-metrics)
    const clientRow = await pool.query(
      `SELECT tapclicks_service_ids FROM clients WHERE id = $1`, [clientId]
    );
    let connectedServices = clientRow.rows[0]?.tapclicks_service_ids || null;

    if (!connectedServices || connectedServices.length === 0) {
      const discovery = await tapclicks.discoverClientServices(customerId, CANDIDATE_SERVICE_IDS, daterange);
      connectedServices = discovery
        .filter(d => d.has_data)
        .map(d => ({ service_id: d.service_id, view: d.matched_view }));

      await pool.query(
        `UPDATE clients SET tapclicks_service_ids = $1, tapclicks_discovered_at = NOW() WHERE id = $2`,
        [JSON.stringify(connectedServices), clientId]
      );
    }

    if (connectedServices.length === 0) {
      return res.json({
        client_id: clientId, customer_id: customerId, daterange,
        note: 'No connected TapClicks services found for this client — nothing to score.',
      });
    }

    // 2. Pull normalized metrics (current period vs prior month)
    const metrics = await tapclicks.getCampaignMetrics(customerId, connectedServices, daterange);

    // 3. Score exactly like the manual entry point does
    const tier1         = scoring.calcTier1Score(metrics);
    const keywords       = scoring.calcKeywordScore(brandedPos, localPos);
    const campaignScore = scoring.calcCampaignScore(tier1.score, keywords.score);

    // 4. Period bookkeeping
    const [periodStart, periodEnd] = daterange.split('|');
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const period = `${monthNames[new Date(periodStart + 'T00:00:00Z').getUTCMonth()]} ${periodStart.slice(0, 4)}`;

    // 5. Raw display values, pulled straight from what TapClicks returned —
    //    these are what let you manually sanity-check the numbers on the
    //    Campaign Performance tab.
    const ga4Cur   = metrics.raw.ga4?.current       || {};
    const ga4Prior = metrics.raw.ga4?.prior         || {};
    const adsCur   = metrics.raw.googleAds?.current || {};
    const adsPrior = metrics.raw.googleAds?.prior   || {};

    // TapClicks returns numeric fields as strings, sometimes with decimal
    // padding (e.g. "414.000000000") — INTEGER columns reject that as-is,
    // so round/parse everything before it touches the DB.
    const toInt = v => (v === null || v === undefined || v === '') ? null : Math.round(Number(v));
    const toDec = v => (v === null || v === undefined || v === '') ? null : Number(v);

    const flags = scoring.getFlags({
      cplMomPct:        metrics.cplMomPct,
      cpcMomPct:        metrics.cpcMomPct,
      convMomPct:       metrics.convMomPct,
      zeroConvDays:     metrics.zeroConvDays,
      localKeywordPos:  localPos,
      riskLanguage:     false,
      daysSinceContact: 0,
    }).map(f => f.msg).join(' | ');

    // 6. Preserve whatever delivery/communication/risk scores already exist
    //    for this client+period (this endpoint only owns Campaign
    //    Performance) and recompute the composite around the new number.
    const existing = await pool.query(
      `SELECT id, delivery_score, communication_score, risk_score
       FROM scores WHERE client_id = $1 AND period = $2`,
      [clientId, period]
    );

    const deliveryScore      = existing.rows[0]?.delivery_score      ?? null;
    const communicationScore = existing.rows[0]?.communication_score ?? null;
    const riskScore          = existing.rows[0]?.risk_score          ?? null;

    const compositeScore = scoring.calcCompositeScore({
      campaignScore, deliveryScore, communicationScore, riskScore,
    });
    const status = scoring.getStatus(compositeScore);

    const values = [
      clientId, period, periodStart, periodEnd,
      toInt(campaignScore), toInt(compositeScore), status,
      toInt(ga4Cur.SessionsCount),   toInt(ga4Prior.SessionsCount),   toDec(metrics.sessionsMomPct),
      toInt(ga4Cur.New_usersCount),  toInt(ga4Prior.New_usersCount),  toDec(metrics.newUsersMomPct),
      toDec(metrics.engagementRate),
      toInt(ga4Cur.ConversionsCount ?? adsCur.ConversionsCount),
      toInt(ga4Prior.ConversionsCount ?? adsPrior.ConversionsCount),
      toDec(metrics.convMomPct),
      toDec(metrics.cplMomPct), toDec(metrics.cpcMomPct),
      toDec(brandedPos), toDec(localPos), flags,
    ];

    let saved;
    if (existing.rows.length > 0) {
      const upd = await pool.query(`
        UPDATE scores SET
          period_start=$3, period_end=$4,
          campaign_score=$5, composite_score=$6, status=$7,
          sessions_this=$8, sessions_prior=$9, sessions_mom_pct=$10,
          new_users_this=$11, new_users_prior=$12, new_users_mom_pct=$13,
          engagement_rate=$14,
          key_events_this=$15, key_events_prior=$16, key_events_mom_pct=$17,
          cpl_mom_pct=$18, cpc_mom_pct=$19,
          branded_keyword_pos=$20, local_keyword_pos=$21,
          flags=$22, updated_at=NOW()
        WHERE client_id=$1 AND period=$2
        RETURNING *`, values);
      saved = upd.rows[0];
    } else {
      const ins = await pool.query(`
        INSERT INTO scores (
          client_id, period, period_start, period_end,
          campaign_score, composite_score, status,
          sessions_this, sessions_prior, sessions_mom_pct,
          new_users_this, new_users_prior, new_users_mom_pct,
          engagement_rate,
          key_events_this, key_events_prior, key_events_mom_pct,
          cpl_mom_pct, cpc_mom_pct,
          branded_keyword_pos, local_keyword_pos,
          flags
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        RETURNING *`, values);
      saved = ins.rows[0];
    }

    res.json({
      client_id: clientId,
      customer_id: customerId,
      daterange,
      period,
      connected_services: connectedServices,
      tier1_breakdown: tier1.breakdown,
      campaign_score: campaignScore,
      composite_score: compositeScore,
      status,
      saved_score_row: saved,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
