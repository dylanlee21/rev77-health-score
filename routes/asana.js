// REV77 — Asana API Routes
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const asana   = require('../asana');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let cachedWorkspaceGid = null;
async function getWorkspaceGid() {
  if (cachedWorkspaceGid) return cachedWorkspaceGid;
  const workspaces = await asana.getWorkspaces();
  if (!workspaces || workspaces.length === 0) throw new Error('No Asana workspaces found');
  cachedWorkspaceGid = workspaces[0].gid;
  return cachedWorkspaceGid;
}

// ── GET /api/asana/debug ──────────────────────────────────────────────────────
router.get('/debug', (req, res) => {
  const token = process.env.ASANA_TOKEN;
  res.json({
    token_set:    !!token,
    token_length: token ? token.length : 0,
    token_prefix: token ? token.substring(0, 6) + '...' : 'NOT SET',
  });
});

// ── GET /api/asana/test ───────────────────────────────────────────────────────
router.get('/test', async (req, res) => {
  try {
    const wGid   = await getWorkspaceGid();
    const result = await asana.getTestProjectTasks(wGid);
    res.json({ connected: true, workspace: wGid, ...result });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// ── GET /api/asana/workspaces ─────────────────────────────────────────────────
router.get('/workspaces', async (req, res) => {
  try {
    res.json(await asana.getWorkspaces());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/asana/projects ───────────────────────────────────────────────────
router.get('/projects', async (req, res) => {
  try {
    const wGid = await getWorkspaceGid();
    res.json(await asana.getProjects(wGid));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/asana/client/:clientName ────────────────────────────────────────
router.get('/client/:clientName', async (req, res) => {
  try {
    const wGid   = await getWorkspaceGid();
    const result = await asana.getClientDeliveryScore(wGid, req.params.clientName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/asana/all ────────────────────────────────────────────────────────
router.get('/all', async (req, res) => {
  try {
    const wGid = await getWorkspaceGid();
    res.json(await asana.getAllClientsDelivery(wGid));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/asana/sync ──────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    const wGid    = await getWorkspaceGid();
    const clients = await pool.query('SELECT id, name, asana_project_name FROM clients');
    const updated = [];
    const errors  = [];

    for (const client of clients.rows) {
      let delivery;

      // If client has an explicit asana_project_name, use that directly
      if (client.asana_project_name) {
        console.log(`${client.name}: using explicit project "${client.asana_project_name}"`);
        delivery = await asana.getClientDeliveryScoreByProject(wGid, client.asana_project_name);
      } else {
        // Otherwise fall back to name matching
        delivery = await asana.getClientDeliveryScore(wGid, client.name);
      }

      if (!delivery || delivery.score === null) {
        errors.push(`${client.name}: ${delivery?.error || 'No tasks found'}`);
        continue;
      }

      // Get latest score row
      const latest = await pool.query(
        'SELECT id, composite_score, campaign_score, communication_score, risk_score, flags, notes FROM scores WHERE client_id = $1 ORDER BY period_start DESC LIMIT 1',
        [client.id]
      );

      if (latest.rows.length === 0) {
        errors.push(`${client.name}: No score record found — add TapClicks data first`);
        continue;
      }

      const s       = latest.rows[0];
      const scoring = require('../scoring');

      const newComposite = scoring.calcCompositeScore({
        campaignScore:      s.campaign_score,
        deliveryScore:      delivery.score,
        communicationScore: s.communication_score,
        riskScore:          s.risk_score,
      });

      const existingFlags = (s.flags || '').split(' | ').filter(Boolean);
      const newFlags      = delivery.flags.filter(f => !existingFlags.includes(f));
      const allFlags      = [...existingFlags, ...newFlags].join(' | ');

      const historyNote = delivery.overdueTasks.length > 0
        ? `[Asana sync ${new Date().toLocaleDateString()}] ${delivery.overdueTasks.length} overdue: ${delivery.overdueTasks.map(t => `"${t.name}"`).join(', ')}`
        : null;

      await pool.query(
        `UPDATE scores SET
          delivery_score  = $1,
          composite_score = $2,
          status          = $3,
          flags           = $4,
          notes           = CASE WHEN $5::text IS NOT NULL
                            THEN COALESCE(notes, '') || E'\n' || $5
                            ELSE notes END,
          updated_at      = NOW()
        WHERE id = $6`,
        [delivery.score, newComposite, scoring.getStatus(newComposite), allFlags, historyNote, s.id]
      );

      updated.push({
        client:        client.name,
        source:        delivery.source || delivery.projectName,
        deliveryScore: delivery.score,
        composite:     newComposite,
        status:        scoring.getStatus(newComposite),
        overdue:       delivery.overdueTasks.length,
        summary:       delivery.summary,
      });
    }

    res.json({ success: true, updated, errors, syncedAt: new Date().toISOString() });

  } catch (err) {
    console.error('Asana sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
