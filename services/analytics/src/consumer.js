// Click-event consumer built on a Redis Streams *consumer group*.
//
// - Every analytics replica joins the same group, so each event is delivered to exactly
//   one replica (work is shared, not duplicated) -> the consumer scales horizontally.
// - An event is only XACKed after it is safely stored in Postgres. If a replica crashes
//   mid-batch, its un-acked events stay "pending" and another replica reclaims them
//   with XAUTOCLAIM -> no clicks are lost.
// - Redelivery means an event may be processed twice (at-least-once delivery), so the
//   insert is idempotent: the stream message ID is a UNIQUE column + ON CONFLICT DO NOTHING.
const Redis = require('ioredis');
const { pool } = require('./db');

const STREAM = 'clicks';
const GROUP = 'analytics';
const BATCH = 100;
const BLOCK_MS = 5000;
const RECLAIM_IDLE_MS = 30000;
const RECLAIM_EVERY_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toEvent(id, fields) {
  const f = {};
  for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  return {
    eventId: id,
    code: f.code,
    ts: Number(f.ts) || Date.now(),
    referrer: f.referrer || null,
    ua: f.ua || null,
    instance: f.instance || null,
  };
}

async function storeEvents(events, processedBy) {
  const valid = events.filter((e) => e.code);
  if (valid.length === 0) return 0;
  const values = [];
  const params = [];
  valid.forEach((e, i) => {
    const p = i * 7;
    values.push(`($${p + 1}, $${p + 2}, to_timestamp($${p + 3}::double precision / 1000), $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7})`);
    params.push(e.eventId, e.code, e.ts, e.referrer, e.ua, e.instance, processedBy);
  });
  const { rowCount } = await pool.query(
    `INSERT INTO clicks (event_id, code, clicked_at, referrer, user_agent, served_by, processed_by)
     VALUES ${values.join(',')} ON CONFLICT (event_id) DO NOTHING`,
    params,
  );
  return rowCount;
}

function startConsumer(redisUrl, consumerName) {
  // A dedicated connection: XREADGROUP BLOCK holds the connection while waiting.
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', () => {}); // reconnects automatically; failures surface in the loop below
  const state = { running: true, processed: 0, duplicates: 0, reclaimed: 0, lastError: null };

  async function handle(entries) {
    if (!entries || entries.length === 0) return;
    const events = entries.filter(([, fields]) => fields).map(([id, fields]) => toEvent(id, fields));
    const inserted = await storeEvents(events, consumerName);
    // Ack everything we read (including malformed entries, which would otherwise loop forever).
    await redis.xack(STREAM, GROUP, ...entries.map(([id]) => id));
    state.processed += inserted;
    state.duplicates += events.length - inserted;
  }

  async function ensureGroup() {
    try {
      await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
      console.log(`[consumer] created group "${GROUP}" on stream "${STREAM}"`);
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
  }

  async function reclaimStale() {
    // Take over events another (probably dead) consumer received but never acked.
    const [, entries] = await redis.call('XAUTOCLAIM', STREAM, GROUP, consumerName, RECLAIM_IDLE_MS, '0-0', 'COUNT', BATCH);
    if (entries && entries.length) {
      console.log(`[consumer] reclaimed ${entries.length} stale event(s)`);
      state.reclaimed += entries.length;
      await handle(entries);
    }
  }

  (async function loop() {
    let groupReady = false;
    let lastReclaim = 0;
    while (state.running) {
      try {
        if (!groupReady) { await ensureGroup(); groupReady = true; }
        if (Date.now() - lastReclaim > RECLAIM_EVERY_MS) { lastReclaim = Date.now(); await reclaimStale(); }
        const res = await redis.xreadgroup('GROUP', GROUP, consumerName, 'COUNT', BATCH, 'BLOCK', BLOCK_MS, 'STREAMS', STREAM, '>');
        if (res) await handle(res[0][1]);
        state.lastError = null;
      } catch (err) {
        if (!state.running) break;
        if (state.lastError !== err.message) console.error('[consumer] error:', err.message);
        state.lastError = err.message;
        if (String(err.message).includes('NOGROUP')) groupReady = false; // stream was wiped
        await sleep(2000);
      }
    }
  })();

  return {
    state,
    redis,
    stop: async () => { state.running = false; redis.disconnect(); },
  };
}

module.exports = { startConsumer, storeEvents, STREAM, GROUP };
