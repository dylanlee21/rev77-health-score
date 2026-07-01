const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── GET /api/clients — all clients with their latest score ─────────────────
router.get('/clients', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id, c.name, c.industry, c.tier2_active,
        s.period, s.composite_score, s.campaign_score,
        s.delivery_score, s.communication_score, s.risk_score,
        s.status, s.flags, s.updated_at
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT * FROM scores WHERE client_id = c.id
        ORDER BY period_start DESC LIMIT 1
      ) s ON TRUE
      ORDER BY c.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// ── GET /api/clients/:id — single client with full score detail ────────────
router.get('/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { period } = req.query;

    const clientResult = await pool.query(
      'SELECT * FROM clients WHERE id = $1', [id]
    );
    if (clientResult.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

    const scoresQuery = period
      ? 'SELECT * FROM scores WHERE client_id = $1 AND period = $2 ORDER BY period_start DESC LIMIT 1'
      : 'SELECT * FROM scores WHERE client_id = $1 ORDER BY period_start DESC LIMIT 1';
    const scoresParams = period ? [id, period] : [id];
    const scoreResult = await pool.query(scoresQuery, scoresParams);

    const historyResult = await pool.query(
      'SELECT period, composite_score, campaign_score, communication_score, status FROM scores WHERE client_id = $1 ORDER BY period_start ASC',
      [id]
    );

    const benchmarkResult = await pool.query(
      'SELECT * FROM benchmarks WHERE industry = $1',
      [clientResult.rows[0].industry]
    );

    res.json({
      client:    clientResult.rows[0],
      score:     scoreResult.rows[0] || null,
      history:   historyResult.rows,
      benchmark: benchmarkResult.rows[0] || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch client detail' });
  }
});

// ── POST /api/clients — create new client ─────────────────────────────────
router.post('/clients', async (req, res) => {
  try {
    const { name, industry, tier2_active, revenue_tier, contract_renewal } = req.body;
    const result = await pool.query(
      'INSERT INTO clients (name, industry, tier2_active, revenue_tier, contract_renewal) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, industry, tier2_active || false, revenue_tier, contract_renewal || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// ── POST /api/scores — submit a new score for a client ────────────────────
router.post('/scores', async (req, res) => {
  try {
    const scoring = require('../scoring');
    const d = req.body;

    // Calculate all scores server-side from raw inputs
    const tier1 = scoring.calcTier1Score({
      cplMomPct:       d.cpl_mom_pct,
      cpcMomPct:       d.cpc_mom_pct,
      budgetPacingPct: d.budget_pacing_pct,
      convMomPct:      d.conv_mom_pct,
      zeroConvDays:    d.zero_conv_days,
      cvrMomPct:       d.cvr_mom_pct,
      sessionsMomPct:  d.sessions_mom_pct,
      newUsersMomPct:  d.new_users_mom_pct,
      engagementRate:  d.engagement_rate,
    });

    const keywords = scoring.calcKeywordScore(d.branded_keyword_pos, d.local_keyword_pos);
    const campaignScore = scoring.calcCampaignScore(tier1.score, keywords.score);

    const commScore = d.sentiment ? scoring.scoreCommunication({
      daysSinceContact: d.days_since_contact,
      unansweredEmails: d.unanswered_emails,
      daysUnanswered:   d.days_unanswered,
      sentiment:        d.sentiment,
      riskLanguage:     d.risk_language,
    }) : null;

    const compositeScore = scoring.calcCompositeScore({
      campaignScore,
      deliveryScore:      d.delivery_score || null,
      communicationScore: commScore,
      riskScore:          d.risk_score || null,
    });

    const flags = scoring.getFlags({
      cplMomPct:         d.cpl_mom_pct,
      cpcMomPct:         d.cpc_mom_pct,
      convMomPct:        d.conv_mom_pct,
      zeroConvDays:      d.zero_conv_days,
      localKeywordPos:   d.local_keyword_pos,
      riskLanguage:      d.risk_language,
      daysSinceContact:  d.days_since_contact,
    }).map(f => f.msg).join(' | ');

    const result = await pool.query(`
      INSERT INTO scores (
        client_id, period, period_start, period_end,
        campaign_score, delivery_score, communication_score, risk_score,
        composite_score, status,
        cpl_this, cpl_prior, cpl_mom_pct,
        cpc_this, cpc_prior, cpc_mom_pct,
        conversions_this, conversions_prior, conv_mom_pct,
        conv_rate_this, conv_rate_prior, cvr_mom_pct,
        zero_conv_days, budget_pacing_pct,
        sessions_this, sessions_prior, sessions_mom_pct,
        new_users_this, new_users_prior, new_users_mom_pct,
        engagement_rate, key_events_this, key_events_prior, key_events_mom_pct,
        branded_keyword_pos, local_keyword_pos,
        last_contact_date, days_since_contact, unanswered_emails,
        days_unanswered, sentiment, risk_language,
        spend_this, impressions_this, clicks_this, ctr_this,
        notes, flags
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48
      ) RETURNING *`,
      [
        d.client_id, d.period, d.period_start, d.period_end,
        campaignScore, d.delivery_score || null, commScore, d.risk_score || null,
        compositeScore, scoring.getStatus(compositeScore),
        d.cpl_this, d.cpl_prior, d.cpl_mom_pct,
        d.cpc_this, d.cpc_prior, d.cpc_mom_pct,
        d.conversions_this, d.conversions_prior, d.conv_mom_pct,
        d.conv_rate_this, d.conv_rate_prior, d.cvr_mom_pct,
        d.zero_conv_days, d.budget_pacing_pct,
        d.sessions_this, d.sessions_prior, d.sessions_mom_pct,
        d.new_users_this, d.new_users_prior, d.new_users_mom_pct,
        d.engagement_rate, d.key_events_this, d.key_events_prior, d.key_events_mom_pct,
        d.branded_keyword_pos, d.local_keyword_pos,
        d.last_contact_date, d.days_since_contact, d.unanswered_emails || false,
        d.days_unanswered || 0, d.sentiment, d.risk_language || false,
        d.spend_this, d.impressions_this, d.clicks_this, d.ctr_this,
        d.notes, flags,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

// ── GET /api/benchmarks — all industry benchmarks ─────────────────────────
router.get('/benchmarks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM benchmarks ORDER BY industry');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch benchmarks' });
  }
});

module.exports = router;
