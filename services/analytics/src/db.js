const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://urlshort:urlshort@postgres:5432/urlshort',
  max: Number(process.env.DB_POOL_SIZE || 10),
  connectionTimeoutMillis: 3000,
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Postgres may still be booting when this container starts (especially in Kubernetes,
// where there is no depends_on), so retry instead of crashing.
async function waitForDb(retries = 30) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log('[db] connected');
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.log(`[db] not ready (${err.message}), retry ${attempt}/${retries}`);
      await sleep(2000);
    }
  }
}

// Every replica runs migrations on boot. An advisory lock makes sure only one
// replica executes the DDL at a time, so concurrent CREATE TABLEs cannot race.
async function migrate(sql, lockId) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    client.release();
  }
}

module.exports = { pool, waitForDb, migrate };
