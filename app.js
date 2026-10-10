// ─── CONFIG ───────────────────────────────────────────────
// Webshops are no longer typed in by hand: every webshop in Stamhoofd is
// fetched live (see discoverWebshops below) and shown automatically, so a
// new production's webshop just appears — nothing to configure. The admin
// can still hide specific webshops (e.g. "Barbecue", "Jaarvergadering")
// via hiddenWebshopIds, centrally managed through the Worker.
const DEFAULTS = {
  orgId: 'd42b36a2-a20f-4930-b677-5d62599c90b3',
  hiddenWebshopIds: [],

  capacity: 240,
  proxyUrl: 'https://kvk-dashboard.j-verley.workers.dev',
};

// Merge saved settings from localStorage over defaults.
// NOTE: orgId/hiddenWebshopIds are intentionally excluded here — those are
// centrally managed by the admin via the Worker's /config endpoint (see
// loadRemoteConfig below), so every visitor sees the same values instead
// of whatever happens to be cached in their own browser.
const saved = JSON.parse(localStorage.getItem('theatre_dashboard_config') || '{}');
const CONFIG = { ...DEFAULTS, proxyUrl: saved.proxyUrl || DEFAULTS.proxyUrl };

// Fetch the centrally-stored orgId/hiddenWebshopIds from the Worker. Falls
// back to DEFAULTS (above) if the Worker has nothing stored yet, or if the
// request fails for any reason, so the dashboard keeps working either way.
async function loadRemoteConfig() {
  try {
    const res = await workerFetch('/config');
    const data = await res.json();
    if (data.orgId) CONFIG.orgId = data.orgId;
    if (Array.isArray(data.hiddenWebshopIds)) {
      CONFIG.hiddenWebshopIds = data.hiddenWebshopIds;
    }
  } catch(e) { /* keep DEFAULTS */ }
}

// Fetches every webshop Stamhoofd knows about for this organisation —
// this is what makes new productions appear automatically, with no admin
// step required. Paginated the same way as orders (sort + limit + the
// `next` cursor the API hands back).
// Short-lived cache so a settings-panel open during a page load (or the
// 5-minute auto-refresh overlapping a manual refresh) doesn't fire the
// same /webshops listing twice at once.
let _webshopsCache = null;
let _webshopsCacheAt = 0;
const WEBSHOPS_CACHE_MS = 15000;

async function fetchAllWebshops() {
  if (_webshopsCache && Date.now() - _webshopsCacheAt < WEBSHOPS_CACHE_MS) {
    return _webshopsCache;
  }
  const seenIds = new Set();
  const all = [];
  let params = { sort: 'createdAt DESC,id ASC', limit: '100' };
  while (true) {
    const inner = new URL(`${apiBase()}/webshops`);
    for (const [k, v] of Object.entries(params)) inner.searchParams.set(k, v);
    const res = await fetchWithTimeout(proxied(inner.toString()), { headers: headers() }, 15000);
    if (!res.ok) await throwApiError(res, `Webshops API ${res.status}`);
    const page = await res.json();
    const items = page.results || [];
    for (const item of items) {
      const ws = item.webshop || item;
      if (!seenIds.has(ws.id)) { seenIds.add(ws.id); all.push(ws); }
    }
    if (!page.next) break;
    params = page.next;
  }
  _webshopsCache = all;
  _webshopsCacheAt = Date.now();
  return all;
}

// Live-discovers the webshops to show as tabs: every webshop Stamhoofd
// knows about, minus whichever ones the admin has hidden.
// archived=false (default): only "Open" webshops — this is what loads on
// every visit. archived=true: only "Archived" ones — only ever fetched
// when the admin explicitly asks for the archive (see toggleArchive), so
// years of old productions never slow down the normal dashboard.
async function discoverWebshops(archived = false) {
  const all = await fetchAllWebshops();
  const hidden = new Set(CONFIG.hiddenWebshopIds || []);
  const wantStatus = archived ? 'Archived' : 'Open';
  return all
    .filter(ws => !hidden.has(ws.id))
    .filter(ws => (ws.meta?.status || 'Open') === wantStatus)
    .map(ws => ({ id: ws.id, name: ws.meta?.name || ws.name || 'Webshop' }));
}

function apiBase() {
  return `https://${CONFIG.orgId}.api.stamhoofd.app/v421`;
}

// Wraps a URL through the CORS proxy if one is configured
function proxied(url) {
  if (CONFIG.proxyUrl) {
    return CONFIG.proxyUrl + '/proxy?url=' + encodeURIComponent(url);
  }
  return url;
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const adminToken = sessionStorage.getItem('kvk_admin_token');
  if (adminToken) {
    h['X-Admin-Token'] = adminToken;
  } else {
    const sessionToken = getSessionToken();
    if (sessionToken) h['X-Session-Token'] = sessionToken;
  }
  return h;
}

// ─── UI HELPERS ───────────────────────────────────────────
function setStatus(msg, type = 'loading') {
  const bar = document.getElementById('statusBar');
  bar.textContent = msg;
  bar.className = `status-bar ${type}`;
}

function fmt(cents) {
  return '€ ' + (cents / 10000).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('nl-BE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function toggleDebug() {
  const p = document.getElementById('debugPanel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

function logDebug(msg) {
  const p = document.getElementById('debugPanel');
  p.textContent += msg + '\n';
}

async function toggleConfig() {
  const p = document.getElementById('configPanel');
  const visible = p.classList.toggle('visible');
  if (visible) {
    document.getElementById('cfgOrgId').value = CONFIG.orgId;
    document.getElementById('cfgProxyUrl').value = CONFIG.proxyUrl || '';
    renderUserList();
    await renderWebshopChecklist();
  }
}

// Shows every webshop Stamhoofd knows about as a checkbox, pre-checked
// unless it's in CONFIG.hiddenWebshopIds. Unchecking one hides it from
// everyone (saved centrally) — new webshops always start visible, which
// is what makes a new production's webshop "just appear" automatically.
async function renderWebshopChecklist() {
  const container = document.getElementById('cfgWebshops');
  container.innerHTML = '<div class="empty-state">Webshops laden...</div>';
  try {
    const all = await fetchAllWebshops();
    const hidden = new Set(CONFIG.hiddenWebshopIds || []);
    container.innerHTML = all.map(ws => `
      <label class="webshop-row" style="display:flex;align-items:center;gap:0.5rem">
        <input type="checkbox" class="ws-visible" data-id="${escHtml(ws.id)}" ${hidden.has(ws.id) ? '' : 'checked'}>
        <span>${escHtml(ws.meta?.name || ws.name || 'Webshop')}</span>
      </label>
    `).join('') || '<div class="empty-state">Geen webshops gevonden</div>';
  } catch(e) {
    container.innerHTML = `<div class="empty-state">Kon webshops niet laden: ${escHtml(e.message)}</div>`;
  }
}

async function saveConfig() {
  const orgId    = document.getElementById('cfgOrgId').value.trim();
  const proxyUrl = document.getElementById('cfgProxyUrl').value.trim();

  const hiddenWebshopIds = [...document.querySelectorAll('#cfgWebshops .ws-visible')]
    .filter(el => !el.checked)
    .map(el => el.dataset.id);

  // proxyUrl is a local convenience setting (which Worker to talk to) —
  // keep that per-browser.
  CONFIG.proxyUrl = proxyUrl;
  localStorage.setItem('theatre_dashboard_config', JSON.stringify({ proxyUrl }));

  // orgId/hiddenWebshopIds are centrally managed: push to the Worker so
  // every visitor immediately gets the new values, not just this browser.
  try {
    const res = await workerFetch('/config', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ orgId, hiddenWebshopIds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert('❌ Opslaan mislukt: ' + (data.error || res.statusText));
      return;
    }
    CONFIG.orgId = orgId;
    CONFIG.hiddenWebshopIds = hiddenWebshopIds;
  } catch(e) {
    alert('❌ Netwerkfout bij opslaan: ' + e.message);
    return;
  }

  toggleConfig();
  reloadCurrentPage();
}

// ─── DATA LOADING ─────────────────────────────────────────

// app.js is shared between index.html (live per-production dashboard) and
// statistieken.html (cross-production report) — this is how shared code
// (login, settings-save, auto-refresh) knows which one to reload.
function isStatsPage() {
  return !!document.getElementById('statsTable');
}
function reloadCurrentPage() {
  if (isStatsPage()) loadStats(); else loadData();
}

// Fetch ALL orders — deduplicated by order ID
// Stamhoofd's own error messages (e.g. exactly how long a rate limit lasts)
// only ever appear in the JSON body, never as a header a browser surfaces
// on its own — without this, a sustained rate limit and an expired token
// both just show up as a bare "429" or "401" with no way to tell them
// apart or know how long to wait.
async function throwApiError(res, label) {
  let detail = res.statusText || String(res.status);
  try {
    const body = await res.json();
    const err = body?.errors?.[0];
    if (err) detail = err.human || err.message || detail;
  } catch (e) { /* not JSON — keep statusText */ }
  throw new Error(`${label}: ${detail}`);
}

async function fetchWithTimeout(url, options, ms, retries = 3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    // Stamhoofd rate-limits bursts (429) — with every webshop now fetched
    // automatically instead of a hand-picked 1-3, that burst is bigger
    // than before, so this backs off and retries instead of just failing.
    if (res.status === 429 && retries > 0) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (4 - retries);
      await new Promise(r => setTimeout(r, waitMs));
      return fetchWithTimeout(url, options, ms, retries - 1);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Runs async tasks with at most `limit` running at once, instead of firing
// everything in parallel — keeps bursts to the Stamhoofd API small even
// when there are many webshops.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchAllOrders(webshopId) {
  // Stamhoofd v2 API: keyset-cursor pagination via filter + sort.
  // The webshopId goes in the filter object (not the URL path).
  // Cursor = last item's { updatedAt, number }; each page requests items
  // strictly after that cursor.
  const seenIds  = new Set();
  const allOrders = [];
  let cursorUpdatedAt = 0;  // epoch = fetch from the very beginning
  let cursorNumber    = -1;

  while (true) {
    const filter = {
      webshopId: webshopId,
      $or: [
        { updatedAt: { $gt:  { $: '$date', value: cursorUpdatedAt } } },
        { $and: [
            { updatedAt: { $eq: { $: '$date', value: cursorUpdatedAt } } },
            { number:    { $gt: cursorNumber } }
          ]
        }
      ]
    };
    const inner = new URL(`${apiBase()}/webshop/orders`);
    inner.searchParams.set('filter', JSON.stringify(filter));
    inner.searchParams.set('sort',   'updatedAt ASC,number ASC,id ASC');
    inner.searchParams.set('limit',  '100');
    const fetchUrl = proxied(inner.toString());
    const res = await fetchWithTimeout(fetchUrl, { headers: headers() }, 15000);
    if (!res.ok) await throwApiError(res, `Orders API ${res.status}`);
    const page = await res.json();
   const items = Array.isArray(page) ? page : (page.results || page.orders || []);
    if (!items.length) break;

    // Log first order on first page (debug panel)
    if (allOrders.length === 0) {
      document.getElementById('debugPanel').textContent = '';
      logDebug('=== FIRST RAW ORDER ===');
      logDebug(JSON.stringify(items[0], null, 2).slice(0, 3000));
    }

    let newItems = 0;
    for (const item of items) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        allOrders.push(item);
        newItems++;
      }
    }
    setStatus('⏳ ' + allOrders.length + ' bestellingen geladen...', 'loading');
    if (newItems === 0) break;

    const last = items[items.length - 1];
    const nextUpdatedAt = last?.updatedAt ?? cursorUpdatedAt;
    const nextNumber    = last?.number    ?? cursorNumber;
    // Stop if cursor didn't advance (shouldn't happen, but guards infinite loops)
    if (nextUpdatedAt === cursorUpdatedAt && nextNumber === cursorNumber) break;
    cursorUpdatedAt = nextUpdatedAt;
    cursorNumber    = nextNumber;
  }

  logDebug('=== TOTAL UNIQUE ORDERS FETCHED: ' + allOrders.length + ' ===');
  return allOrders;
}

async function fetchWebshop(webshopId) {
  const res = await fetchWithTimeout(proxied(`${apiBase()}/webshop/${webshopId}`), { headers: headers() }, 15000);
  if (!res.ok) await throwApiError(res, `Webshop API ${res.status}`);
  return res.json();
}

// Per-webshop data cache: [{ orders, webshop }, ...]
let _allWebshopData = [];
let _activeTabIndex  = 0;

function switchWebshopTab(index) {
  _activeTabIndex = index;
  document.querySelectorAll('.ws-tab').forEach((btn, i) => {
    btn.classList.toggle('active', i === index);
  });
  const { orders, webshop } = _allWebshopData[index];
  renderDashboard(orders, webshop);
}

function renderWebshopTabs() {
  const container = document.getElementById('webshopTabs');
  if (!container) return;
  if (_allWebshopData.length <= 1) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = _allWebshopData.map((_, i) => {
    const name = CONFIG.webshops[i]?.name || ('Webshop ' + (i + 1));
    return `<button class="ws-tab${i === _activeTabIndex ? ' active' : ''}" onclick="switchWebshopTab(${i})">${name}</button>`;
  }).join('');
}

// Whether the "Archief" view is active — toggled by toggleArchive(), see
// below. Kept separate from CONFIG since it's a per-visit view choice, not
// a setting.
let _showArchived = false;

function toggleArchive() {
  _showArchived = !_showArchived;
  const btn = document.getElementById('archiveToggle');
  if (btn) btn.textContent = _showArchived ? '↩ Actuele producties' : '📁 Archief';
  _activeTabIndex = 0;
  loadData();
}

// The date a webshop's tab should sort on: for current productions, the
// soonest show date that hasn't happened yet (so the next performance is
// leftmost); for the archive, the most recent show date (so the show that
// just finished is leftmost instead of the oldest one in KVK's history).
function sortDate(webshop, archived) {
  const starts = (webshop?.products || [])
    .flatMap(p => (p.dateRange ? [p.dateRange.startDate] : []))
    .filter(d => typeof d === 'number');
  if (starts.length === 0) return archived ? -Infinity : Infinity;
  if (archived) return Math.max(...starts);
  const now = Date.now();
  const upcoming = starts.filter(d => d >= now);
  return upcoming.length ? Math.min(...upcoming) : Math.min(...starts);
}

async function loadData() {
  setStatus('⏳ Voorstellingen zoeken...', 'loading');
  renderEmptyTableHead('orderTableHead', ORDER_COLUMNS, _orderTableState);
  try {
    const webshops = await discoverWebshops(_showArchived);
    CONFIG.webshops = webshops; // keeps renderWebshopTabs()'s name lookup working
    if (webshops.length === 0) {
      throw new Error(_showArchived ? 'Geen gearchiveerde producties gevonden' : 'Geen actuele producties gevonden');
    }

    setStatus('⏳ Data ophalen van Stamhoofd...', 'loading');
    // At most 3 webshops at once — matches what the original hand-picked
    // config used to top out at, and keeps clear of Stamhoofd's rate limit
    // now that every webshop is included automatically instead of a few.
    const results = await mapWithConcurrency(webshops, 3, async (ws) => {
      const [orders, webshop] = await Promise.all([fetchAllOrders(ws.id), fetchWebshop(ws.id)]);
      return { orders, webshop };
    });

    // Sort tabs by show date (see sortDate above) — ascending for current
    // productions (soonest upcoming first), descending for the archive.
    results.sort((a, b) => {
      const da = sortDate(a.webshop, _showArchived);
      const db = sortDate(b.webshop, _showArchived);
      return _showArchived ? db - da : da - db;
    });
    CONFIG.webshops = results.map(r => ({ id: r.webshop.id, name: r.webshop.meta?.name || 'Webshop' }));

    _allWebshopData = results;
    if (_activeTabIndex >= results.length) _activeTabIndex = 0;

    renderWebshopTabs();
    switchWebshopTab(_activeTabIndex);

    const totalOrders = results.reduce((s, r) => s + r.orders.length, 0);
    const modeLabel = _showArchived ? ' (archief)' : '';
    setStatus('✓ Laatste update: ' + new Date().toLocaleTimeString('nl-BE') + modeLabel + ' — ' + totalOrders + ' bestellingen geladen', 'success');
  } catch (err) {
    console.error('loadData error:', err);
    setStatus('✗ Fout: ' + err.message, 'error');
    const kg = document.getElementById('kpiGrid');
    if (kg) kg.innerHTML = `
      <div class="kpi"><div class="kpi-label">Totale omzet</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
      <div class="kpi"><div class="kpi-label">Tickets verkocht</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
      <div class="kpi"><div class="kpi-label">Betaald</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
      <div class="kpi"><div class="kpi-label">Gem. bestelwaarde</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
    `;
    const sl = document.getElementById('showList');
    if (sl) sl.innerHTML = '<div class="empty-state">Kon geen data laden.</div>';
    const ot = document.getElementById('orderTable');
    if (ot) ot.innerHTML = '<tr><td colspan="8"><div class="empty-state">Geen data beschikbaar</div></td></tr>';
    renderEmptyTableHead('orderTableHead', ORDER_COLUMNS, _orderTableState);
  }
}

// ─── RENDER ──────────────────────────────────────────────
  function renderDashboard(orders, webshop) {
      window._orders = orders; 
// Field accessors for Stamhoofd v2 API.
  // Payment info moved from o.payment to o.balanceItems[0].payments[0].payment.
  const getPayment  = o => o.balanceItems?.[0]?.payments?.[0]?.payment ?? null;
  const getPrice    = o => (o.balanceItems ?? []).reduce((s, b) => s + (b.unitPrice ?? 0), 0);
  const getPricePaid = o => (o.balanceItems ?? []).reduce((s, b) => s + (b.pricePaid ?? 0), 0);  const getStatus   = o => getPayment(o)?.status ?? 'Unknown';
  const getItems    = o => o.data?.cart?.items ?? [];
  const getCreatedAt = o => o.createdAt ?? o.validAt ?? 0;
  const getOrderNr  = o => {
    if (o.number != null) return String(o.number);
    const desc = o.balanceItems?.[0]?.description ?? '';
    const m = desc.match(/#(\d+)/);
    return m ? m[1] : null;
  };
  const getCustomer = o => o.data?.customer ?? getPayment(o)?.customer ?? null;
  const getMethod   = o => {
    const method = getPayment(o)?.method ?? o.data?.paymentMethod ?? '—';
    const labels = { Transfer: 'Overschrijving' };
    return labels[method] ?? method;
  };

const uniqueOrders = orders.filter(o => {
  const status = getStatus(o);
  if (status === 'Deleted') return false;
  if (status === 'Canceled') return false;
  return true;
});
const paid = uniqueOrders.filter(o => getStatus(o) === 'Succeeded');
const totalRevenue = uniqueOrders.reduce((s, o) => s + getPrice(o), 0);
const paidRevenue = uniqueOrders.reduce((s, o) => s + getPricePaid(o), 0);
    const CANCELLED_STATUSES = ['Failed', 'Canceled', 'Refunded', 'Disputed', 'Deleted'];
const activeOrders = uniqueOrders.filter(o => !CANCELLED_STATUSES.includes(getStatus(o)));
 let totalTickets = 0;
activeOrders.forEach(o => getItems(o).forEach(i => { totalTickets += (i.amount || 0); }));
const avgOrder = uniqueOrders.length ? totalRevenue / uniqueOrders.length : 0;
const products = webshop?.products || webshop?.data?.products || [];
const totalCapacity = (CONFIG.capacity || DEFAULTS.capacity) * products.length;
const capacityPct = totalCapacity ? Math.round((totalTickets / totalCapacity) * 100) : null;
const kpis = [
  { label: 'Totale omzet', value: fmt(totalRevenue), sub: `${fmt(paidRevenue)} betaald` },
  { label: 'Tickets verkocht', value: totalTickets, sub: capacityPct !== null ? `${capacityPct}% van ${totalCapacity} plaatsen` : `${uniqueOrders.length} bestellingen` },
  { label: 'Betaald', value: paid.length, sub: `van ${uniqueOrders.length} bestellingen` },
  { label: 'Gem. bestelwaarde', value: fmt(avgOrder), sub: 'per bestelling' },
];
  document.getElementById('kpiGrid').innerHTML = kpis.map(k => `
    <div class="kpi loaded">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>
  `).join('');

  // Shows from webshop products
  renderShows(webshop, orders);

  // Weekly orders chart + payment breakdown
  renderWeekChart(uniqueOrders, getCreatedAt, getItems, getStatus);
  renderPaymentBreakdown(uniqueOrders, getStatus);

  // Orders table
  renderOrders(uniqueOrders, getPrice, getStatus, getItems, getCreatedAt, getOrderNr, getCustomer, getMethod);
}

function renderShows(webshop, orders) {
  const products = webshop?.products || webshop?.data?.products || [];
  const list = document.getElementById('showList');
  document.getElementById('showCount').textContent = `${products.length} voorstelling${products.length !== 1 ? 'en' : ''}`;

  if (!products.length) {
    list.innerHTML = '<div class="empty-state">Geen voorstellingen gevonden in webshop</div>';
    return;
  }

  // Count tickets sold per product+price from actual orders (non-cancelled)
  const CANCELLED = ['Failed', 'Canceled', 'Refunded', 'Disputed', 'Deleted'];
 const soldPerProduct = {};
orders.forEach(o => {
 const _s = (o.balanceItems?.[0]?.payments?.[0]?.payment?.status ?? '');
  if (_s === 'Deleted') return;
  if (_s === 'Canceled') return;
  if (['Failed', 'Refunded', 'Disputed'].includes(_s)) return;
  (o.data?.cart?.items ?? []).forEach(item => {
    const pid = item.product?.id ?? item.productId;
    if (pid) soldPerProduct[pid] = (soldPerProduct[pid] || 0) + (item.amount || 0);
  });
});

  // Sort products by date ascending
  const sorted = [...products].sort((a, b) => (a.dateRange?.startDate ?? 0) - (b.dateRange?.startDate ?? 0));

  list.innerHTML = sorted.map(p => {
    const used = soldPerProduct[p.id] ?? p.usedStock ?? 0;
    const reservedCount = (p.reservedSeats ?? []).length;
    const capacity = CONFIG.capacity;
    const free = capacity - used;
    const pct = Math.round((used / capacity) * 100);
    const fillClass = pct >= 90 ? 'almost' : pct >= 60 ? '' : 'good';

    // Per-price-tier breakdown (e.g. Standaard 159/∞, VIP 0/36)
    const visiblePrices = (p.prices ?? []).filter(pr => pr.price > 0);
    const showDate = p.dateRange?.startDate ? fmtDate(p.dateRange.startDate) : '';
    const showTime = p.dateRange?.startDate
      ? new Date(p.dateRange.startDate).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })
      : '';

    const avail = used >= 234
      ? { label: 'Uitverkocht', color: '#b83232', bg: '#fad7d7' }
      : used >= 194
        ? { label: 'Laatste kaarten', color: '#8b6914', bg: '#f5e9c0' }
        : { label: 'Vrij', color: '#2e7d52', bg: '#d4edde' };

    return `
      <div class="show-item">
        <div class="show-top">
          <div class="show-name">${p.name || 'Naamloos'}</div>
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
            <span style="font-size:0.6rem;font-weight:600;letter-spacing:0.05em;padding:0.15rem 0.5rem;background:${avail.bg};color:${avail.color};border-radius:2px">${avail.label}</span>
            <div class="show-date">${showDate}${showTime ? ' · ' + showTime : ''}</div>
          </div>
        </div>
        <div class="show-stats">
          <div>
            <div class="show-stat-label">Verkocht</div>
            <div class="show-stat-val">${used}</div>
          </div>
          <div>
            <div class="show-stat-label">Vrij</div>
            <div class="show-stat-val">${free}</div>
          </div>

        </div>
        <div class="seat-track" style="margin-bottom:0.35rem">
          <div class="seat-fill ${fillClass}" style="width:0%" data-pct="${pct}"></div>
        </div>
        <div class="seat-pct">
          <span>${pct}% bezet</span>
          <span>${free} plaatsen vrij</span>
        </div>

        ${visiblePrices.length > 0 ? `
          <div style="margin-top:1rem;display:flex;flex-direction:column;gap:0.5rem">
            <div style="font-size:0.6rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:0.1rem">Per tariefcategorie</div>
            ${visiblePrices.map(pr => {
              const prUsed = pr.usedStock ?? 0;
              const prCap = pr.stock !== null ? pr.stock : null;
              const prPct = prCap !== null ? Math.round((prUsed / prCap) * 100) : null;
              const prFill = (prPct ?? 50) >= 90 ? 'almost' : (prPct ?? 50) >= 60 ? '' : 'good';
              return `<div>
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.3rem">
                  <span style="font-size:0.65rem;color:var(--muted)">${pr.name}</span>
                  <span style="font-size:0.65rem;color:var(--text)">${prUsed}${prCap !== null ? ' / ' + prCap : ''}</span>
                </div>
                ${prCap !== null ? `<div class="seat-track"><div class="seat-fill ${prFill}" style="width:0%" data-pct="${prPct}"></div></div>` : `<div class="seat-track"><div class="seat-fill good" style="width:${Math.min(100, prUsed)}%" ></div></div>`}
              </div>`;
            }).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // Animate bars
  requestAnimationFrame(() => {
    document.querySelectorAll('.seat-fill[data-pct]').forEach(el => {
      el.style.width = el.dataset.pct + '%';
    });
  });
}

function renderRevenueChart(orders, getPrice, getCreatedAt) {
  const svg = document.getElementById('revChart');
  if (!orders.length) { svg.innerHTML = '<text x="200" y="80" fill="var(--muted)" text-anchor="middle" font-family="DM Mono" font-size="12">Geen data</text>'; return; }

  const sorted = [...orders].sort((a, b) => getCreatedAt(a) - getCreatedAt(b));
  const values = sorted.map(o => getPrice(o) / 10000);
  const W = 400, H = 160, PL = 40, PR = 10, PT = 10, PB = 25;
  const cW = W - PL - PR, cH = H - PT - PB;
  const max = Math.max(...values, 1);
  const n = values.length;

  const px = i => PL + (n === 1 ? cW / 2 : (i / (n - 1)) * cW);

  let bars = '';
  const barW = Math.max(4, Math.min(20, cW / n - 3));
  sorted.forEach((o, i) => {
    const price = getPrice(o);
    const status = (o.balanceItems?.[0]?.payments?.[0]?.payment?.status ?? '');
    const x = px(i) - barW / 2;
    const h = (price / 10000 / max) * cH;
    const y = PT + cH - h;
    const color = status === 'Succeeded' ? '#4caf7d' : status === 'Created' ? '#c9a84c' : '#7a7669';
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" opacity="0.85" rx="1">
      <title>${fmtDate(getCreatedAt(o))} — ${fmt(price)} — ${status}</title>
    </rect>`;
  });

  let yLabels = '';
  for (let i = 0; i <= 3; i++) {
    const val = (max / 3) * i;
    const y = PT + cH - (val / max) * cH;
    yLabels += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    yLabels += `<text x="${PL - 4}" y="${y + 4}" text-anchor="end" font-family="DM Mono" font-size="9" fill="var(--muted)">€${Math.round(val)}</text>`;
  }

  svg.innerHTML = yLabels + bars;
}

function renderPaymentBreakdown(orders, getStatus) {
  const ALLOWED = ['Succeeded', 'Created'];
  const filtered = orders.filter(o => ALLOWED.includes(getStatus(o)));
  const statuses = {};
  filtered.forEach(o => { const s = getStatus(o); statuses[s] = (statuses[s] || 0) + 1; });
  const total = filtered.length;
  const labels = { Succeeded: 'Betaald', Created: 'Openstaand' };
  const colors = { Succeeded: 'var(--green)', Created: 'var(--gold)' };

  document.getElementById('paymentBreakdown').innerHTML = Object.entries(statuses).map(([status, count]) => {
    const pct = Math.round((count / total) * 100);
    return `
      <div style="display:grid;grid-template-columns:100px 1fr 40px;align-items:center;gap:0.75rem;margin-bottom:0.6rem">
        <div style="font-size:0.65rem;color:var(--muted)">${labels[status] || status}</div>
        <div style="background:var(--border);height:3px;border-radius:2px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${colors[status] || 'var(--muted)'};border-radius:2px;transition:width 1s"></div>
        </div>
        <div style="font-size:0.65rem;color:var(--text);text-align:right">${count}</div>
      </div>
    `;
  }).join('');
}

// ─── SORTABLE / FILTERABLE TABLES ──────────────────────────
// Shared by the orders table and the productions table: click a column
// header to sort by it (click again to reverse); the row of inputs
// underneath filters that one column. One small engine instead of
// building this twice.
//
// A column is { key, label, get: row => rawValue, format?: (rawValue, row) => displayString }.
// Sorting always uses the raw value (so "€ 90" sorts correctly against
// "€ 1.200" as numbers, not as strings); filtering matches against the
// displayed text, since that's what a person types.
function colText(col, row) {
  const v = col.get(row);
  if (v == null) return '';
  return col.format ? String(col.format(v, row)) : String(v);
}

function applySortAndFilter(rows, columns, state) {
  let result = rows.filter(row => columns.every(col => {
    const term = (state.filters[col.key] || '').trim().toLowerCase();
    if (!term) return true;
    return colText(col, row).toLowerCase().includes(term);
  }));
  if (state.sortKey) {
    const col = columns.find(c => c.key === state.sortKey);
    const dir = state.sortDir;
    result = [...result].sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }
  return result;
}

// Builds the header ONCE (two rows: clickable labels, then filter inputs)
// and wires up events — rebuilding it on every keystroke would blow away
// focus mid-type, so filtering/sorting afterwards only ever touches the
// body via onChange(), never this function again.
function renderTableHead(theadEl, columns, state, onChange) {
  const labelCells = columns.map(col =>
    `<th class="sortable-th" data-key="${col.key}"><span>${escHtml(col.label)}</span><span class="sort-arrow"></span></th>`
  ).join('');
  const filterCells = columns.map(col =>
    `<th class="filter-th"><input type="text" data-key="${col.key}" placeholder="Filter..." value="${escHtml(state.filters[col.key] || '')}"></th>`
  ).join('');
  theadEl.innerHTML = `<tr>${labelCells}</tr><tr>${filterCells}</tr>`;

  theadEl.querySelectorAll('.sortable-th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = 1; }
      updateSortArrows(theadEl, state);
      onChange();
    });
  });
  theadEl.querySelectorAll('.filter-th input').forEach(input => {
    input.addEventListener('input', () => {
      state.filters[input.dataset.key] = input.value;
      onChange();
    });
  });
  updateSortArrows(theadEl, state);
}

function updateSortArrows(theadEl, state) {
  theadEl.querySelectorAll('.sortable-th').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    arrow.textContent = th.dataset.key === state.sortKey ? (state.sortDir === 1 ? ' ▲' : ' ▼') : '';
  });
}

const _orderTableState = { sortKey: 'createdAt', sortDir: -1, filters: {} };

const ORDER_COLUMNS = [
  { key: 'orderNr', label: 'Bestelnr.', get: r => r.orderNr, format: (v, r) => r.orderNrLabel },
  { key: 'customer', label: 'Klant', get: r => r.customer },
  { key: 'show', label: 'Voorstelling', get: r => r.show },
  { key: 'tickets', label: 'Tickets', get: r => r.tickets },
  { key: 'price', label: 'Bedrag', get: r => r.price, format: v => fmt(v) },
  { key: 'method', label: 'Betaalmethode', get: r => r.method },
  { key: 'statusLabel', label: 'Status', get: r => r.statusLabel },
  { key: 'createdAt', label: 'Datum', get: r => r.createdAt, format: v => fmtDate(v) },
];

// Headers render independently from whether data actually loaded — a
// failed fetch (e.g. Stamhoofd's rate limit) used to leave the table
// completely headerless, since the header used to only ever get built as
// part of a successful render. Called from loadData()'s catch too.
function renderEmptyTableHead(theadId, columns, state) {
  const theadEl = document.getElementById(theadId);
  if (theadEl) renderTableHead(theadEl, columns, state, () => {});
}

function renderOrders(orders, getPrice, getStatus, getItems, getCreatedAt, getOrderNr, getCustomer, getMethod) {
  const pillClass = { Succeeded: 'pill-succeeded', Created: 'pill-created', Failed: 'pill-failed', Pending: 'pill-pending', Prepared: 'pill-succeeded' };
  const pillLabel = { Succeeded: 'Betaald', Created: 'Openstaand', Failed: 'Mislukt', Pending: 'Bezig', Prepared: 'Gratis' };

  const rows = orders.map(o => {
    const customer = getCustomer(o);
    const items = getItems(o);
    const status = getStatus(o);
    const orderNr = getOrderNr(o);
    return {
      orderNr: orderNr ? Number(orderNr) || orderNr : null,
      orderNrLabel: orderNr ? `#${orderNr}` : '—',
      customer: customer ? `${customer.firstName} ${customer.lastName}` : '—',
      show: items[0]?.product?.name || '—',
      tickets: items.reduce((s, i) => s + (i.amount || 0), 0),
      price: getPrice(o),
      method: getMethod(o),
      statusLabel: pillLabel[status] || status,
      pillClass: pillClass[status] || 'pill-pending',
      createdAt: getCreatedAt(o),
    };
  });

  const columns = ORDER_COLUMNS;

  const tbody = document.getElementById('orderTable');
  const theadEl = document.getElementById('orderTableHead');
  const PAGE_SIZE = 10;
  let showing = PAGE_SIZE;
  let filtered = rows;

  function renderBody() {
    tbody.innerHTML = filtered.slice(0, showing).map(r => `<tr>
      <td>${r.orderNrLabel}</td>
      <td>${escHtml(r.customer)}</td>
      <td style="color:var(--muted);font-style:italic">${escHtml(r.show)}</td>
      <td>${r.tickets || '—'}</td>
      <td>${fmt(r.price)}</td>
      <td style="color:var(--muted)">${escHtml(r.method)}</td>
      <td><span class="status-pill ${r.pillClass}">${escHtml(r.statusLabel)}</span></td>
      <td style="color:var(--muted)">${fmtDate(r.createdAt)}</td>
    </tr>`).join('');

    const existingBtn = document.getElementById('showMoreBtn');
    if (existingBtn) existingBtn.remove();
    if (showing < filtered.length) {
      const btn = document.createElement('div');
      btn.id = 'showMoreBtn';
      btn.style.cssText = 'text-align:center;padding:1.25rem;border-top:1px solid var(--border)';
      btn.innerHTML = `<button class="btn" onclick="showMore()" style="padding:0.5rem 2rem">
        ↓ Meer tonen (${filtered.length - showing} verborgen)
      </button>`;
      tbody.closest('table').after(btn);
    }
  }

  function recompute() {
    filtered = applySortAndFilter(rows, columns, _orderTableState);
    showing = PAGE_SIZE;
    const active = Object.values(_orderTableState.filters).some(f => f && f.trim());
    document.getElementById('orderCount').textContent = active
      ? `${filtered.length} van ${rows.length} bestellingen`
      : `${rows.length} bestellingen`;

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Geen bestellingen gevonden</div></td></tr>';
      const existingBtn = document.getElementById('showMoreBtn');
      if (existingBtn) existingBtn.remove();
      return;
    }
    renderBody();
  }

  window.showMore = function() {
    showing = Math.min(showing + PAGE_SIZE, filtered.length);
    renderBody();
  };

  renderTableHead(theadEl, columns, _orderTableState, recompute);
  recompute();
}

function renderWeekChart(orders, getCreatedAt, getItems, getStatus) {
  const svg = document.getElementById('weekChart');
  const tooltip = document.getElementById('weekTooltip');
  svg.innerHTML = '';
  if (!orders.length) return;

function getWeekKey(ts) {
  const d = new Date(ts);
  const day = d.getDay() || 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + 1);
  // Use local date parts instead of toISOString() to avoid UTC shift
  const y = mon.getFullYear();
  const m = String(mon.getMonth() + 1).padStart(2, '0');
  const dd = String(mon.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

  function getWeekNumber(dateStr) {
    const d = new Date(dateStr);
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const startOfWeek1 = new Date(jan4);
    startOfWeek1.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
    const weekNum = Math.floor((d - startOfWeek1) / (7 * 24 * 60 * 60 * 1000)) + 1;
    return weekNum;
  }

const weeks = {};
  const CANCELLED = ['Failed', 'Canceled', 'Refunded', 'Disputed', 'Deleted'];
  orders.forEach(o => {
    if (CANCELLED.includes(getStatus(o))) return;
    const key = getWeekKey(getCreatedAt(o));
    const tickets = getItems(o).reduce(function(s, i) { return s + (i.amount || 0); }, 0);
    weeks[key] = (weeks[key] || 0) + tickets;
  });

  const sorted = Object.entries(weeks).sort((a, b) => a[0].localeCompare(b[0]));
  const W = 800, H = 200, PL = 36, PR = 10, PT = 10, PB = 30;
  const cW = W - PL - PR, cH = H - PT - PB;
  const counts = sorted.map(function(e) { return e[1]; });
  document.getElementById('weekChartMeta').textContent = sorted.length + ' weken — ' + counts.reduce(function(a,b){return a+b;},0) + ' tickets totaal';
  const maxVal = Math.max.apply(null, counts.concat([1]));
  const n = sorted.length;
  const barW = Math.max(6, Math.min(40, (cW / n) - 4));
  const px = function(i) { return PL + (i + 0.5) * (cW / n); };

  let grid = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = Math.round((maxVal / ticks) * i);
    const y = PT + cH - (val / maxVal) * cH;
    grid += '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y + '" stroke="var(--border)" stroke-width="1"/>';
    grid += '<text x="' + (PL - 4) + '" y="' + (y + 4) + '" text-anchor="end" font-family="Outfit,sans-serif" font-size="10" fill="var(--muted)">' + val + '</text>';
  }

  let bars = '';
  sorted.forEach(function(entry, i) {
    const week = entry[0], count = entry[1];
    const x = px(i) - barW / 2;
    const h = Math.max(2, (count / maxVal) * cH);
    const y = PT + cH - h;
    const label = (n <= 16 || i % Math.ceil(n / 16) === 0)
      ? new Date(week).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })
      : '';
    const weekNr = getWeekNumber(week);
    bars += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + h + '" fill="var(--gold)" opacity="0.85" rx="2"'
      + ' data-week="' + week + '" data-count="' + count + '" data-weeknr="' + weekNr + '"'
      + ' style="cursor:pointer;transition:opacity 0.1s"'
      + ' onmouseenter="showWeekTooltip(event,this)" onmouseleave="hideWeekTooltip()">'
      + '</rect>';
    if (label) {
      bars += '<text x="' + px(i) + '" y="' + (PT + cH + 16) + '" text-anchor="middle" font-family="Outfit,sans-serif" font-size="9" fill="var(--muted)">' + label + '</text>';
    }
  });

  svg.innerHTML = grid + bars;
}

function showWeekTooltip(event, rect) {
  const tooltip = document.getElementById('weekTooltip');
  const week = rect.getAttribute('data-week');
  const count = rect.getAttribute('data-count');
  const weekNr = rect.getAttribute('data-weeknr');
  const d = new Date(week);
  const endD = new Date(d);
  endD.setDate(d.getDate() + 6);
  const fmt = function(dt) { return dt.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' }); };
  tooltip.innerHTML = '<strong>Week ' + weekNr + '</strong> &nbsp;' + fmt(d) + ' – ' + fmt(endD)
    + '<br><span style="color:var(--gold)">' + count + ' ticket' + (count != 1 ? 's' : '') + '</span>';
  tooltip.style.display = 'block';
  // Position relative to the SVG container
  const svgEl = document.getElementById('weekChart');
  const svgRect = svgEl.getBoundingClientRect();
  const barRect = rect.getBoundingClientRect();
  const left = barRect.left - svgRect.left + barRect.width / 2;
  const top = barRect.top - svgRect.top - 10;
  tooltip.style.left = Math.min(left, svgRect.width - 160) + 'px';
  tooltip.style.top = (top - tooltip.offsetHeight - 4) + 'px';
  rect.setAttribute('opacity', '1');
}

function hideWeekTooltip() {
  document.getElementById('weekTooltip').style.display = 'none';
  document.querySelectorAll('#weekChart rect').forEach(function(r) { r.setAttribute('opacity', '0.85'); });
}

function renderFallback() {
  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi"><div class="kpi-label">Totale omzet</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
    <div class="kpi"><div class="kpi-label">Tickets verkocht</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
    <div class="kpi"><div class="kpi-label">Betaald</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
    <div class="kpi"><div class="kpi-label">Gem. bestelwaarde</div><div class="kpi-value" style="color:var(--muted)">—</div></div>
  `;
  document.getElementById('showList').innerHTML = '<div class="empty-state">Kon geen data laden. Controleer je API-instellingen via ⚙ Instellingen.</div>';
  document.getElementById('orderTable').innerHTML = '<tr><td colspan="8"><div class="empty-state">Geen data beschikbaar</div></td></tr>';
}


// ─── AUTH & USER MANAGEMENT ───────────────────────────────

const SESSION_KEY  = 'kvk_session';   // localStorage: { sessionToken, expires }
const LOCKOUT_KEY  = 'kvk_lockout';   // localStorage: { attempts, until }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINS = 15;

// ── Worker API helpers ─────────────────────────────────────
function workerFetch(path, opts = {}) {
  return fetch(CONFIG.proxyUrl + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
}
function workerAdmin(path, opts = {}) {
  return workerFetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': sessionStorage.getItem('kvk_admin_token') || '', ...(opts.headers || {}) }
  });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Lockout helpers ────────────────────────────────────────
function getLockout()    { try { return JSON.parse(localStorage.getItem(LOCKOUT_KEY)) || { attempts: 0, until: 0 }; } catch(e) { return { attempts: 0, until: 0 }; } }
function saveLockout(l)  { localStorage.setItem(LOCKOUT_KEY, JSON.stringify(l)); }
function clearLockout()  { localStorage.removeItem(LOCKOUT_KEY); }

function checkLockout(errEl) {
  const l = getLockout();
  if (l.until && Date.now() < l.until) {
    const mins = Math.ceil((l.until - Date.now()) / 60000);
    errEl.textContent = `Te veel pogingen. Probeer opnieuw over ${mins} minuut${mins === 1 ? '' : 'en'}.`;
    return true;
  }
  return false;
}

function recordFailedAttempt(errEl) {
  const l = getLockout();
  l.attempts = (l.attempts || 0) + 1;
  if (l.attempts >= MAX_ATTEMPTS) {
    l.until = Date.now() + LOCKOUT_MINS * 60 * 1000;
    l.attempts = 0;
    errEl.textContent = `Te veel pogingen. Geblokkeerd voor ${LOCKOUT_MINS} minuten.`;
  } else {
    const left = MAX_ATTEMPTS - l.attempts;
    errEl.textContent = `Ongeldig e-mailadres of wachtwoord. Nog ${left} poging${left === 1 ? '' : 'en'} voor blokkering.`;
  }
  saveLockout(l);
}

// ── Session helpers ────────────────────────────────────────
function saveSession(sessionToken, name = '', displayEmail = '') {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    sessionToken,
    name,
    displayEmail,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  }));
}

function getSessionName() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s?.name || s?.displayEmail || '';
  } catch(e) { return ''; }
}

function getSessionToken() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!s || !s.sessionToken) return null;
    if (Date.now() > s.expires) { localStorage.removeItem(SESSION_KEY); return null; }
    return s.sessionToken;
  } catch(e) { return null; }
}

function getSession() { return !!getSessionToken(); }
function isAdmin()    { return sessionStorage.getItem('kvk_admin_token') !== null; }

// ── Tab switching ──────────────────────────────────────────
function switchLoginTab(tab) {
  document.getElementById('loginForm').style.display   = tab === 'login'   ? '' : 'none';
  document.getElementById('requestForm').style.display = tab === 'request' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabRequest').classList.toggle('active', tab === 'request');
  document.getElementById('loginError').textContent  = '';
  document.getElementById('reqError').textContent    = '';
  document.getElementById('reqSuccess').textContent  = '';
  document.getElementById('loginSuccess') && (document.getElementById('loginSuccess').textContent = '');
}

// ── Magic link login ───────────────────────────────────────
async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const errEl = document.getElementById('loginError');
  const okEl  = document.getElementById('loginSuccess');
  errEl.textContent = '';
  if (okEl) okEl.textContent = '';

  if (!email) { errEl.textContent = 'Vul je e-mailadres in.'; return; }

  // Admin: special case — redirect to password prompt (before email format check)
  if (email === 'admin' || email === 'beheerder') {
    openAdminOverlay();
    return;
  }

  if (!email.includes('@')) { errEl.textContent = 'Ongeldig e-mailadres.'; return; }
  if (checkLockout(errEl)) return;

  const btn = document.querySelector('#loginForm .login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Versturen...'; }

  try {
    const res  = await workerFetch('/magic/request', { method: 'POST', body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) {
      errEl.textContent = 'Te veel pogingen. Probeer het later opnieuw.';
    } else if (!res.ok) {
      errEl.textContent = 'Fout bij versturen: ' + (data.error || res.status);
    } else {
      errEl.textContent = '';
      if (okEl) okEl.textContent = 'Als dit adres toegang heeft, ontvang je een inloglink in je inbox.';
      document.getElementById('loginEmail').value = '';
    }
  } catch(e) {
    errEl.textContent = 'Netwerkfout: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Stuur inloglink'; }
  }
}

// ── Token verification (called on page load if ?token= in URL) ──
async function checkMagicToken() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token');
  if (!token) return false;

  // Clean token from URL immediately
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);

  try {
    const res  = await workerFetch('/magic/verify', { method: 'POST', body: JSON.stringify({ token }) });
    const data = await res.json();
    if (data.ok && data.sessionToken) {
      clearLockout();
      saveSession(data.sessionToken, data.name || '', data.displayEmail || '');
      return true;
    } else {
      // Show error on login screen
      const errEl = document.getElementById('loginError');
      if (errEl) errEl.textContent = data.reason === 'expired'
        ? 'Deze inloglink is verlopen. Vraag een nieuwe aan.'
        : 'Ongeldige inloglink.';
      return false;
    }
  } catch(e) { return false; }
}

// ── Request access ─────────────────────────────────────────
async function doRequestAccess() {
  const name  = document.getElementById('reqName').value.trim();
  const email = document.getElementById('reqEmail').value.trim().toLowerCase();
  const errEl = document.getElementById('reqError');
  const okEl  = document.getElementById('reqSuccess');
  errEl.textContent = '';
  okEl.textContent  = '';

  if (!name || !email) { errEl.textContent = 'Vul je naam en e-mailadres in.'; return; }
  if (!email.includes('@')) { errEl.textContent = 'Ongeldig e-mailadres.'; return; }

  const btn = document.querySelector('#requestForm .login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Versturen...'; }

  try {
    const res  = await workerFetch('/requests', { method: 'POST', body: JSON.stringify({ name, email }) });
    if (res.status === 429) {
      errEl.textContent = 'Te veel pogingen. Probeer het later opnieuw.';
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      okEl.textContent = 'Aanvraag verzonden! Je ontvangt een e-mail zodra de beheerder je goedkeurt.';
      if (data.emailError) console.warn('Admin notification email failed:', data.emailError);
      document.getElementById('reqName').value  = '';
      document.getElementById('reqEmail').value = '';
    } else if (data.reason === 'duplicate') {
      okEl.textContent = 'Je aanvraag is al ingediend. De beheerder neemt contact op.';
    } else if (data.reason === 'already_approved') {
      okEl.textContent = 'Dit e-mailadres heeft al toegang. Vraag een inloglink aan via het inlogformulier.';
    } else {
      errEl.textContent = 'Kon aanvraag niet opslaan. Probeer opnieuw.';
    }
  } catch(e) {
    errEl.textContent = 'Fout: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Toegang aanvragen'; }
  }
}

let _loggedIn = false;

function hideLoginOverlay() {
  _loggedIn = true;
  document.getElementById('loginOverlay').style.display = 'none';
  // Show debug button only for admins
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin() ? '' : 'none';
  });
  // Show welcome name
  const name = isAdmin() ? 'Beheerder' : getSessionName();
  const el = document.getElementById('welcomeName');
  if (el && name) { el.textContent = 'Welkom, ' + name; el.style.display = ''; }
  reloadCurrentPage();
  fetchStamhoofdStatus();
}

async function checkSession() {
  // First: check for magic link token in URL
  const tokenValid = await checkMagicToken();
  if (tokenValid) { hideLoginOverlay(); return; }

  // Second: admin session is tracked by sessionStorage token (survives page refresh, not tab close)
  if (sessionStorage.getItem('kvk_admin_token')) { hideLoginOverlay(); return; }

  // Third: check regular user session token with Worker
  const sessionToken = getSessionToken();
  if (sessionToken) {
    try {
      const res  = await workerFetch('/session/verify', { method: 'POST', body: JSON.stringify({ sessionToken }) });
      const data = await res.json();
      if (data.ok) {
        // Refresh stored name in case it changed
        saveSession(sessionToken, data.name || getSessionName(), data.displayEmail || '');
        hideLoginOverlay();
        return;
      }
      localStorage.removeItem(SESSION_KEY); // invalid/expired
    } catch(e) {}
  }
  // Otherwise login overlay stays visible
}

// ── Logout ─────────────────────────────────────────────────
async function doLogout() {
  const sessionToken = getSessionToken();
  if (sessionToken) {
    workerFetch('/session/logout', { method: 'POST', body: JSON.stringify({ sessionToken }) }).catch(() => {});
  }
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem('kvk_admin_token');
  clearLockout();
  location.reload();
}

// ─── USER MANAGEMENT (admin) ──────────────────────────────

async function renderUserList() {
  const el = document.getElementById('userList');
  if (!el) return;
  el.innerHTML = '<div class="empty-users">Laden...</div>';

  try {
    const res = await workerAdmin('/users');
    if (!res.ok) { el.innerHTML = '<div class="empty-users">Kon gebruikers niet laden (controleer admin token).</div>'; return; }
    const { users, requests } = await res.json();

    let html = '';

    if (requests && requests.length) {
      html += '<div style="font-size:0.68rem;color:var(--muted);margin-bottom:0.4rem">Aanvragen</div>';
      requests.forEach(req => {
        html += '<div class="user-row">'
          + '<div class="user-info"><div class="user-name">' + escHtml(req.name) + '</div>'
          + '<div class="user-email">' + escHtml(req.displayEmail || '***') + '</div></div>'
          + '<span class="user-status-pill pill-pending">In afwachting</span>'
          + '<div class="user-actions">'
          + '<button class="user-btn" onclick="approveUser(&quot;' + req.id + '&quot;)">Goedkeuren</button>'
          + '<button class="user-btn danger" onclick="denyUser(&quot;' + req.id + '&quot;)">Weigeren</button>'
          + '</div></div>';
      });
    }

    if (users && users.length) {
      html += '<div style="font-size:0.68rem;color:var(--muted);margin:0.75rem 0 0.4rem">Actieve gebruikers</div>';
      users.forEach(u => {
        html += '<div class="user-row">'
          + '<div class="user-info"><div class="user-name">' + escHtml(u.name || '') + '</div>'
          + '<div class="user-email">' + escHtml(u.displayEmail || u.emailHash.slice(0,8) + '...') + '</div>'
    + (u.lastLogin ? '<div class="user-email">Laatst ingelogd: ' + new Date(u.lastLogin).toLocaleString("nl-BE") + '</div>' : '')
    + '</div>'
    + '<span class="user-status-pill pill-active">Actief</span>'
    + '<div class="user-actions">'
    + '<button class="user-btn" onclick="resendLink(&quot;' + u.emailHash + '&quot;)">Stuur nieuwe link</button>'
    + '<button class="user-btn danger" onclick="revokeUser(&quot;' + u.emailHash + '&quot;)">Verwijderen</button>'
    + '</div></div>';
});

    }

    if ((!requests || !requests.length) && (!users || !users.length)) {
      html = '<div class="empty-users">Nog geen aanvragen of gebruikers.</div>';
    }

    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = '<div class="empty-users">Fout: ' + escHtml(String(e)) + '</div>';
  }
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function approveUser(reqId) {
  try {
    const res = await workerAdmin('/requests/' + reqId + '/approve', { method: 'POST', body: '{}' });
    const data = await res.json();
    if (data.ok) {
      if (data.emailError) alert('Gebruiker goedgekeurd, maar inloglink e-mail mislukt: ' + data.emailError);
      renderUserList();
    } else {
      alert('Kon niet goedkeuren: ' + res.status);
    }
  } catch(e) { alert('Fout: ' + e.message); }
}

async function denyUser(reqId) {
  if (!confirm('Aanvraag weigeren?')) return;
  try {
    await workerAdmin('/requests/' + reqId + '/deny', { method: 'DELETE' });
    renderUserList();
  } catch(e) { alert('Fout: ' + e.message); }
}

async function revokeUser(emailHash) {
  if (!confirm('Toegang verwijderen voor deze gebruiker?')) return;
  try {
    await workerAdmin('/users/' + emailHash, { method: 'DELETE' });
    renderUserList();
  } catch(e) { alert('Fout: ' + e.message); }
}

async function resendLink(emailHash) {
  const email = prompt('E-mailadres van deze gebruiker (voor de inloglink):');
  if (!email || !email.includes('@')) return;
  try {
    const res  = await workerAdmin('/users/' + emailHash + '/resend', {
      method: 'POST',
      body: JSON.stringify({ email: email.trim().toLowerCase() })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      alert('✅ Inloglink verstuurd naar ' + email.trim().toLowerCase());
    } else {
      alert('❌ Versturen mislukt (status ' + res.status + '): ' + (data.error || JSON.stringify(data)));
    }
  } catch(e) {
    alert('❌ Netwerkfout: ' + e.message);
  }
}

// ─── ADMIN AUTH ───────────────────────────────────────────
// Admin password verified by Worker — no hash in source code.

function openAdminOverlay() {
  if (isAdmin()) { toggleConfig(); return; }
  if (!_loggedIn) {
    showAdminLoginForm();
  } else {
    document.getElementById('adminOverlay').style.display = 'flex';
    document.getElementById('adminPwInput').value = '';
    document.getElementById('adminPwError').style.display = 'none';
    setTimeout(() => document.getElementById('adminPwInput').focus(), 50);
  }
}

function showAdminLoginForm() {
  document.getElementById('loginForm').style.display    = 'none';
  document.getElementById('requestForm').style.display  = 'none';
  document.getElementById('adminLoginForm').style.display = '';
  document.getElementById('adminLoginPw').value = '';
  document.getElementById('adminLoginError').textContent = '';
  setTimeout(() => document.getElementById('adminLoginPw').focus(), 50);
}

function showLoginForm() {
  document.getElementById('adminLoginForm').style.display = 'none';
  document.getElementById('loginForm').style.display = '';
  document.getElementById('loginEmail').value = '';
}

async function doAdminLogin() {
  const pw    = document.getElementById('adminLoginPw').value;
  const errEl = document.getElementById('adminLoginError');
  errEl.textContent = '';
  if (!pw) { errEl.textContent = 'Vul het wachtwoord in.'; return; }
  if (checkLockout(errEl)) return;

  const btn = document.querySelector('#adminLoginForm .login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Bezig...'; }

  try {
    const res = await workerFetch('/auth', { method: 'POST', body: JSON.stringify({ password: pw }) });
    if (res.ok) {
      clearLockout();
      sessionStorage.setItem('kvk_admin_token', pw);
      hideLoginOverlay();
      return;
    }
    if (res.status === 429) {
      errEl.textContent = 'Te veel pogingen. Probeer het later opnieuw.';
      if (btn) { btn.disabled = false; btn.textContent = 'Inloggen als beheerder'; }
      return;
    }
  } catch(e) {
    errEl.textContent = 'Netwerkfout: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = 'Inloggen als beheerder'; }
    return;
  }

  recordFailedAttempt(errEl);
  if (btn) { btn.disabled = false; btn.textContent = 'Inloggen als beheerder'; }
}

function closeAdminOverlay() {
  document.getElementById('adminOverlay').style.display = 'none';
}

async function checkAdminPw() {
  const pw    = document.getElementById('adminPwInput').value;
  const errEl = document.getElementById('adminPwError');
  if (checkLockout({ textContent: '' })) {
    errEl.textContent = 'Te veel pogingen. Wacht even.';
    errEl.style.display = 'block';
    return;
  }
  try {
    const res = await workerFetch('/auth', { method: 'POST', body: JSON.stringify({ password: pw }) });
    if (res.ok) {
      clearLockout();
      sessionStorage.setItem('kvk_admin_token', pw); // survives refresh, cleared on tab close
      closeAdminOverlay();
      toggleConfig();
      document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
      return;
    }
  } catch(e) {}
  const fakeEl = { textContent: '' };
  recordFailedAttempt(fakeEl);
  errEl.textContent = fakeEl.textContent || 'Ongeldig wachtwoord.';
  errEl.style.display = 'block';
  document.getElementById('adminPwInput').select();
}

// ─── STATISTIEKEN (statistieken.html) ──────────────────────
// Non-production webshops (BBQ, annual meeting, bike tour) never belong
// here — matched by name so new ones are excluded automatically too,
// without needing the admin to hide each one by hand.
const EXCLUDED_STATS_NAME = /jaarvergadering|barbecue|\bbbq\b|fietstocht/i;

// The date a production's run started — used to sort/chart chronologically
// across both current and archived shows alike (unlike sortDate(), which
// is specifically about "what's next" for the main dashboard's tabs).
function openingDate(webshop) {
  const starts = (webshop?.products || [])
    .flatMap(p => (p.dateRange ? [p.dateRange.startDate] : []))
    .filter(d => typeof d === 'number');
  return starts.length ? Math.min(...starts) : null;
}

function computeStatsRow(webshop, orders) {
  const getPayment = o => o.balanceItems?.[0]?.payments?.[0]?.payment ?? null;
  const getPrice = o => (o.balanceItems ?? []).reduce((s, b) => s + (b.unitPrice ?? 0), 0);
  const getStatus = o => getPayment(o)?.status ?? 'Unknown';
  const getItems = o => o.data?.cart?.items ?? [];
  const CANCELLED_STATUSES = ['Failed', 'Canceled', 'Refunded', 'Disputed', 'Deleted'];

  const uniqueOrders = orders.filter(o => {
    const s = getStatus(o);
    return s !== 'Deleted' && s !== 'Canceled';
  });
  const activeOrders = uniqueOrders.filter(o => !CANCELLED_STATUSES.includes(getStatus(o)));
  let tickets = 0;
  activeOrders.forEach(o => getItems(o).forEach(i => { tickets += (i.amount || 0); }));
  const revenue = uniqueOrders.reduce((s, o) => s + getPrice(o), 0);
  const orderCount = uniqueOrders.length;

  return {
    id: webshop.id,
    name: webshop.meta?.name || 'Productie',
    date: openingDate(webshop),
    tickets,
    revenue,
    orderCount,
    avgOrder: orderCount ? revenue / orderCount : 0,
  };
}

let _statsRows = [];

async function loadStats() {
  setStatus('⏳ Producties zoeken...', 'loading');
  renderEmptyTableHead('statsTableHead', STATS_COLUMNS, _statsTableState);
  try {
    const all = await fetchAllWebshops();
    const hidden = new Set(CONFIG.hiddenWebshopIds || []);
    const productions = all.filter(ws => {
      if (hidden.has(ws.id)) return false;
      return !EXCLUDED_STATS_NAME.test(ws.meta?.name || '');
    });
    if (productions.length === 0) throw new Error('Geen producties gevonden');

    setStatus('⏳ Data ophalen van Stamhoofd...', 'loading');
    const rows = await mapWithConcurrency(productions, 3, async (ws) => {
      const [orders, webshop] = await Promise.all([fetchAllOrders(ws.id), fetchWebshop(ws.id)]);
      return computeStatsRow(webshop, orders);
    });
    rows.sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));

    _statsRows = rows;
    renderStatsTable(rows);
    renderStatsCharts(rows);

    const totalTickets = rows.reduce((s, r) => s + r.tickets, 0);
    setStatus('✓ Laatste update: ' + new Date().toLocaleTimeString('nl-BE') + ' — ' + rows.length + ' producties, ' + totalTickets + ' tickets totaal', 'success');
  } catch (err) {
    console.error('loadStats error:', err);
    setStatus('✗ Fout: ' + err.message, 'error');
    const tbody = document.getElementById('statsTable');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Kon geen data laden.</div></td></tr>';
    renderEmptyTableHead('statsTableHead', STATS_COLUMNS, _statsTableState);
  }
}

const STATS_COLUMNS = [
  { key: 'name', label: 'Productie', get: r => r.name },
  { key: 'date', label: 'Datum', get: r => r.date, format: v => v ? fmtDate(v) : '—' },
  { key: 'tickets', label: 'Toeschouwers', get: r => r.tickets },
  { key: 'revenue', label: 'Omzet', get: r => r.revenue, format: v => fmt(v) },
  { key: 'avgOrder', label: 'Gem. bestelwaarde', get: r => r.avgOrder, format: v => fmt(v) },
];
const _statsTableState = { sortKey: 'date', sortDir: 1, filters: {} };

function renderStatsTable(rows) {
  const tbody = document.getElementById('statsTable');
  const theadEl = document.getElementById('statsTableHead');
  if (!tbody || !theadEl) return;

  function recompute() {
    const filtered = applySortAndFilter(rows, STATS_COLUMNS, _statsTableState);
    const active = Object.values(_statsTableState.filters).some(f => f && f.trim());
    document.getElementById('statsCount').textContent = active
      ? `${filtered.length} van ${rows.length} producties`
      : `${rows.length} producties`;

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state">Geen producties gevonden</div></td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map(r => `
      <tr>
        <td>${escHtml(r.name)}</td>
        <td style="color:var(--muted)">${r.date ? fmtDate(r.date) : '—'}</td>
        <td>${r.tickets}</td>
        <td>${fmt(r.revenue)}</td>
        <td>${fmt(r.avgOrder)}</td>
      </tr>
    `).join('');
  }

  renderTableHead(theadEl, STATS_COLUMNS, _statsTableState, recompute);
  recompute();
}

function renderStatsCharts(rows) {
  document.getElementById('statsChartMeta1').textContent = rows.length + ' producties';
  document.getElementById('statsChartMeta2').textContent = fmt(rows.reduce((s, r) => s + r.revenue, 0)) + ' totaal';
  document.getElementById('statsChartMeta3').textContent = rows.length ? fmt(rows.reduce((s, r) => s + r.avgOrder, 0) / rows.length) + ' gemiddeld' : '—';

  const labels = rows.map(r => r.name);
  renderStatsBarChart('statsChartTickets', labels, rows.map(r => r.tickets), v => Math.round(v).toLocaleString('nl-BE'));
  renderStatsBarChart('statsChartRevenue', labels, rows.map(r => r.revenue), v => fmt(v));
  renderStatsBarChart('statsChartAvg', labels, rows.map(r => r.avgOrder), v => fmt(v));
}

// Generic hand-rolled SVG bar chart — one production per bar, in the order
// given (already chronological by the time this is called). No charting
// library, consistent with the rest of this dashboard.
function renderStatsBarChart(svgId, labels, values, formatValue) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  svg.innerHTML = '';
  if (!values.length) return;

  const W = 800, H = 160, PL = 54, PR = 10, PT = 10, PB = 30;
  const cW = W - PL - PR, cH = H - PT - PB;
  const maxVal = Math.max(...values, 1);
  const n = values.length;
  const barW = Math.max(4, Math.min(48, (cW / n) - 4));
  const px = (i) => PL + (i + 0.5) * (cW / n);

  let grid = '';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = (maxVal / ticks) * i;
    const y = PT + cH - (val / maxVal) * cH;
    grid += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    grid += `<text x="${PL - 6}" y="${y + 4}" text-anchor="end" font-family="Outfit,sans-serif" font-size="9" fill="var(--muted)">${formatValue(val)}</text>`;
  }

  let bars = '';
  values.forEach((val, i) => {
    const x = px(i) - barW / 2;
    const h = Math.max(2, (val / maxVal) * cH);
    const y = PT + cH - h;
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="var(--gold)" opacity="0.85" rx="2"`
      + ` data-label="${escHtml(labels[i])}" data-value="${escHtml(formatValue(val))}"`
      + ' style="cursor:pointer;transition:opacity 0.1s"'
      + ` onmouseenter="showStatsTooltip(event,this)" onmouseleave="hideStatsTooltip()"></rect>`;
    if (n <= 12 || i % Math.ceil(n / 12) === 0) {
      bars += `<text x="${px(i)}" y="${PT + cH + 16}" text-anchor="middle" font-family="Outfit,sans-serif" font-size="8" fill="var(--muted)">${escHtml(shortLabel(labels[i]))}</text>`;
    }
  });

  svg.innerHTML = grid + bars;
}

function shortLabel(name) {
  return name.length > 12 ? name.slice(0, 11) + '…' : name;
}

function showStatsTooltip(event, rect) {
  const tooltip = document.getElementById('statsChartTooltip');
  if (!tooltip) return;
  const label = rect.getAttribute('data-label');
  const value = rect.getAttribute('data-value');
  tooltip.innerHTML = '<strong>' + label + '</strong><br><span style="color:var(--gold)">' + value + '</span>';
  tooltip.style.display = 'block';
  const container = rect.closest('.main-grid');
  const containerRect = container.getBoundingClientRect();
  const barRect = rect.getBoundingClientRect();
  const left = barRect.left - containerRect.left + barRect.width / 2;
  const top = barRect.top - containerRect.top - 10;
  tooltip.style.left = Math.min(left, containerRect.width - 160) + 'px';
  tooltip.style.top = (top - tooltip.offsetHeight - 4) + 'px';
  rect.setAttribute('opacity', '1');
}

function hideStatsTooltip() {
  const tooltip = document.getElementById('statsChartTooltip');
  if (tooltip) tooltip.style.display = 'none';
  document.querySelectorAll('#statsChartTickets rect, #statsChartRevenue rect, #statsChartAvg rect')
    .forEach(r => r.setAttribute('opacity', '0.85'));
}

// ─── STAMHOOFD STATUS ─────────────────────────────────────
async function fetchStamhoofdStatus() {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  // Try fetching through proxy first, fall back to direct no-cors ping
  const urls = [
    proxied('https://status.stamhoofd.app/nl', false),
    'https://status.stamhoofd.app/nl'
  ];
  for (const url of urls) {
    try {
      const isCors = url.includes('workers.dev');
      const res = await fetch(url, { cache: 'no-store', mode: isCors ? 'cors' : 'no-cors' });
      // no-cors responses are opaque (status 0) — we can only tell it reached the server
      if (!isCors) {
        dot.style.background = 'var(--green)';
        label.textContent = 'Stamhoofd online';
        return;
      }
      const text = await res.text();
      if (text.includes('Alle services zijn online')) {
        dot.style.background = 'var(--green)';
        label.textContent = 'Stamhoofd online';
      } else if (text.includes('gedeeltelijke storing') || text.includes('Gedeeltelijke storing')) {
        dot.style.background = 'var(--gold)';
        label.textContent = 'Gedeeltelijke storing';
      } else if (text.includes('Uitvaltijd') || text.includes('Storing')) {
        dot.style.background = 'var(--red)';
        label.textContent = 'Storing gedetecteerd';
      } else {
        dot.style.background = 'var(--green)';
        label.textContent = 'Stamhoofd online';
      }
      return;
    } catch(e) { /* try next */ }
  }
  dot.style.background = 'var(--muted)';
  label.textContent = 'Status onbekend';
}

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function() {

  document.getElementById('liveDate').textContent = new Date().toLocaleDateString('nl-BE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  // Load the centrally-managed orgId/webshopId before anything else,
  // so the dashboard (and the admin settings panel) reflect the
  // admin's current setting, not a stale per-browser cache.
  await loadRemoteConfig();

  // Check for existing session; if none, login overlay stays visible
  await checkSession();

  // Auto-refresh every 15 minutes — only the live "actueel" dashboard, and
  // only while it's actually showing current (not archived) productions.
  // Both the archive view and the statistics page fetch every production's
  // full order history at once, which is heavy enough that re-running it
  // unattended on a timer risks the kind of rate-limit hit seen earlier —
  // those two only ever reload when someone explicitly asks (↻ Vernieuwen,
  // opening ↩ Archief, etc.).
  setInterval(function() {
    if (getSession() && !isStatsPage() && !_showArchived) {
      loadData();
      fetchStamhoofdStatus();
    }
  }, 15 * 60 * 1000);

 // Fetch latest GitHub commit date
try {
  const res = await fetch('https://api.github.com/repos/webmaster-KVK/kvk-dashboard/commits?per_page=1');
  const data = await res.json();
  const linkHeader = res.headers.get('Link');
  const totalCommits = linkHeader
    ? parseInt(linkHeader.match(/page=(\d+)>; rel="last"/)[1])
    : 1;
  const date = new Date(data[0].commit.committer.date);
  const el = document.getElementById('lastCommitDate');
  if (el) el.textContent = date.toLocaleString('nl-BE', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }) + ' — versie ' + totalCommits;
} catch(e) {
  const el = document.getElementById('lastCommitDate');
  if (el) el.textContent = 'onbekend';
}

});
