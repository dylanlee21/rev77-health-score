-- REV77 Client Health Score — Database Schema

-- Clients table
CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  industry VARCHAR(100) DEFAULT 'Unknown',
  tier2_active BOOLEAN DEFAULT FALSE,
  contract_renewal DATE,
  revenue_tier VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Scores table — one row per client per period
CREATE TABLE IF NOT EXISTS scores (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id),
  period VARCHAR(20) NOT NULL,         -- e.g. "May 2026"
  period_start DATE,
  period_end DATE,

  -- Category scores (0-100)
  campaign_score NUMERIC(5,2),
  delivery_score NUMERIC(5,2),
  communication_score NUMERIC(5,2),
  risk_score NUMERIC(5,2),
  composite_score NUMERIC(5,2),
  status VARCHAR(10),                  -- GREEN, YELLOW, RED

  -- Campaign Performance sub-scores
  paid_search_score NUMERIC(5,2),
  organic_score NUMERIC(5,2),
  keyword_score NUMERIC(5,2),

  -- Tier 1 raw metric inputs
  cpl_this NUMERIC(10,2),
  cpl_prior NUMERIC(10,2),
  cpl_mom_pct NUMERIC(6,2),
  cpc_this NUMERIC(10,2),
  cpc_prior NUMERIC(10,2),
  cpc_mom_pct NUMERIC(6,2),
  conversions_this INTEGER,
  conversions_prior INTEGER,
  conv_mom_pct NUMERIC(6,2),
  conv_rate_this NUMERIC(6,2),
  conv_rate_prior NUMERIC(6,2),
  cvr_mom_pct NUMERIC(6,2),
  zero_conv_days INTEGER,
  budget_pacing_pct NUMERIC(6,2),
  sessions_this INTEGER,
  sessions_prior INTEGER,
  sessions_mom_pct NUMERIC(6,2),
  new_users_this INTEGER,
  new_users_prior INTEGER,
  new_users_mom_pct NUMERIC(6,2),
  engagement_rate NUMERIC(6,2),
  key_events_this INTEGER,
  key_events_prior INTEGER,
  key_events_mom_pct NUMERIC(6,2),

  -- Keyword rankings
  branded_keyword_pos NUMERIC(6,1),
  local_keyword_pos NUMERIC(6,1),

  -- Communication inputs
  last_contact_date DATE,
  days_since_contact INTEGER,
  unanswered_emails BOOLEAN DEFAULT FALSE,
  days_unanswered INTEGER DEFAULT 0,
  sentiment VARCHAR(20),               -- Positive, Neutral, Concerned, Escalating
  risk_language BOOLEAN DEFAULT FALSE,

  -- Spend
  spend_this NUMERIC(10,2),
  impressions_this INTEGER,
  clicks_this INTEGER,
  ctr_this NUMERIC(6,2),

  -- Notes
  notes TEXT,
  flags TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Benchmarks table — industry thresholds for Tier 2
CREATE TABLE IF NOT EXISTS benchmarks (
  id SERIAL PRIMARY KEY,
  industry VARCHAR(100) UNIQUE NOT NULL,
  cpl_red NUMERIC(10,2),
  cpl_green NUMERIC(10,2),
  ctr_red NUMERIC(6,2),
  ctr_green NUMERIC(6,2),
  cvr_red NUMERIC(6,2),
  cvr_green NUMERIC(6,2),
  source VARCHAR(255),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ── Seed data ─────────────────────────────────────────────────────────────────

-- Insert Tom's Mechanical as first client
INSERT INTO clients (name, industry, tier2_active, revenue_tier)
VALUES ('Tom''s Mechanical', 'HVAC / Home Services', TRUE, 'Mid')
ON CONFLICT DO NOTHING;

-- Insert industry benchmarks
INSERT INTO benchmarks (industry, cpl_red, cpl_green, ctr_red, ctr_green, cvr_red, cvr_green, source)
VALUES
  ('HVAC / Home Services',     150.00, 89.00,  2.00, 4.00,  5.00, 10.00, 'SearchLight / PPC Chief 2026'),
  ('Legal / Law Firm',         300.00, 150.00, 2.00, 5.00,  3.00,  7.00, 'WordStream 2025 — update when available'),
  ('Medical / Healthcare',     200.00, 100.00, 2.00, 5.00,  3.00,  8.00, 'WordStream 2025 — update when available'),
  ('Home Builder / Real Est.', 250.00, 120.00, 2.00, 5.00,  2.00,  6.00, 'Industry avg — update with REV77 data'),
  ('Restaurant / Food Serv.',   50.00,  20.00, 3.00, 6.00,  5.00, 12.00, 'Industry avg — update with REV77 data'),
  ('E-Commerce / Retail',       60.00,  25.00, 2.00, 5.00,  1.00,  4.00, 'WordStream 2025 — update when available'),
  ('Automotive',                80.00,  40.00, 3.00, 6.00,  4.00,  9.00, 'WordStream 2025 — update when available')
ON CONFLICT (industry) DO NOTHING;

-- Insert Tom's Mechanical May 2026 score
INSERT INTO scores (
  client_id, period, period_start, period_end,
  campaign_score, communication_score, composite_score, status,
  paid_search_score, organic_score, keyword_score,
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
  1, 'May 2026', '2026-05-01', '2026-05-31',
  78.1, 94.0, 78.1, 'YELLOW',
  78.0, 85.9, 67.5,
  103.94, 206.02, -49.5,
  7.32, 5.27, 38.9,
  67, 34, 97.1,
  7.05, 2.56, 175.4,
  15, NULL,
  1161, 1110, 4.6,
  880, 874, 0.7,
  80.45, 59, 22, 168.2,
  1.0, 185.0,
  '2026-05-28', 3, FALSE,
  0, 'Positive', FALSE,
  6964.00, 9329, 951, 10.19,
  'Pilot client — first scored month. Strong paid search recovery from April.',
  'CPC up +38.9% MoM (Red trigger) | 15 zero-conv days | Arlington keywords ranking 90-230'
);
