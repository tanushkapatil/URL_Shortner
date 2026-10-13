#!/usr/bin/env node
// Zero-dependency load generator (Node 18+).
//
//   node loadtest/loadtest.js                          # 20s, 50 connections, against localhost:8080
//   node loadtest/loadtest.js --base http://localhost:30080 --duration 60 --concurrency 100
//   node loadtest/loadtest.js --code myalias --mode resolve
//
// --mode redirect (default) hits /<code> and counts clicks (exercises the whole pipeline:
//   gateway -> redirect replicas -> Redis cache -> Redis Stream -> analytics consumers).
// --mode resolve hits /api/resolve/<code> (read-only, no click events).

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const BASE = String(args.base || 'http://localhost:8080').replace(/\/$/, '');
const DURATION = Number(args.duration || 20) * 1000;
const CONCURRENCY = Number(args.concurrency || 50);
const MODE = args.mode === 'resolve' ? 'resolve' : 'redirect';

async function ensureCode() {
  if (args.code && args.code !== true) return args.code;
  const res = await fetch(`${BASE}/api/shorten`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/load-test' }),
  });
  if (!res.ok) throw new Error(`could not create a test link: ${res.status} ${await res.text()}`);
  const { code } = await res.json();
  console.log(`created test link /${code}`);
  return code;
}

async function main() {
  const code = await ensureCode();
  const url = MODE === 'resolve' ? `${BASE}/api/resolve/${code}` : `${BASE}/${code}`;
  console.log(`load testing ${url}\n${CONCURRENCY} connections for ${DURATION / 1000}s...\n`);

  const latencies = [];
  const statuses = {};
  const byInstance = {};
  const cache = { HIT: 0, MISS: 0 };
  let errors = 0;
  const end = Date.now() + DURATION;
  const perSecond = [];
  let thisSecond = 0;
  const ticker = setInterval(() => {
    perSecond.push(thisSecond);
    process.stdout.write(`\r  ${perSecond.length}s  ${thisSecond} req/s  (total ${latencies.length})   `);
    thisSecond = 0;
  }, 1000);

  async function worker() {
    while (Date.now() < end) {
      const t = performance.now();
      try {
        const res = await fetch(url, { redirect: 'manual' });
        await res.arrayBuffer();
        latencies.push(performance.now() - t);
        thisSecond++;
        statuses[res.status] = (statuses[res.status] || 0) + 1;
        const inst = res.headers.get('x-served-by') || 'unknown';
        byInstance[inst] = (byInstance[inst] || 0) + 1;
        const c = res.headers.get('x-cache');
        if (c) cache[c] = (cache[c] || 0) + 1;
      } catch {
        errors++;
      }
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearInterval(ticker);
  const secs = (Date.now() - t0) / 1000;

  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))].toFixed(1) : '-');
  console.log('\n\n=== results ===');
  console.log(`requests      ${latencies.length} in ${secs.toFixed(1)}s  ->  ${(latencies.length / secs).toFixed(0)} req/s`);
  console.log(`latency (ms)  p50 ${pct(0.5)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${pct(1)}`);
  console.log(`status codes  ${JSON.stringify(statuses)}   network errors: ${errors}`);
  if (MODE === 'redirect') console.log(`cache         ${cache.HIT} hits / ${cache.MISS} misses`);
  console.log('\nrequests per replica (X-Served-By):');
  const total = Object.values(byInstance).reduce((a, b) => a + b, 0) || 1;
  for (const [inst, n] of Object.entries(byInstance).sort((a, b) => b[1] - a[1])) {
    const pctShare = (n / total) * 100;
    console.log(`  ${inst.padEnd(40)} ${String(n).padStart(7)}  ${pctShare.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pctShare / 2))}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
