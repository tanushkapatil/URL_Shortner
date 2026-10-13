// Front-end for the distributed URL shortener. Talks only to the gateway.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n == null ? '–' : Number(n).toLocaleString());

let selectedCode = null;
let links = [];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const gw = res.headers.get('x-gateway');
  if (gw) $('#gateway-id').textContent = gw;
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function relTime(date) {
  if (!date) return 'never';
  const diff = (new Date(date) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const [v, u] = abs < 60 ? [abs, 'second'] : abs < 3600 ? [abs / 60, 'minute'] : abs < 86400 ? [abs / 3600, 'hour'] : [abs / 86400, 'day'];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff < 0 ? -v : v), u);
}
const isExpired = (l) => l.expiresAt && new Date(l.expiresAt) <= new Date();

function bars(rows, labelKey, valueKey = 'count') {
  if (!rows || rows.length === 0) return '<p class="empty">No data yet.</p>';
  const max = Math.max(...rows.map((r) => r[valueKey]), 1);
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row">
      <span class="label" title="${esc(r[labelKey])}">${esc(r[labelKey] ?? 'unknown')}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(r[valueKey] / max) * 100}%"></div></div>
      <span class="num">${fmtNum(r[valueKey])}</span>
    </div>`).join('')}</div>`;
}

// ---------- health pills ----------
async function refreshHealth() {
  await Promise.all(['shortener', 'redirect', 'analytics'].map(async (svc) => {
    const pill = document.querySelector(`.pill[data-svc="${svc}"]`);
    try {
      const res = await fetch(`/health/${svc}`, { signal: AbortSignal.timeout(3000) });
      const h = await res.json();
      pill.className = `pill ${h.status === 'ok' ? 'ok' : 'degraded'}`;
      const deps = Object.entries(h.dependencies || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      pill.title = `${svc} @ ${h.instance}\nstatus: ${h.status}\n${deps}`;
    } catch {
      pill.className = 'pill down';
      pill.title = `${svc}: unreachable`;
    }
  }));
}

// ---------- shorten ----------
$('#shorten-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#shorten-btn');
  const result = $('#result');
  btn.disabled = true;
  try {
    const body = { url: $('#url').value.trim() };
    if ($('#alias').value.trim()) body.alias = $('#alias').value.trim();
    if ($('#expiry').value) body.expiresInMinutes = Number($('#expiry').value);
    const link = await api('/api/shorten', { method: 'POST', body: JSON.stringify(body) });
    result.className = 'result';
    result.innerHTML = `
      <a href="${esc(link.shortUrl)}" target="_blank" rel="noopener">${esc(link.shortUrl)}</a>
      <button type="button" class="ghost" id="copy-btn">Copy</button>
      <span class="meta">→ ${esc(link.longUrl)} · created by <span class="mono">${esc(link.servedBy)}</span>
      ${link.expiresAt ? ` · expires ${esc(relTime(link.expiresAt))}` : ''}</span>`;
    $('#copy-btn').onclick = async () => {
      await navigator.clipboard.writeText(link.shortUrl).catch(() => {});
      $('#copy-btn').textContent = 'Copied!';
    };
    $('#shorten-form').reset();
    selectedCode = link.code;
    await loadLinks();
    loadStats();
  } catch (err) {
    result.className = 'result error';
    result.textContent = err.message;
  } finally {
    result.hidden = false;
    btn.disabled = false;
  }
});

// ---------- links table ----------
async function loadLinks() {
  const tbody = $('#links-body');
  try {
    const data = await api('/api/urls?limit=25');
    links = data.urls;
    $('#links-note').innerHTML = data.analyticsAvailable
      ? `listed by <span class="mono">${esc(data.servedBy)}</span>`
      : '<span class="status-bad">analytics unavailable: click counts hidden, redirects still work</span>';
    if (links.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">No links yet. Shorten one above.</td></tr>';
    } else {
      tbody.innerHTML = links.map((l) => `
        <tr data-code="${esc(l.code)}" class="${l.code === selectedCode ? 'selected' : ''}">
          <td><a href="/${esc(l.code)}" target="_blank" rel="noopener" class="mono">/${esc(l.code)}</a>${l.custom ? '<span class="tag">alias</span>' : ''}</td>
          <td class="dest" title="${esc(l.longUrl)}">${esc(l.longUrl)}</td>
          <td class="num">${l.clicks == null ? '–' : fmtNum(l.clicks)}</td>
          <td>${isExpired(l) ? '<span class="tag expired">expired</span>' : esc(l.expiresAt ? relTime(l.expiresAt) : 'never')}</td>
          <td class="actions"><button class="ghost danger" data-del="${esc(l.code)}" title="Delete link">Delete</button></td>
        </tr>`).join('');
    }
    fillLbSelect();
  } catch (err) {
    $('#links-note').innerHTML = `<span class="status-bad">${esc(err.message)}</span>`;
    if (links.length === 0) tbody.innerHTML = '<tr><td colspan="5" class="empty">Shortener service unavailable.</td></tr>';
  }
}

$('#links-body').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm(`Delete /${del.dataset.del}?`)) return;
    try {
      await api(`/api/urls/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      if (selectedCode === del.dataset.del) selectedCode = null;
      loadLinks();
      loadStats();
    } catch (err) { alert(err.message); }
    return;
  }
  if (e.target.closest('a')) return; // let the short link open normally
  const row = e.target.closest('tr[data-code]');
  if (!row) return;
  selectedCode = row.dataset.code;
  document.querySelectorAll('#links-body tr').forEach((r) => r.classList.toggle('selected', r === row));
  loadStats();
});

// ---------- per-link analytics ----------
async function loadStats() {
  const box = $('#stats');
  $('#stats-code').textContent = selectedCode ? `/${selectedCode}` : '';
  if (!selectedCode) {
    box.innerHTML = '<p class="empty">Select a link to see its clicks.</p>';
    return;
  }
  try {
    const s = await api(`/api/stats/${encodeURIComponent(selectedCode)}`);
    const max = Math.max(...s.lastHour.map((m) => m.count), 1);
    box.innerHTML = `
      <div class="kpis">
        <div class="kpi"><b>${fmtNum(s.total)}</b><span>total clicks</span></div>
        <div class="kpi"><b>${fmtNum(s.lastHour.reduce((a, m) => a + m.count, 0))}</b><span>last hour</span></div>
        <div class="kpi"><b>${s.lastClickAt ? esc(relTime(s.lastClickAt)) : '–'}</b><span>last click</span></div>
      </div>
      <h3>Clicks per minute, last 60 min</h3>
      <div class="spark">${s.lastHour.map((m) => `<div style="height:${(m.count / max) * 100}%" title="${new Date(m.minute).toLocaleTimeString()}: ${m.count}"></div>`).join('')}</div>
      <div class="spark-axis"><span>60 min ago</span><span>now</span></div>
      <h3>Redirects served by replica</h3>
      ${bars(s.servedBy, 'instance')}
      <h3>Top referrers</h3>
      ${bars(s.referrers, 'referrer')}`;
  } catch (err) {
    box.innerHTML = `<p class="empty status-bad">Analytics unavailable (${esc(err.message)}).<br>Clicks are buffered in the queue and will appear once it recovers.</p>`;
  }
}

// ---------- cluster overview ----------
async function loadOverview() {
  const box = $('#overview');
  try {
    const o = await api('/api/stats');
    const q = o.queue;
    box.innerHTML = `
      <div class="kpis">
        <div class="kpi"><b>${fmtNum(o.totalClicks)}</b><span>clicks stored</span></div>
        <div class="kpi"><b>${fmtNum(o.clicksLastMinute)}</b><span>last minute</span></div>
        <div class="kpi"><b>${q.available ? fmtNum(q.lag ?? 0) : '–'}</b><span>queue backlog</span></div>
        <div class="kpi"><b>${q.available ? fmtNum(q.pending) : '–'}</b><span>in-flight (un-acked)</span></div>
      </div>
      <h3>Redirect replicas (clicks, last hour)</h3>
      ${bars(o.redirectInstances, 'instance')}
      <h3>Analytics consumers</h3>
      ${q.available
        ? (q.consumers.length
          ? `<ul class="list">${q.consumers.map((c) => `<li><span class="mono">${esc(c.name)}</span><span>${fmtNum(c.pending)} pending · idle ${Math.round(c.idleMs / 1000)}s</span></li>`).join('')}</ul>`
          : '<p class="empty">No consumers registered yet.</p>')
        : `<p class="empty status-bad">Queue unavailable: ${esc(q.error)}</p>`}
      <p class="note">Overview computed by <span class="mono">${esc(o.servedBy)}</span></p>`;
  } catch (err) {
    box.innerHTML = `<p class="empty status-bad">Analytics service unavailable (${esc(err.message)}).</p>`;
  }
}

// ---------- load-balancing demo ----------
function fillLbSelect() {
  const sel = $('#lb-code');
  const current = sel.value;
  const usable = links.filter((l) => !isExpired(l));
  sel.innerHTML = usable.length
    ? usable.map((l) => `<option value="${esc(l.code)}">/${esc(l.code)} → ${esc(l.longUrl.slice(0, 50))}</option>`).join('')
    : '<option value="">Create a link first</option>';
  // Follow the link selected in the table until the user picks one here explicitly.
  const preferred = sel.dataset.touched ? current : selectedCode || current;
  if (usable.some((l) => l.code === preferred)) sel.value = preferred;
}
$('#lb-code').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });

$('#lb-run').addEventListener('click', async () => {
  const code = $('#lb-code').value;
  const n = Math.min(Math.max(Number($('#lb-count').value) || 60, 1), 500);
  const out = $('#lb-result');
  if (!code) { out.innerHTML = '<p class="empty">Create a link first.</p>'; return; }
  const btn = $('#lb-run');
  btn.disabled = true;
  out.innerHTML = `<p class="empty">Sending ${n} requests…</p>`;

  const byInstance = {};
  let hits = 0; let misses = 0; let failed = 0; const latencies = [];
  const t0 = performance.now();
  let next = 0;
  async function worker() {
    while (next < n) {
      next++;
      const start = performance.now();
      try {
        const res = await fetch(`/api/resolve/${encodeURIComponent(code)}`, { cache: 'no-store' });
        const body = await res.json();
        latencies.push(performance.now() - start);
        if (!res.ok) throw new Error();
        byInstance[body.servedBy] = (byInstance[body.servedBy] || 0) + 1;
        if (body.cache === 'HIT') hits++; else misses++;
      } catch { failed++; }
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker)); // 10 concurrent connections
  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))].toFixed(1) : '–');
  const rows = Object.entries(byInstance).map(([instance, count]) => ({ instance, count })).sort((a, b) => b.count - a.count);

  out.innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${rows.length}</b><span>replicas answered</span></div>
      <div class="kpi"><b>${(n / elapsed).toFixed(0)}</b><span>requests / sec</span></div>
      <div class="kpi"><b>${pct(0.5)} ms</b><span>p50 latency</span></div>
      <div class="kpi"><b>${pct(0.95)} ms</b><span>p95 latency</span></div>
      <div class="kpi"><b>${hits}/${hits + misses}</b><span>cache hits</span></div>
      <div class="kpi"><b class="${failed ? 'status-bad' : 'status-ok'}">${failed}</b><span>failed</span></div>
    </div>
    <h3>Requests per redirect replica</h3>
    ${bars(rows, 'instance')}`;
  btn.disabled = false;
});

// ---------- polling ----------
async function tick() {
  await Promise.allSettled([refreshHealth(), loadLinks(), loadOverview(), selectedCode ? loadStats() : null]);
}
tick();
setInterval(() => { if (!document.hidden) tick(); }, 4000);
