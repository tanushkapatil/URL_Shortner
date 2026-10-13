// Analytics service: owns the `clicks` table. Consumes click events from the Redis
// Stream and serves click statistics over REST.
const express = require('express');
const os = require('os');
const Redis = require('ioredis');
const { pool, waitForDb, migrate } = require('./db');
const { startConsumer, storeEvents, STREAM, GROUP } = require('./consumer');

const PORT = Number(process.env.PORT || 3003);
const INSTANCE = os.hostname();
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS clicks (
    id           BIGSERIAL   PRIMARY KEY,
    event_id     TEXT        NOT NULL UNIQUE,
    code         VARCHAR(30) NOT NULL,
    clicked_at   TIMESTAMPTZ NOT NULL,
    referrer     TEXT,
    user_agent   TEXT,
    served_by    TEXT,
    processed_by TEXT
  );
  CREATE INDEX IF NOT EXISTS clicks_code_time_idx ON clicks (code, clicked_at DESC);
  CREATE INDEX IF NOT EXISTS clicks_time_idx ON clicks (clicked_at DESC);
`;

// Non-blocking client for queue inspection (the consumer has its own blocking connection).
const redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
let redisUp = false;
redis.on('ready', () => { redisUp = true; console.log('[redis] connected'); });
redis.on('error', (err) => { if (redisUp) console.error('[redis] connection lost:', err.message); redisUp = false; });

let consumer;
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { res.set('X-Served-By', INSTANCE); next(); });

const CODE_RE = /^[A-Za-z0-9_-]{3,30}$/;

// Batch click counts, called by the shortener service when listing links.
app.post('/internal/counts', async (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes.filter((c) => CODE_RE.test(c)).slice(0, 200) : [];
  if (codes.length === 0) return res.json({ counts: {} });
  try {
    const { rows } = await pool.query(
      'SELECT code, COUNT(*)::int AS n FROM clicks WHERE code = ANY($1) GROUP BY code',
      [codes],
    );
    res.json({ counts: Object.fromEntries(rows.map((r) => [r.code, r.n])) });
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// Fallback ingestion path used by the redirect service when Redis is unreachable.
app.post('/internal/clicks', async (req, res) => {
  const e = req.body || {};
  if (!CODE_RE.test(e.code || '') || !e.eventId) return res.status(400).json({ error: 'invalid event' });
  try {
    await storeEvents([{
      eventId: String(e.eventId), code: e.code, ts: Number(e.ts) || Date.now(),
      referrer: e.referrer || null, ua: e.ua || null, instance: e.instance || null,
    }], `${INSTANCE} (direct)`);
    res.status(202).json({ accepted: true });
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/stats/:code', async (req, res) => {
  const { code } = req.params;
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'invalid code' });
  try {
    const [total, timeline, referrers, instances, recent] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n, MAX(clicked_at) AS last FROM clicks WHERE code = $1', [code]),
      pool.query(
        `SELECT m AS minute, COUNT(c.id)::int AS count
           FROM generate_series(date_trunc('minute', now()) - interval '59 minutes',
                                date_trunc('minute', now()), interval '1 minute') AS m
           LEFT JOIN clicks c ON c.code = $1 AND c.clicked_at >= m AND c.clicked_at < m + interval '1 minute'
          GROUP BY m ORDER BY m`,
        [code],
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(referrer, ''), '(direct)') AS referrer, COUNT(*)::int AS count
           FROM clicks WHERE code = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        [code],
      ),
      pool.query(
        `SELECT served_by AS instance, COUNT(*)::int AS count
           FROM clicks WHERE code = $1 GROUP BY 1 ORDER BY 2 DESC`,
        [code],
      ),
      pool.query(
        `SELECT clicked_at, referrer, served_by, processed_by
           FROM clicks WHERE code = $1 ORDER BY clicked_at DESC LIMIT 8`,
        [code],
      ),
    ]);
    res.json({
      code,
      total: total.rows[0].n,
      lastClickAt: total.rows[0].last,
      lastHour: timeline.rows,
      referrers: referrers.rows,
      servedBy: instances.rows,
      recent: recent.rows,
    });
  } catch (err) {
    console.error('[stats] failed:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

const pairs = (arr) => {
  const o = {};
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
};

async function queueInfo() {
  try {
    const length = await redis.xlen(STREAM);
    const groups = (await redis.xinfo('GROUPS', STREAM)).map(pairs);
    const group = groups.find((g) => g.name === GROUP) || {};
    const consumers = group.name
      ? (await redis.xinfo('CONSUMERS', STREAM, GROUP)).map(pairs).map((c) => ({
        name: c.name, pending: c.pending, idleMs: c.idle,
      }))
      : [];
    return { available: true, length, pending: group.pending ?? 0, lag: group.lag ?? null, consumers };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

app.get('/api/stats', async (req, res) => {
  try {
    const [totals, top, byInstance, byProcessor, queue] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE clicked_at > now() - interval '1 hour')::int AS last_hour,
                         COUNT(*) FILTER (WHERE clicked_at > now() - interval '1 minute')::int AS last_minute
                    FROM clicks`),
      pool.query('SELECT code, COUNT(*)::int AS count FROM clicks GROUP BY code ORDER BY count DESC LIMIT 5'),
      pool.query(`SELECT served_by AS instance, COUNT(*)::int AS count FROM clicks
                   WHERE clicked_at > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC`),
      pool.query(`SELECT processed_by AS instance, COUNT(*)::int AS count FROM clicks
                   WHERE clicked_at > now() - interval '1 hour' GROUP BY 1 ORDER BY 2 DESC`),
      queueInfo(),
    ]);
    res.json({
      totalClicks: totals.rows[0].total,
      clicksLastHour: totals.rows[0].last_hour,
      clicksLastMinute: totals.rows[0].last_minute,
      topLinks: top.rows,
      redirectInstances: byInstance.rows,
      analyticsInstances: byProcessor.rows,
      queue,
      servedBy: INSTANCE,
    });
  } catch (err) {
    console.error('[stats] overview failed:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
});

const startedAt = Date.now();
app.get('/live', (req, res) => res.json({ status: 'alive' }));
app.get('/health', async (req, res) => {
  let db = 'up';
  try { await pool.query('SELECT 1'); } catch { db = 'down'; }
  res.status(db === 'up' ? 200 : 503).json({
    service: 'analytics',
    status: db === 'up' ? 'ok' : 'degraded',
    instance: INSTANCE,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    dependencies: { postgres: db, redis: redisUp ? 'up' : 'down' },
    consumer: consumer && {
      processed: consumer.state.processed,
      duplicatesSkipped: consumer.state.duplicates,
      reclaimed: consumer.state.reclaimed,
      lastError: consumer.state.lastError,
    },
  });
});

async function main() {
  await waitForDb();
  await migrate(SCHEMA, 1002);
  consumer = startConsumer(REDIS_URL, INSTANCE);
  const server = app.listen(PORT, () => console.log(`[analytics] ${INSTANCE} listening on :${PORT}`));

  const shutdown = () => {
    console.log('[analytics] shutting down');
    server.close(() => Promise.allSettled([consumer.stop(), pool.end(), redis.quit()]).then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[analytics] fatal:', err);
  process.exit(1);
});
