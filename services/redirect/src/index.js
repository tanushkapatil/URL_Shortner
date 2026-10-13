// Redirect service: the hot path. Resolves a short code and issues the HTTP redirect.
// Stateless, so it can be scaled horizontally to any number of replicas.
//
//   cache (Redis) --miss--> shortener REST API --> cache the answer --> 302 redirect
//                                                           |
//                                     click event --> Redis Stream --> analytics service
const express = require('express');
const os = require('os');
const crypto = require('crypto');
const Redis = require('ioredis');

const PORT = Number(process.env.PORT || 3002);
const INSTANCE = os.hostname();
const SHORTENER_URL = process.env.SHORTENER_URL || 'http://shortener:3001';
const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://analytics:3003';
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 3600);
const NEGATIVE_TTL_SEC = 30; // cache "not found" briefly so bad codes cannot hammer the shortener
const STREAM = 'clicks';
const STREAM_MAXLEN = 100000;
const CODE = '[A-Za-z0-9_-]{3,30}';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
let redisUp = false;
redis.on('ready', () => { redisUp = true; console.log('[redis] connected'); });
redis.on('error', (err) => { if (redisUp) console.error('[redis] connection lost:', err.message); redisUp = false; });

const stats = { requests: 0, cacheHits: 0, cacheMisses: 0, eventsQueued: 0, eventsDirect: 0, eventsDropped: 0 };

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Served-By', INSTANCE); next(); });

async function lookup(code) {
  const key = `url:${code}`;
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      stats.cacheHits++;
      return { ...JSON.parse(cached), cache: 'HIT' };
    }
  } catch {
    // Redis down: skip the cache and go straight to the source of truth.
  }
  stats.cacheMisses++;

  const r = await fetch(`${SHORTENER_URL}/internal/urls/${encodeURIComponent(code)}`, {
    signal: AbortSignal.timeout(2000),
  });
  let entry;
  if (r.status === 404) {
    entry = { notFound: true };
  } else if (!r.ok) {
    throw new Error(`shortener responded ${r.status}`);
  } else {
    const body = await r.json();
    entry = { longUrl: body.longUrl, expiresAt: body.expiresAt };
  }

  let ttl = entry.notFound ? NEGATIVE_TTL_SEC : CACHE_TTL_SEC;
  if (entry.expiresAt) {
    const secondsLeft = Math.ceil((new Date(entry.expiresAt) - Date.now()) / 1000);
    ttl = Math.max(1, Math.min(ttl, secondsLeft));
  }
  try { await redis.set(key, JSON.stringify(entry), 'EX', ttl); } catch { /* cache is best effort */ }
  return { ...entry, cache: 'MISS' };
}

const isExpired = (entry) => entry.expiresAt && new Date(entry.expiresAt) <= new Date();

// Fire-and-forget: the user is redirected without waiting for analytics.
// Primary path is the Redis Stream (async, buffered). If Redis is down we fall back to
// calling the analytics service directly; only if both are down is the click dropped.
function recordClick(code, req) {
  const event = {
    code,
    ts: String(Date.now()),
    referrer: (req.get('referer') || '').slice(0, 500),
    ua: (req.get('user-agent') || '').slice(0, 300),
    instance: INSTANCE,
  };
  redis.xadd(STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*', ...Object.entries(event).flat())
    .then(() => { stats.eventsQueued++; })
    .catch(() => fetch(`${ANALYTICS_URL}/internal/clicks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, eventId: `direct-${crypto.randomUUID()}` }),
      signal: AbortSignal.timeout(1500),
    }).then((r) => {
      if (!r.ok) throw new Error(`analytics responded ${r.status}`);
      stats.eventsDirect++;
    }))
    .catch((err) => {
      stats.eventsDropped++;
      console.warn(`[click] dropped event for ${code}: ${err.message}`);
    });
}

const page = (title, message) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1f2933;background:#f5f7fa}
main{text-align:center;padding:24px}h1{font-size:1.6rem;margin:0 0 8px}p{color:#52606d}a{color:#2563eb}</style></head>
<body><main><h1>${title}</h1><p>${message}</p><p><a href="/">Create a new short link</a></p>
<p style="font-size:.8rem;color:#9aa5b1">served by ${INSTANCE}</p></main></body></html>`;

// Health routes must be registered before /:code, or "health" would be treated as a short code.
const startedAt = Date.now();
app.get('/live', (req, res) => res.json({ status: 'alive' }));
app.get('/health', (req, res) => {
  // The redirect service can still work without Redis (no cache), so it stays "ok".
  res.json({
    service: 'redirect',
    status: 'ok',
    instance: INSTANCE,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    dependencies: { redis: redisUp ? 'up' : 'down' },
    stats,
  });
});

app.get(`/:code(${CODE})`, async (req, res) => {
  stats.requests++;
  const { code } = req.params;
  try {
    const entry = await lookup(code);
    res.set('X-Cache', entry.cache);
    if (entry.notFound) return res.status(404).send(page('Link not found', `There is no short link called <b>${code}</b>.`));
    if (isExpired(entry)) return res.status(410).send(page('Link expired', 'This short link has expired.'));
    recordClick(code, req);
    // 302 (not 301) so browsers do not cache the redirect and every click is counted.
    res.redirect(302, entry.longUrl);
  } catch (err) {
    console.error(`[redirect] ${code} failed: ${err.message}`);
    res.status(503).send(page('Temporarily unavailable', 'We could not resolve this link right now. Please retry in a moment.'));
  }
});

// JSON lookup without counting a click. Used by the UI's load-balancing demo.
app.get(`/api/resolve/:code(${CODE})`, async (req, res) => {
  stats.requests++;
  try {
    const entry = await lookup(req.params.code);
    if (entry.notFound) return res.status(404).json({ error: 'Not found', servedBy: INSTANCE });
    res.json({
      code: req.params.code,
      longUrl: entry.longUrl,
      expired: Boolean(isExpired(entry)),
      cache: entry.cache,
      servedBy: INSTANCE,
    });
  } catch (err) {
    res.status(503).json({ error: err.message, servedBy: INSTANCE });
  }
});

const server = app.listen(PORT, () => console.log(`[redirect] ${INSTANCE} listening on :${PORT}`));
const shutdown = () => {
  console.log('[redirect] shutting down');
  server.close(() => redis.quit().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
