// REV77 — Asana API Routes
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const asana   = require('../asana');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Helper: get workspace GID ─────────────────────────────────────────────────
let cachedWorkspaceGid = null;
async function getWorkspaceGid() {
  if (cachedWorkspaceGid) return cachedWorkspaceGid;
  const workspaces = await asana.getWorkspaces();
  if (!workspaces || workspaces.length === 0) throw new Error('No Asana workspaces found');
  cachedWorkspaceGid = workspaces[0].gid;
  return cachedWorkspaceGid;
}

// ── GET /api/asana/test ───────────────────────────────────────────────────────
// Validates connection and returns Test Project 5.2 data
router.get('/test', async (req, res) => {
  try {
    const workspaceGid = await getWorkspaceGid();
    const result = await asana.getTestProjectTasks(workspaceGid);
    res.json({
      connected: true,
      workspace: workspaceGid,
      ...result,
    });
  } catch (err) {
    console.error('Asana test error:', err.message);
    res.status(500).json({ connected: false, error: err.message });
  }
});

// ── GET /api/asana/workspaces ─────────────────────────────────────────────────
router.get('/workspaces', async (req, res) => {
  try {
    const workspaces = await asana.getWorkspaces();
    res.json(workspaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/asana/projects ───────────────────────────────────────────────────
router.get('/projects', async (req, res) => {
  try {
    const workspaceGid = await getWorkspaceGid();
    const projects = await asana.getProjects(workspaceGid);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/asana/client/:clientName ─────────────────────────────────────────
// Get delivery score for a specific client
router.get('/client/:clientName', async (req, res) => {
  try {
    const workspaceGid = await getWorkspaceGid();
    const result = await asana.getClientDeliveryScore(
      workspaceGid,
      req.params.clientName
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/asana/all ────────────────────────────────────────────────────────
// Get delivery scores for all clients in Daily Stand Up
router.get('/all', async (req, res) => {
  try {
    const workspaceGid = await getWorkspaceGid();
    const results = await asana.getAllClientsDelivery(workspaceGid);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/asana/sync ──────────────────────────────────────────────────────
// Syncs Asana delivery scores into the database for all clients
router.post('/sync', async (req, res) => {
  try {
    const workspaceGid = await getWorkspaceGid();
    const allDelivery  = await asana.getAllClientsDelivery(workspaceGid);
    const clients      = await pool.query('SELECT id, name FROM clients');
    const updated      = [];
    const errors       = [];

    for (const client of clients.rows) {
      // Try to match client name to Asana section
      const matchKey = Object.keys(allDelivery).find(sectionName =>
        sectionName.toLowerCase().includes(client.name.toLowerCase()) ||
        client.name.toLowerCase().includes(sectionName.toLowerCase())
      );

      if (!matchKey) {
        errors.push(`No Asana section found for: ${client.name}`);
        continue;
      }

      const delivery = allDelivery[matchKey];
      if (delivery.score === null) {
        errors.push(`No tasks found for: ${client.name}`);
        continue;
      }

      // Get latest score row for this client
      const latestScore = await pool.query(
        'SELECT id, composite_score, campaign_score, communication_score, risk_score, flags FROM scores WHERE client_id = $1 ORDER BY period_start DESC LIMIT 1',
        [client.id]
      );

      if (latestScore.rows.length === 0) {
        errors.push(`No score record found for: ${client.name}`);
        continue;
      }

      const s = latestScore.rows[0];

      // Recalculate composite with delivery score
      const scoring = require('../scoring');
      const newComposite = scoring.calcCompositeScore({
        campaignScore:      s.campaign_score,
        deliveryScore:      delivery.score,
        communicationScore: s.communication_score,
        riskScore:          s.risk_score,
      });

      // Build updated flags
      const existingFlags = s.flags || '';
      const deliveryFlags = delivery.flags.join(' | ');
      const allFlags = [existingFlags, deliveryFlags].filter(Boolean).join(' | ');

      // Build history note for overdue tasks
      const historyNote = delivery.overdueTasks.length > 0
        ? `Asana sync: ${delivery.overdueTasks.length} overdue task(s) — ${delivery.overdueTasks.map(t => `"${t.name}"`).join(', ')}`
        : null;

      // Update score record
      await pool.query(
        `UPDATE scores SET
          delivery_score   = $1,
          composite_score  = $2,
          status           = $3,
          flags            = $4,
          notes            = CASE WHEN $5::text IS NOT NULL
                              THEN COALESCE(notes, '') || E'\n' || $5
                              ELSE notes END,
          updated_at       = NOW()
        WHERE id = $6`,
        [
          delivery.score,
          newComposite,
          scoring.getStatus(newComposite),
          allFlags,
          historyNote,
          s.id,
        ]
      );

      updated.push({
        client:        client.name,
        deliveryScore: delivery.score,
        composite:     newComposite,
        overdue:       delivery.overdueTasks.length,
        summary:       delivery.summary,
      });
    }

    res.json({
      success: true,
      updated,
      errors,
      syncedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Asana sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
