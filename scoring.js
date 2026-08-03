// REV77 Health Score — Scoring Engine
// All scoring logic lives here. Same model as the Google Sheet, now in code.

// ── Tier 1 Universal Metrics ───────────────────────────────────────────────

function scoreMoMCPL(momPct) {
  if (momPct === null || momPct === undefined) return null;
  if (momPct >= 25)  return 30;
  if (momPct >= 10)  return Math.round(60 - ((momPct - 10) / 15) * 20);
  if (momPct >= 0)   return Math.round(80 + ((10 - momPct) / 10) * 20);
  return Math.min(100, Math.round(90 + Math.abs(momPct) * 0.2));
}

function scoreMoMCPC(momPct) {
  if (momPct === null || momPct === undefined) return null;
  if (momPct >= 30)  return 30;
  if (momPct >= 15)  return Math.round(60 - ((momPct - 15) / 15) * 20);
  if (momPct >= 0)   return Math.round(80 + ((15 - momPct) / 15) * 20);
  return Math.min(100, Math.round(90 + Math.abs(momPct) * 0.15));
}

function scoreBudgetPacing(pct) {
  // No budget pacing data (e.g. organic-only clients with no paid spend) —
  // leave it out of scoring entirely rather than defaulting to a placeholder.
  if (pct === null || pct === undefined) return null;
  if (pct < 70 || pct > 115) return 35;
  if (pct < 80 || pct > 110) return 65;
  return 90;
}

function scoreMoMConversions(momPct) {
  if (momPct === null || momPct === undefined) return null;
  if (momPct <= -20) return 30;
  if (momPct <= -5)  return Math.round(60 - ((momPct + 5) / 15) * 20);
  if (momPct <= 0)   return Math.round(75 + ((momPct + 5) / 5) * 5);
  return Math.min(100, Math.round(80 + momPct * 0.1));
}

function scoreZeroConvDays(days) {
  // No zero-conversion-day tracking available (e.g. organic-only clients) —
  // leave it out of scoring entirely rather than defaulting to a placeholder.
  if (days === null || days === undefined) return null;
  if (days >= 8)  return 35;
  if (days >= 4)  return 65;
  return 88;
}

function scoreMoMConvRate(momPct) {
  if (momPct === null || momPct === undefined) return null;
  if (momPct <= -20) return 30;
  if (momPct <= -5)  return 65;
  if (momPct <= 0)   return 78;
  return Math.min(100, Math.round(82 + momPct * 0.06));
}

function scoreMoMSessions(momPct) {
  if (momPct === null || momPct === undefined) return null;
  if (momPct <= -10) return 35;
  if (momPct < 0)    return Math.round(60 + ((momPct + 10) / 10) * 20);
  return Math.min(100, Math.round(80 + momPct * 0.5));
}

function scoreMoMNewUsers(momPct) {
  if (momPct === null || momPct === undefined) return null;
  if (momPct <= -10) return 35;
  if (momPct < 0)    return Math.round(60 + ((momPct + 10) / 10) * 20);
  return Math.min(100, Math.round(80 + momPct * 0.5));
}

function scoreEngagementRate(pct) {
  if (pct === null || pct === undefined) return null;
  if (pct < 50) return 35;
  if (pct < 65) return Math.round(60 + ((pct - 50) / 15) * 20);
  return Math.min(100, Math.round(80 + ((pct - 65) / 35) * 20));
}

// ── Keyword Scores ──────────────────────────────────────────────────────────

function scoreBrandedKeywords(avgPos) {
  if (!avgPos) return null;
  if (avgPos <= 3)  return 95;
  if (avgPos <= 9)  return 70;
  return 35;
}

function scoreLocalKeywords(avgPos) {
  if (!avgPos) return null;
  if (avgPos <= 10) return 90;
  if (avgPos <= 19) return 70;
  return Math.max(10, Math.round(55 - (avgPos - 20) * 0.3));
}

// ── Communication Score ─────────────────────────────────────────────────────

function scoreCommunication({ daysSinceContact, unansweredEmails, daysUnanswered, sentiment, riskLanguage }) {
  // Days since contact (30%)
  let contactScore;
  if (daysSinceContact <= 7)  contactScore = 100;
  else if (daysSinceContact <= 14) contactScore = 70;
  else contactScore = 35;

  // Unanswered emails (20%)
  let unansScore;
  if (!unansweredEmails)         unansScore = 100;
  else if (daysUnanswered <= 2)  unansScore = 65;
  else unansScore = 35;

  // Sentiment (30%)
  const sentMap = { Positive: 100, Neutral: 75, Concerned: 50, Escalating: 15 };
  const sentScore = sentMap[sentiment] ?? 75;

  // Risk language (20%)
  const riskScore = riskLanguage ? 15 : 100;

  return Math.round(
    contactScore * 0.30 +
    unansScore   * 0.20 +
    sentScore    * 0.30 +
    riskScore    * 0.20
  );
}

// ── Tier 1 Composite ────────────────────────────────────────────────────────

function calcTier1Score(metrics) {
  const scores = {
    cplMoM:      { score: scoreMoMCPL(metrics.cplMomPct),           weight: 0.20 },
    cpcMoM:      { score: scoreMoMCPC(metrics.cpcMomPct),           weight: 0.10 },
    budgetPacing:{ score: scoreBudgetPacing(metrics.budgetPacingPct),weight: 0.10 },
    convMoM:     { score: scoreMoMConversions(metrics.convMomPct),   weight: 0.20 },
    zeroConv:    { score: scoreZeroConvDays(metrics.zeroConvDays),   weight: 0.10 },
    cvrMoM:      { score: scoreMoMConvRate(metrics.cvrMomPct),       weight: 0.10 },
    sessionsMoM: { score: scoreMoMSessions(metrics.sessionsMomPct),  weight: 0.10 },
    newUsersMoM: { score: scoreMoMNewUsers(metrics.newUsersMomPct),  weight: 0.10 },
    engRate:     { score: scoreEngagementRate(metrics.engagementRate),weight: 0.10 },
  };

  let rawTotal = 0;
  let totalWeight = 0;
  const breakdown = {};

  for (const [key, { score, weight }] of Object.entries(scores)) {
    if (score !== null && score !== undefined) {
      rawTotal += score * weight;
      totalWeight += weight;
      breakdown[key] = { score, weight, weighted: +(score * weight).toFixed(1) };
    }
  }

  // Normalize to 100 based on available weights
  const normalized = totalWeight > 0 ? Math.round(rawTotal / totalWeight) : null;
  return { score: normalized, breakdown };
}

// ── Keyword Composite ───────────────────────────────────────────────────────

function calcKeywordScore(brandedPos, localPos) {
  const branded = scoreBrandedKeywords(brandedPos);
  const local   = scoreLocalKeywords(localPos);
  if (!branded && !local) return { score: null, breakdown: {} };
  const both = branded !== null && local !== null;
  const score = both
    ? Math.round(branded * 0.5 + local * 0.5)
    : (branded ?? local);
  return {
    score,
    breakdown: {
      branded: { score: branded, weight: 0.50, weighted: +(branded * 0.5).toFixed(1) },
      local:   { score: local,   weight: 0.50, weighted: +(local   * 0.5).toFixed(1) },
    }
  };
}

// ── Campaign Performance Score ──────────────────────────────────────────────

function calcCampaignScore(tier1Score, keywordScore) {
  if (tier1Score === null) return null;
  if (keywordScore === null) return Math.round(tier1Score);
  return Math.round(tier1Score * 0.80 + keywordScore * 0.20);
}

// ── Full Composite Score ────────────────────────────────────────────────────

function calcCompositeScore({ campaignScore, deliveryScore, communicationScore, riskScore }) {
  let total = 0;
  let weight = 0;
  if (campaignScore      !== null && campaignScore      !== undefined) { total += campaignScore      * 0.40; weight += 0.40; }
  if (deliveryScore      !== null && deliveryScore      !== undefined) { total += deliveryScore      * 0.25; weight += 0.25; }
  if (communicationScore !== null && communicationScore !== undefined) { total += communicationScore * 0.20; weight += 0.20; }
  if (riskScore          !== null && riskScore          !== undefined) { total += riskScore          * 0.15; weight += 0.15; }
  if (weight === 0) return null;
  return Math.round(total / weight);
}

function getStatus(score) {
  if (score === null || score === undefined) return null;
  if (score >= 80) return 'GREEN';
  if (score >= 60) return 'YELLOW';
  return 'RED';
}

// ── Score triggers ──────────────────────────────────────────────────────────

function getFlags(metrics) {
  const flags = [];
  if (metrics.cplMomPct    >= 25)   flags.push({ type: 'danger',  msg: `CPL up ${metrics.cplMomPct.toFixed(1)}% MoM — Red trigger` });
  if (metrics.cpcMomPct    >= 30)   flags.push({ type: 'danger',  msg: `CPC up ${metrics.cpcMomPct.toFixed(1)}% MoM — Red trigger` });
  if (metrics.convMomPct   <= -20)  flags.push({ type: 'danger',  msg: `Conversions down ${Math.abs(metrics.convMomPct).toFixed(1)}% MoM` });
  if (metrics.zeroConvDays >= 8)    flags.push({ type: 'danger',  msg: `${metrics.zeroConvDays} days with zero conversions` });
  if (metrics.cplMomPct    >= 10 && metrics.cplMomPct < 25)  flags.push({ type: 'warning', msg: `CPL up ${metrics.cplMomPct.toFixed(1)}% MoM — watch closely` });
  if (metrics.cpcMomPct    >= 15 && metrics.cpcMomPct < 30)  flags.push({ type: 'warning', msg: `CPC up ${metrics.cpcMomPct.toFixed(1)}% MoM` });
  if (metrics.zeroConvDays >= 4 && metrics.zeroConvDays < 8) flags.push({ type: 'warning', msg: `${metrics.zeroConvDays} days with zero conversions` });
  if (metrics.localKeywordPos >= 20) flags.push({ type: 'warning', msg: `Local service keywords averaging position ${metrics.localKeywordPos}` });
  if (metrics.riskLanguage)          flags.push({ type: 'danger',  msg: 'Risk language detected in client emails' });
  if (metrics.daysSinceContact > 14) flags.push({ type: 'danger',  msg: `No client contact in ${metrics.daysSinceContact} days` });
  return flags;
}

module.exports = {
  calcTier1Score, calcKeywordScore, calcCampaignScore,
  calcCompositeScore, scoreCommunication, getStatus, getFlags,
  scoreMoMCPL, scoreMoMCPC, scoreBudgetPacing, scoreMoMConversions,
  scoreZeroConvDays, scoreMoMConvRate, scoreMoMSessions,
  scoreMoMNewUsers, scoreEngagementRate, scoreBrandedKeywords, scoreLocalKeywords,
};
