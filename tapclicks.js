// REV77 — TapClicks Integration
// OAuth2 client credentials flow + metric pulling

const https = require('https');
const querystring = require('querystring');

const TAPCLICKS_BASE     = 'api.tapclicks.com';
const TAPCLICKS_AUTH_URL = 'https://api.tapclicks.com/oauth/accesstoken';
const TAPCLICKS_REFRESH  = 'https://api.tapclicks.com/oauth/refresh_accesstoken';

// ── Token cache (in-memory, refreshes automatically) ──────────────────────────
let tokenCache = {
  access_token: null,
  expires_at:   null,  // timestamp in ms
};

// ── POST helper for auth endpoints ────────────────────────────────────────────
function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const body    = querystring.stringify(params);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`TapClicks auth [${res.statusCode}] ${url} — ${data.length} bytes`);
        if (!data) { reject(new Error(`Empty response from ${url}`)); return; }
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            const msg = parsed.fault?.faultstring || parsed.error || `HTTP ${res.statusCode}`;
            reject(new Error(`TapClicks auth failed: ${msg}`));
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error(`JSON parse failed: ${e.message}. Raw: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GET token (auto-refreshes when expired) ───────────────────────────────────
async function getAccessToken() {
  const CLIENT_ID     = process.env.TAPCLICKS_CLIENT_ID;
  const CLIENT_SECRET = process.env.TAPCLICKS_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('TAPCLICKS_CLIENT_ID and TAPCLICKS_CLIENT_SECRET must be set');
  }

  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (tokenCache.access_token && tokenCache.expires_at && (tokenCache.expires_at - now) > 60000) {
    return tokenCache.access_token;
  }

  // Request new token
  console.log('TapClicks: requesting new access token...');
  const result = await postForm(TAPCLICKS_AUTH_URL, {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'client_credentials',
  });

  if (!result.access_token) {
    throw new Error('TapClicks returned no access_token');
  }

  tokenCache = {
    access_token: result.access_token,
    expires_at:   now + (result.expires_in * 1000),
  };

  console.log(`TapClicks: token obtained, expires in ${result.expires_in}s`);
  return tokenCache.access_token;
}

// ── Core GET helper ───────────────────────────────────────────────────────────
function tapGet(path, token, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    const options = {
      hostname: TAPCLICKS_BASE,
      path:     `/v2${path}`,
      method:   'GET',
      headers:  {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
      },
    };

    const req = https.request(options, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        console.log(`TapClicks redirect [${res.statusCode}] → ${res.headers.location}`);
        res.resume();
        try {
          const url      = new URL(res.headers.location);
          const newPath  = (url.pathname + url.search).replace('/v2', '');
          resolve(tapGet(newPath, token, redirectCount + 1));
        } catch(e) { reject(new Error(`Bad redirect: ${res.headers.location}`)); }
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`TapClicks [${res.statusCode}] /v2${path} — ${data.length} bytes`);
        if (!data) { reject(new Error(`Empty response (HTTP ${res.statusCode})`)); return; }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error && parsed.error !== false) {
            reject(new Error(`TapClicks API error: ${JSON.stringify(parsed.error)}`));
          } else {
            resolve(parsed);
          }
        } catch(e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Public API helper ─────────────────────────────────────────────────────────
async function tapclicksGet(path) {
  const token = await getAccessToken();
  return await tapGet(path, token);
}

// ── Get all business units (clusters) ────────────────────────────────────────
async function getBusinessUnits() {
  const res = await tapclicksGet('/clusters');
  // Response: { data: [...clusters], error: false, status: 200 }
  const units = Array.isArray(res.data) ? res.data : [res.data];
  return units.filter(u => u && u.status === 'active');
}

// ── Get a specific business unit by name ──────────────────────────────────────
async function findBusinessUnit(name) {
  const units = await getBusinessUnits();
  return units.find(u =>
    u.name.toLowerCase().includes(name.toLowerCase()) ||
    name.toLowerCase().includes(u.name.toLowerCase())
  ) || null;
}

// ── Welcome / connection test ─────────────────────────────────────────────────
async function testConnection() {
  const token = await getAccessToken();
  const res   = await tapGet('/', token);
  return { connected: true, message: res.data || res, token_obtained: true };
}

// exports at bottom of file

// ── Get all clients from TapClicks (paginated) ───────────────────────────────
async function getClients() {
  let allClients = [];
  let pageNum    = 0;
  const pageSize = 100;

  while (true) {
    const res     = await tapclicksGet(`/clients?page=${pageNum},${pageSize}&sort=company_name`);
    const batch   = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    if (batch.length === 0) break;
    allClients = allClients.concat(batch);
    console.log(`TapClicks: fetched ${allClients.length} clients so far...`);
    if (batch.length < pageSize) break; // last page
    pageNum += 1; // was: offset += pageSize (wrong — "page" is a page NUMBER, not an offset)
  }

  return allClients; // return all statuses so we can see Tom's Mechanical
}

// ── Get all channels (categories) ────────────────────────────────────────────
async function getChannels() {
  const res = await tapclicksGet('/categories');
  return Array.isArray(res.data) ? res.data : [res.data];
}

// ── Find a TapClicks client by name ──────────────────────────────────────────
async function findClient(name) {
  const clients = await getClients();
  return clients.find(c =>
    c.company_name?.toLowerCase().includes(name.toLowerCase()) ||
    name.toLowerCase().includes(c.company_name?.toLowerCase())
  ) || null;
}

// ── Discover which TapClicks services actually have data for a given client ──
// Some clients aren't wired to every service (e.g. a client may have Google
// Ads Search but not Display, or no paid ads at all — just GA4/GBP/Search
// Console). Rather than hardcoding a service_id and view, this checks each
// candidate service's real data views and tests whether the given customer_id
// has any rows in any of them, for the given date range.
async function discoverClientServices(customerId, candidateServiceIds, daterange) {
  const results = [];

  for (const serviceId of candidateServiceIds) {
    const entry = {
      service_id:    serviceId,
      views_checked: [],
      has_data:      false,
      matched_view:  null,
      error:         null,
    };

    try {
      const dvResult   = await tapclicksGet(`/services/${serviceId}/data/data_views`);
      const dataViews  = Array.isArray(dvResult.data) ? dvResult.data : [];
      const viewsToTry = dataViews.length > 0
        ? dataViews.map(dv => dv.id || dv.data_view_id || dv)
        : ['cgn']; // fallback if the data_views lookup itself returns nothing

      for (const view of viewsToTry) {
        entry.views_checked.push(view);
        try {
          const raw = await tapclicksGet(
            `/services/${serviceId}/data/${view}?page=0,1&daterange=${daterange}&customer_id=${customerId}`
          );
          if (Array.isArray(raw.data) && raw.data.length > 0) {
            entry.has_data     = true;
            entry.matched_view = view;
            break; // found data for this service — no need to check remaining views
          }
        } catch (e) {
          // this view may not support this filter combo — skip and keep trying others
        }
      }
    } catch (e) {
      entry.error = e.message;
    }

    results.push(entry);
  }

  return results;
}


// ── Confirmed field maps (pulled live from TapClicks metadata) ────────────
// GA4 fields verified against real Tom's Mechanical data on 2026-08-03.
const GA4_FIELDS = {
  sessions:       'SessionsCount',
  newUsers:       'New_usersCount',
  engagementRate: 'EngagementRate',
  keyEvents:      'ConversionsCount', // GA4 "Key events" — TapClicks kept the old internal field name
};

// Google Ads field names below are NOT YET CONFIRMED against live data — no
// sampled client (122) has a Google Ads connection. Before trusting cpl/cpc
// math, run GET /api/tapclicks/metadata/137 and cross-check against a client
// that DOES have Ads data (customer_id 56 or 117, confirmed via /discover).
const GOOGLE_ADS_FIELDS = {
  cost:        'CostCount',
  clicks:      'ClicksCount',
  impressions: 'ImpressionsCount',
  conversions: 'ConversionsCount',
};

// ── Given a daterange string "YYYY-MM-DD|YYYY-MM-DD", return the same-shaped
// range for the immediately prior calendar month (for MoM comparisons). ────
function getPriorMonthRange(daterange) {
  const [startStr] = daterange.split('|');
  const start = new Date(startStr + 'T00:00:00Z');

  const priorMonthLastDay  = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0));
  const priorMonthFirstDay = new Date(Date.UTC(priorMonthLastDay.getUTCFullYear(), priorMonthLastDay.getUTCMonth(), 1));

  const fmt = d => d.toISOString().slice(0, 10);
  return `${fmt(priorMonthFirstDay)}|${fmt(priorMonthLastDay)}`;
}

// ── Get normalized campaign metrics for a client from whichever service(s) ──
// actually have their data — paid Google Ads, organic GA4, or both. Returns
// a metrics object shaped exactly for scoring.js's calcTier1Score(), with
// any unavailable metric left as null (calcTier1Score already skips nulls
// and renormalizes weights around what's present).
//
// `connectedServices` is the cached array from discoverClientServices() /
// clients.tapclicks_service_ids, e.g. [{ service_id: 276, view: "cgn" }]
async function getCampaignMetrics(customerId, connectedServices, currentRange) {
  const priorRange = getPriorMonthRange(currentRange);
  const adsService  = connectedServices.find(s => [34, 136, 137].includes(Number(s.service_id)));
  const ga4Service  = connectedServices.find(s => Number(s.service_id) === 276);

  const metrics = {
    source:          [],   // which service(s) actually contributed data
    cplMomPct:       null,
    cpcMomPct:       null,
    budgetPacingPct: null,
    convMomPct:      null,
    zeroConvDays:    null,
    cvrMomPct:       null,
    sessionsMomPct:  null,
    newUsersMomPct:  null,
    engagementRate:  null,
    raw:             {},   // untouched API rows, kept for debugging/audit
  };

  // ── GA4 organic metrics ────────────────────────────────────────────────
  if (ga4Service) {
    try {
      const fields = Object.values(GA4_FIELDS).join(',');
      const [current, prior] = await Promise.all([
        tapclicksGet(`/services/${ga4Service.service_id}/data/${ga4Service.view}?page=0,1&daterange=${currentRange}&customer_id=${customerId}&fields=customer_id,${fields}`),
        tapclicksGet(`/services/${ga4Service.service_id}/data/${ga4Service.view}?page=0,1&daterange=${priorRange}&customer_id=${customerId}&fields=customer_id,${fields}`),
      ]);

      const curRow   = current.data?.[0];
      const priorRow = prior.data?.[0];
      metrics.raw.ga4 = { current: curRow || null, prior: priorRow || null };

      if (curRow) {
        metrics.source.push('ga4');
        metrics.engagementRate = Number(curRow[GA4_FIELDS.engagementRate]);

        if (priorRow) {
          const curSessions   = Number(curRow[GA4_FIELDS.sessions]);
          const priorSessions = Number(priorRow[GA4_FIELDS.sessions]);
          const curNewUsers   = Number(curRow[GA4_FIELDS.newUsers]);
          const priorNewUsers = Number(priorRow[GA4_FIELDS.newUsers]);
          const curKeyEvents   = Number(curRow[GA4_FIELDS.keyEvents]);
          const priorKeyEvents = Number(priorRow[GA4_FIELDS.keyEvents]);

          if (priorSessions > 0) {
            metrics.sessionsMomPct = +(((curSessions - priorSessions) / priorSessions) * 100).toFixed(1);
          }
          if (priorNewUsers > 0) {
            metrics.newUsersMomPct = +(((curNewUsers - priorNewUsers) / priorNewUsers) * 100).toFixed(1);
          }
          // Only use GA4 key events for the conversions trend if there's no
          // paid-ads conversion data to prefer instead.
          if (!adsService && priorKeyEvents > 0) {
            metrics.convMomPct = +(((curKeyEvents - priorKeyEvents) / priorKeyEvents) * 100).toFixed(1);
          }
        }
      }
    } catch (e) {
      metrics.raw.ga4Error = e.message;
    }
  }

  // ── Google Ads paid metrics (field names unconfirmed — see note above) ──
  if (adsService) {
    try {
      const fields = Object.values(GOOGLE_ADS_FIELDS).join(',');
      const [current, prior] = await Promise.all([
        tapclicksGet(`/services/${adsService.service_id}/data/${adsService.view}?page=0,1&daterange=${currentRange}&customer_id=${customerId}&fields=customer_id,${fields}`),
        tapclicksGet(`/services/${adsService.service_id}/data/${adsService.view}?page=0,1&daterange=${priorRange}&customer_id=${customerId}&fields=customer_id,${fields}`),
      ]);

      const curRow   = current.data?.[0];
      const priorRow = prior.data?.[0];
      metrics.raw.googleAds = { current: curRow || null, prior: priorRow || null };

      if (curRow) {
        metrics.source.push('google_ads');

        if (priorRow) {
          const curCost          = Number(curRow[GOOGLE_ADS_FIELDS.cost]);
          const priorCost        = Number(priorRow[GOOGLE_ADS_FIELDS.cost]);
          const curConversions   = Number(curRow[GOOGLE_ADS_FIELDS.conversions]);
          const priorConversions = Number(priorRow[GOOGLE_ADS_FIELDS.conversions]);

          const curCpl   = curConversions > 0   ? curCost / curConversions     : null;
          const priorCpl = priorConversions > 0 ? priorCost / priorConversions : null;

          if (curCpl !== null && priorCpl) {
            metrics.cplMomPct = +(((curCpl - priorCpl) / priorCpl) * 100).toFixed(1);
          }
          if (priorConversions > 0) {
            metrics.convMomPct = +(((curConversions - priorConversions) / priorConversions) * 100).toFixed(1);
          }
        }
      }
    } catch (e) {
      metrics.raw.googleAdsError = e.message;
    }
  }

  return metrics;
}

module.exports = {
  getAccessToken,
  tapclicksGet,
  getBusinessUnits,
  findBusinessUnit,
  testConnection,
  getClients,
  getChannels,
  findClient,
  discoverClientServices,
  getCampaignMetrics,
  getPriorMonthRange,
};
