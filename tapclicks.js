// REV77 — TapClicks Integration
// OAuth2 client credentials flow + metric pulling

const https = require('https');
const querystring = require('querystring');

// Use REV77's specific TapClicks instance
// The global api.tapclicks.com is a different instance from rev77.tapclicks.com
const TAPCLICKS_BASE     = 'rev77.tapclicks.com';
const TAPCLICKS_AUTH_URL = 'https://rev77.tapclicks.com/oauth/accesstoken';
const TAPCLICKS_REFRESH  = 'https://rev77.tapclicks.com/oauth/refresh_accesstoken';

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

// ── Get all clients from TapClicks ────────────────────────────────────────────
async function getClients(page = '0,100') {
  const res = await tapclicksGet(`/clients?page=${page}&sort=company_name`);
  const clients = Array.isArray(res.data) ? res.data : [res.data];
  return clients.filter(c => c && c.reporting_status === 'active');
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

module.exports = {
  getAccessToken,
  tapclicksGet,
  getBusinessUnits,
  findBusinessUnit,
  testConnection,
  getClients,
  getChannels,
  findClient,
};
