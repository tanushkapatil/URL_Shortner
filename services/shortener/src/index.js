// Shortener service: owns the `urls` table. Creates, lists and deletes short links.
const express = require('express');
const os = require('os');
const Redis = require('ioredis');
const { pool, waitForDb, migrate } = require('./db');
const { encode } = require('./codegen');

const PORT = Number(process.env.PORT || 3001);
const INSTANCE = os.hostname();
const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://analytics:3003';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const ALIAS_RE = /^[A-Za-z0-9_-]{3,30}$/;
const RESERVED = new Set(['api', 'health', 'healthz', 'static', 'internal', 'index', 'favicon', 'admin']);
const MAX_EXPIRY_MIN = 525600; // one year

const SCHEMA = `
  CREATE SEQUENCE IF NOT EXISTS url_id_seq START 1000;
  CREATE TABLE IF NOT EXISTS urls (
    code        VARCHAR(30) PRIMARY KEY,
    long_url    TEXT        NOT NULL,
    custom      BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    created_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS urls_created_at_idx ON urls (created_at DESC);
`;

// Redis is used for the shared rate limiter and for cache invalidation.
// Commands fail fast while Redis is down instead of queueing forever.
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
let redisUp = false;
redis.on('ready', () => { redisUp = true; console.log('[redis] connected'); });
redis.on('error', (err) => { if (redisUp) console.error('[redis] connection lost:', err.message); redisUp = false; });

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => { res.set('X-Served-By', INSTANCE); next(); });

const toDto = (row, base) => ({
  code: row.code,
  shortUrl: base ? `${base}/${row.code}` : undefined,
  longUrl: row.long_url,
  custom: row.custom,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  createdBy: row.created_by,
});

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// Fixed-window rate limiter whose counter lives in Redis, so the limit holds across
// ALL shortener replicas (a per-process counter could be bypassed by load balancing).
// If Redis is down we fail open: availability matters more than strict limiting here.
async function rateLimit(req, res, next) {
  const ip = req.get('x-real-ip') || req.ip;
  const key = `ratelimit:${ip}:${Math.floor(Date.now() / 60000)}`;
  try {
    const [[, count]] = await redis.multi().incr(key).expire(key, 60).exec();
    res.set('X-RateLimit-Limit', String(RATE_LIMIT_PER_MIN));
    res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_PER_MIN - count)));
    if (count > RATE_LIMIT_PER_MIN) {
      return res.status(429).json({ error: `Rate limit exceeded (${RATE_LIMIT_PER_MIN}/min). Try again shortly.` });
    }
  } catch {
    // fail open
  }
  next();
}

async function invalidateCache(code) {
  try { await redis.del(`url:${code}`); } catch { /* entry expires on its own */ }
}

app.post('/api/shorten', rateLimit, async (req, res) => {
  const { url, alias, expiresInMinutes } = req.body || {};

  let parsed;
  try { parsed = new URL(String(url || '').trim()); } catch { /* handled below */ }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.href.length > 2048) {
    return res.status(400).json({ error: 'Please provide a valid http(s) URL (max 2048 chars).' });
  }

  let expiresAt = null;
  if (expiresInMinutes !== undefined && expiresInMinutes !== null && expiresInMinutes !== '') {
    const minutes = Number(expiresInMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRY_MIN) {
      return res.status(400).json({ error: `expiresInMinutes must be an integer between 1 and ${MAX_EXPIRY_MIN}.` });
    }
    expiresAt = new Date(Date.now() + minutes * 60000);
  }

  const insert = (code, custom) => pool.query(
    `INSERT INTO urls (code, long_url, custom, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [code, parsed.href, custom, expiresAt, INSTANCE],
  );

  try {
    let row;
    if (alias) {
      if (!ALIAS_RE.test(alias) || RESERVED.has(alias.toLowerCase())) {
        return res.status(400).json({ error: 'Alias must be 3-30 letters, digits, "-" or "_", and not a reserved word.' });
      }
      try {
        ({ rows: [row] } = await insert(alias, true));
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: `Alias "${alias}" is already taken.` });
        throw err;
      }
    } else {
      // A generated code can only clash with a custom alias someone picked earlier;
      // in that case just take the next sequence value.
      for (let attempt = 0; !row && attempt < 5; attempt++) {
        const { rows: [{ id }] } = await pool.query("SELECT nextval('url_id_seq') AS id");
        try {
          ({ rows: [row] } = await insert(encode(id), false));
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      if (!row) throw new Error('could not allocate a unique code');
    }

    // The redirect service may hold a cached "not found" for this code.
    await invalidateCache(row.code);
    console.log(`[shorten] ${row.code} -> ${row.long_url}`);
    res.status(201).json({ ...toDto(row, publicBase(req)), servedBy: INSTANCE });
  } catch (err) {
    console.error('[shorten] failed:', err.message);
    res.status(503).json({ error: 'Could not save the link right now. Please retry.' });
  }
});

// Ask the analytics service for click counts. If it is down or slow we still return
// the links, just without counts (graceful degradation instead of a failed page).
async function fetchClickCounts(codes) {
  if (codes.length === 0) return { counts: {}, available: true };
  try {
    const r = await fetch(`${ANALYTICS_URL}/internal/counts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes }),
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) throw new Error(`analytics responded ${r.status}`);
    const { counts } = await r.json();
    return { counts, available: true };
  } catch (err) {
    console.warn('[urls] analytics unavailable:', err.message);
    return { counts: {}, available: false };
  }
}

app.get('/api/urls', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  try {
    const { rows } = await pool.query('SELECT * FROM urls ORDER BY created_at DESC LIMIT $1', [limit]);
    const { counts, available } = await fetchClickCounts(rows.map((r) => r.code));
    const base = publicBase(req);
    res.json({
      urls: rows.map((r) => ({ ...toDto(r, base), clicks: available ? counts[r.code] || 0 : null })),
      analyticsAvailable: available,
      servedBy: INSTANCE,
    });
  } catch (err) {
    console.error('[urls] list failed:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.delete('/api/urls/:code', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM urls WHERE code = $1', [req.params.code]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    await invalidateCache(req.params.code);
    res.status(204).end();
  } catch (err) {
    console.error('[urls] delete failed:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// Internal API used by the redirect service on a cache miss. Not exposed by the gateway.
app.get('/internal/urls/:code', async (req, res) => {
  try {
    const { rows: [row] } = await pool.query('SELECT * FROM urls WHERE code = $1', [req.params.code]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(toDto(row));
  } catch (err) {
    console.error('[internal] lookup failed:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

const startedAt = Date.now();
app.get('/live', (req, res) => res.json({ status: 'alive' }));
app.get('/health', async (req, res) => {
  let db = 'up';
  try { await pool.query('SELECT 1'); } catch { db = 'down'; }
  res.status(db === 'up' ? 200 : 503).json({
    service: 'shortener',
    status: db === 'up' ? 'ok' : 'degraded',
    instance: INSTANCE,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    dependencies: { postgres: db, redis: redisUp ? 'up' : 'down' },
  });
});

async function main() {
  await waitForDb();
  await migrate(SCHEMA, 1001);
  const server = app.listen(PORT, () => console.log(`[shortener] ${INSTANCE} listening on :${PORT}`));

  const shutdown = () => {
    console.log('[shortener] shutting down');
    server.close(() => Promise.allSettled([pool.end(), redis.quit()]).then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[shortener] fatal:', err);
  process.exit(1);
});
