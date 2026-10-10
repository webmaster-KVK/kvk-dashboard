// Stamhoofd API CORS Proxy + Magic Link Auth — Cloudflare Worker
//
// ── Required secrets ──────────────────────────────────────────────────────────
//   STAMHOOFD_API_KEY  — your Stamhoofd API key
//   ADMIN_PASSWORD     — admin password for the dashboard
//   BREVO_API_KEY      — from brevo.com (free: 300 emails/day, any recipient)
//   NOTIFY_TO          — your email address (admin notifications)
//   NOTIFY_FROM        — a verified sender address in your Brevo account
//   DASHBOARD_URL      — full URL of your dashboard, e.g. https://dennisgeleyn.github.io/kvk-dashboard
//
// ── Required KV binding ───────────────────────────────────────────────────────
//   Variable name: KVK_STORE
//   Create in: Cloudflare dashboard → Workers & Pages → KV → Create namespace
//   Bind in:   Worker → Settings → Variables → KV Namespace Bindings

const ALLOWED_ORIGIN = '*';
const TOKEN_TTL_MS   = 15 * 60 * 1000; // magic links expire after 15 minutes
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sessions last 7 days

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Token, X-Session-Token',
};

const json  = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
const fail  = (msg,  status = 400) => new Response(msg, { status, headers: CORS_HEADERS });

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(len = 32) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// KV helpers — each entity stored under its own key for efficiency
async function kvGet(env, key)      { try { const v = await env.KVK_STORE.get(key); return v ? JSON.parse(v) : null; } catch(e) { return null; } }
async function kvSet(env, key, val) { await env.KVK_STORE.put(key, JSON.stringify(val)); }
async function kvDel(env, key)      { await env.KVK_STORE.delete(key); }

// Generic rate limiter, backed by KV. Tracks attempt counts per key within
// a rolling time window. Used to slow down password guessing and email
// spam — not airtight (KV is eventually consistent across regions), but
// enough of a speed bump to stop casual abuse.
async function rateLimited(env, key, maxAttempts, windowMs) {
  const now = Date.now();
  let data = await kvGet(env, key);
  if (!data || now > data.resetAt) {
    data = { count: 0, resetAt: now + windowMs };
  }
  data.count++;
  await kvSet(env, key, data);
  return data.count > maxAttempts;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function adminOk(request, env) {
  return request.headers.get('X-Admin-Token') === env.ADMIN_PASSWORD;
}

// Used to gate access to the Stamhoofd data proxy: either a valid admin
// token, or a valid (non-expired) regular user session.
async function dataAccessOk(request, env) {
  if (adminOk(request, env)) return true;
  const sessionToken = request.headers.get('X-Session-Token');
  if (!sessionToken) return false;
  const sessionData = await kvGet(env, 'session:' + sessionToken);
  return !!(sessionData && Date.now() <= sessionData.expires);
}

async function sendEmail(env, { to, subject, html }) {
  if (!env.BREVO_API_KEY) throw new Error('BREVO_API_KEY not set');
  const from = env.NOTIFY_FROM || 'dashboard@kvk.be';
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: from, name: 'KVK Dashboard' },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Brevo error ' + res.status + ': ' + txt);
  }
  return true;
}

function magicLinkEmail(dashboardUrl, token, name) {
  const base = dashboardUrl.endsWith('/') ? dashboardUrl : dashboardUrl + '/';
  const link = base + '?token=' + token;
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
      <h2 style="font-size:1.1rem;color:#1e3a6e">🎭 KVK Dashboard</h2>
      ${name ? `<p>Hallo ${name},</p><p>Je toegang is goedgekeurd! Klik op de knop hieronder om in te loggen.</p>` : '<p>Klik op de knop hieronder om in te loggen op het KVK Dashboard.</p>'}
      <p style="margin:1.5rem 0">
        <a href="${link}" style="background:#1e3a6e;color:#ffffff;padding:12px 24px;text-decoration:none;font-family:sans-serif;font-size:0.9rem;font-weight:600;display:inline-block">Inloggen op dashboard</a>
      </p>
      <p style="color:#999;font-size:0.75rem">Deze link is 15 minuten geldig en kan maar één keer gebruikt worden.<br>Als je deze e-mail niet verwacht had, kun je hem negeren.</p>
    </div>`;
}

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' } });
    }

    const url  = new URL(request.url);
    const path = url.pathname;
    const DASHBOARD_URL = env.DASHBOARD_URL || 'https://dennisgeleyn.github.io/kvk-dashboard';

    // ════════════════════════════════════════════════════════
    // /auth POST — admin password check (unchanged)
    // ════════════════════════════════════════════════════════
    if (path === '/auth' && request.method === 'POST') {
      if (await rateLimited(env, 'ratelimit:auth:' + clientIp(request), 5, 15 * 60 * 1000)) {
        return fail('Too many attempts. Try again later.', 429);
      }
      try {
        const { password } = await request.json();
        if (!env.ADMIN_PASSWORD) return fail('Not configured', 500);
        return password === env.ADMIN_PASSWORD ? json({ ok: true }) : json({ ok: false }, 401);
      } catch(e) { return fail('Bad request'); }
    }

    // ════════════════════════════════════════════════════════
    // /magic/request POST — user requests a magic link
    // Body: { email }
    // Only sends if email is in the approved users list
    // ════════════════════════════════════════════════════════
    if (path === '/magic/request' && request.method === 'POST') {
      if (await rateLimited(env, 'ratelimit:magic:' + clientIp(request), 5, 60 * 60 * 1000)) {
        return fail('Too many attempts. Try again later.', 429);
      }
      try {
        const { email } = await request.json();
        if (!email || !email.includes('@')) return fail('Invalid email');

        const emailHash = await sha256(email.trim().toLowerCase());
        const users = await kvGet(env, 'users') || [];
        const user  = users.find(u => u.emailHash === emailHash);

        // Always return ok to avoid email enumeration
        if (user) {
          const token    = randomToken();
          const tokenKey = 'token:' + token;
          await kvSet(env, tokenKey, { emailHash, expires: Date.now() + TOKEN_TTL_MS });

          try {
            await sendEmail(env, {
              to: email.trim().toLowerCase(),
              subject: 'KVK Dashboard — jouw inloglink',
              html: magicLinkEmail(DASHBOARD_URL, token, user.name || '')
            });
          } catch(e) {
            // Clean up token if email fails, and surface the error
            await kvDel(env, tokenKey);
            return json({ ok: false, error: e.message }, 502);
          }
        }

        return json({ ok: true });
      } catch(e) { return fail('Bad request: ' + e.message); }
    }

    // ════════════════════════════════════════════════════════
    // /magic/verify POST — exchange token for session
    // Body: { token }
    // ════════════════════════════════════════════════════════
    if (path === '/magic/verify' && request.method === 'POST') {
      try {
        const { token } = await request.json();
        if (!token) return fail('Missing token');

        const tokenKey  = 'token:' + token;
        const tokenData = await kvGet(env, tokenKey);

        if (!tokenData || Date.now() > tokenData.expires) {
          await kvDel(env, tokenKey);
          return json({ ok: false, reason: 'expired' }, 401);
        }

        // Token is valid — create a session, delete the one-time token
        await kvDel(env, tokenKey);
        const sessionToken = randomToken();
        const sessionKey   = 'session:' + sessionToken;
        await kvSet(env, sessionKey, {
          emailHash: tokenData.emailHash,
          expires:   Date.now() + SESSION_TTL_MS
        });

        // Update lastLogin on the user record
        const users = await kvGet(env, 'users') || [];
        const userIdx = users.findIndex(u => u.emailHash === tokenData.emailHash);
        if (userIdx !== -1) {
          users[userIdx].lastLogin = new Date().toISOString();
          await kvSet(env, 'users', users);
        }
        const user = users[userIdx] ?? null;

        return json({ ok: true, sessionToken, name: (user && user.name) || '', displayEmail: (user && user.displayEmail) || '' });
      } catch(e) { return fail('Bad request'); }
    }

    // ════════════════════════════════════════════════════════
    // /session/verify POST — check if a session token is valid
    // Body: { sessionToken }
    // ════════════════════════════════════════════════════════
    if (path === '/session/verify' && request.method === 'POST') {
      try {
        const { sessionToken } = await request.json();
        if (!sessionToken) return fail('Missing token');

        const sessionKey  = 'session:' + sessionToken;
        const sessionData = await kvGet(env, sessionKey);

        if (!sessionData || Date.now() > sessionData.expires) {
          await kvDel(env, sessionKey);
          return json({ ok: false, reason: 'expired' }, 401);
        }

        // Silently extend session on activity
        sessionData.expires = Date.now() + SESSION_TTL_MS;
        await kvSet(env, sessionKey, sessionData);

        // Look up user's name to return with session
        const users = await kvGet(env, 'users') || [];
        const user  = users.find(u => u.emailHash === sessionData.emailHash);

        return json({ ok: true, emailHash: sessionData.emailHash, name: (user && user.name) || '', displayEmail: (user && user.displayEmail) || '' });
      } catch(e) { return fail('Bad request'); }
    }

    // ════════════════════════════════════════════════════════
    // /session/logout POST — invalidate a session
    // Body: { sessionToken }
    // ════════════════════════════════════════════════════════
    if (path === '/session/logout' && request.method === 'POST') {
      try {
        const { sessionToken } = await request.json();
        if (sessionToken) await kvDel(env, 'session:' + sessionToken);
        return json({ ok: true });
      } catch(e) { return json({ ok: true }); }
    }

    // ════════════════════════════════════════════════════════
    // /users GET — list users + requests (admin only)
    // ════════════════════════════════════════════════════════
    if (path === '/users' && request.method === 'GET') {
      if (!adminOk(request, env)) return fail('Unauthorized', 401);
      const users    = await kvGet(env, 'users')    || [];
      const requests = await kvGet(env, 'requests') || [];
      return json({ users, requests });
    }

    // ════════════════════════════════════════════════════════
    // /requests POST — submit an access request
    // Body: { name, email }  (full email, hashed in worker)
    // ════════════════════════════════════════════════════════
    if (path === '/requests' && request.method === 'POST') {
      if (await rateLimited(env, 'ratelimit:requests:' + clientIp(request), 5, 60 * 60 * 1000)) {
        return fail('Too many attempts. Try again later.', 429);
      }
      try {
        const { name, email } = await request.json();
        if (!name || !email || !email.includes('@')) return fail('Missing fields');

        const emailNorm = email.trim().toLowerCase();
        const emailHash = await sha256(emailNorm);
        const [local, domain] = emailNorm.split('@');
        const displayEmail = local.slice(0, 3) + '***@' + domain;

        const requests = await kvGet(env, 'requests') || [];
        const users    = await kvGet(env, 'users')    || [];
        if (requests.find(r => r.emailHash === emailHash)) return json({ ok: false, reason: 'duplicate' });
        if (users.find(u => u.emailHash === emailHash))    return json({ ok: false, reason: 'already_approved' });

        requests.push({ id: Date.now().toString(), name, email: emailNorm, emailHash, displayEmail, ts: new Date().toISOString() });
        await kvSet(env, 'requests', requests);

        // Notify admin — must be awaited, unawaited fetches are killed when Worker returns
        let emailError = null;
        if (env.BREVO_API_KEY && env.NOTIFY_TO) {
          try {
            await sendEmail(env, {
              to: env.NOTIFY_TO,
              subject: 'KVK Dashboard — nieuwe toegangsaanvraag',
              html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem">
                  <h2 style="font-size:1.1rem;color:#1a1a1a">🎭 KVK Dashboard</h2>
                  <p>Nieuwe toegangsaanvraag:</p>
                  <table>
                    <tr><td style="padding:4px 16px 4px 0;color:#666">Naam</td><td><strong>${name}</strong></td></tr>
                    <tr><td style="padding:4px 16px 4px 0;color:#666">E-mail</td><td>${displayEmail}</td></tr>
                    <tr><td style="padding:4px 16px 4px 0;color:#666">Tijdstip</td><td>${new Date().toLocaleString('nl-BE')}</td></tr>
                  </table>
                  <p style="margin-top:1.5rem;font-size:0.8rem;color:#333">
                    Open het dashboard: <span style="word-break:break-all">${DASHBOARD_URL}</span>
                  </p>
                  <p style="color:#999;font-size:0.75rem">Log in als beheerder → ⚙ Instellingen → Gebruikersbeheer.</p>
                </div>`
            });
          } catch(e) { emailError = e.message; }
        }

        return json({ ok: true, emailError });
      } catch(e) { return fail('Bad request: ' + e.message); }
    }

    // ════════════════════════════════════════════════════════
    // /requests/:id/approve POST — approve + send welcome magic link
    // ════════════════════════════════════════════════════════
    if (path.match(/^\/requests\/[^/]+\/approve$/) && request.method === 'POST') {
      if (!adminOk(request, env)) return fail('Unauthorized', 401);
      try {
        const reqId    = path.split('/')[2];
        const requests = await kvGet(env, 'requests') || [];
        const req      = requests.find(r => r.id === reqId);
        if (!req) return fail('Not found', 404);

        // Add to approved users
        const users = await kvGet(env, 'users') || [];
        if (!users.find(u => u.emailHash === req.emailHash)) {
          users.push({ emailHash: req.emailHash, displayEmail: req.displayEmail, name: req.name, email: req.email });
          await kvSet(env, 'users', users);
        }
        await kvSet(env, 'requests', requests.filter(r => r.id !== reqId));

        // Send welcome magic link to the new user
        const token    = randomToken();
        const tokenKey = 'token:' + token;
        await kvSet(env, tokenKey, { emailHash: req.emailHash, expires: Date.now() + TOKEN_TTL_MS });

        try {
          await sendEmail(env, {
            to: req.email,
            subject: 'KVK Dashboard — je toegang is goedgekeurd!',
            html: magicLinkEmail(DASHBOARD_URL, token, req.name)
          });
        } catch(e) {
          // User is approved even if email fails — admin can resend later
          return json({ ok: true, emailError: e.message });
        }

        return json({ ok: true });
      } catch(e) { return fail('Bad request: ' + e.message); }
    }

    // ════════════════════════════════════════════════════════
    // /requests/:id/deny DELETE
    // ════════════════════════════════════════════════════════
    if (path.match(/^\/requests\/[^/]+\/deny$/) && request.method === 'DELETE') {
      if (!adminOk(request, env)) return fail('Unauthorized', 401);
      const reqId    = path.split('/')[2];
      const requests = await kvGet(env, 'requests') || [];
      await kvSet(env, 'requests', requests.filter(r => r.id !== reqId));
      return json({ ok: true });
    }

    // ════════════════════════════════════════════════════════
    // /users/:emailHash DELETE — revoke user
    // ════════════════════════════════════════════════════════
    if (path.match(/^\/users\/[^/]+$/) && request.method === 'DELETE') {
      if (!adminOk(request, env)) return fail('Unauthorized', 401);
      const emailHash = path.split('/')[2];
      const users     = await kvGet(env, 'users') || [];
      await kvSet(env, 'users', users.filter(u => u.emailHash !== emailHash));
      return json({ ok: true });
    }

    // ════════════════════════════════════════════════════════
    // /users/:emailHash/resend POST — resend magic link (admin)
    // ════════════════════════════════════════════════════════
    if (path.match(/^\/users\/[^/]+\/resend$/) && request.method === 'POST') {
      if (!adminOk(request, env)) return fail('Unauthorized', 401);
      try {
        const emailHash = path.split('/')[2];
        const body = await request.json().catch(() => ({}));

        // Prefer email stored in user record; fall back to what admin provided
        const users = await kvGet(env, 'users') || [];
        const user  = users.find(u => u.emailHash === emailHash);
        const email = (user && user.email) || body.email;
        if (!email) return fail('Missing email');

        const token    = randomToken();
        const tokenKey = 'token:' + token;
        await kvSet(env, tokenKey, { emailHash, expires: Date.now() + TOKEN_TTL_MS });

        await sendEmail(env, {
          to: email,
          subject: 'KVK Dashboard — nieuwe inloglink',
          html: magicLinkEmail(DASHBOARD_URL, token, (user && user.name) || '')
        });

        return json({ ok: true });
      } catch(e) { return json({ ok: false, error: e.message }, 502); }
    }

   // ════════════════════════════════════════════════════════
    // /config — centrally managed orgId/hiddenWebshopIds
    // GET  is public (these IDs aren't secret — they're needed by every
    //      visitor's browser). Webshops themselves are fetched live from
    //      Stamhoofd by the dashboard (see discoverWebshops in app.js) —
    //      this only stores which ones the admin chose to hide.
    // POST requires a valid admin token, so only the admin can change
    //      which webshops are hidden for everyone.
    // ════════════════════════════════════════════════════════
if (path === '/config' && request.method === 'GET') {
      const config = await kvGet(env, 'app:config') || {};
      return json(config);
    }

    if (path === '/config' && request.method === 'POST') {
      if (!adminOk(request, env)) return fail('Unauthorized', 401);
      try {
        const { orgId, hiddenWebshopIds } = await request.json();
        if (!orgId) return fail('orgId is required');
        if (hiddenWebshopIds !== undefined && !Array.isArray(hiddenWebshopIds)) {
          return fail('hiddenWebshopIds must be an array');
        }
        const cleanHidden = (hiddenWebshopIds || []).map(id => String(id).trim()).filter(Boolean).slice(0, 200);
        const config = { orgId: String(orgId).trim(), hiddenWebshopIds: cleanHidden };
        await kvSet(env, 'app:config', config);
        return json({ ok: true, config });
      } catch(e) { return fail('Bad request'); }
    }
   
   // ════════════════════════════════════════════════════════
    // /proxy — Stamhoofd API CORS proxy
    // ════════════════════════════════════════════════════════
    if (path === '/proxy') {
      // Only GET is ever needed by the dashboard — also closes off the
      // open-relay risk of forwarding arbitrary POST/PUT/DELETE bodies.
      if (request.method !== 'GET') return fail('Method not allowed', 405);

      const targetParam = url.searchParams.get('url');
      if (!targetParam) return fail('Missing ?url= parameter');

      let target;
      try { target = new URL(targetParam); }
      catch(e) { return fail('Invalid url parameter', 400); }

      // Strict hostname check — NOT a substring check. A substring check
      // (target.includes('api.stamhoofd.app')) can be defeated with e.g.
      // "https://attacker.com/?x=api.stamhoofd.app", which would still
      // match the substring while actually sending the request — and the
      // Stamhoofd API key — to attacker.com.
      const host = target.hostname;
      const isStamhoofdApi = host === 'api.stamhoofd.app' || host.endsWith('.api.stamhoofd.app');
      const isStamhoofdStatus = host === 'status.stamhoofd.app';
      if (!isStamhoofdApi && !isStamhoofdStatus) return fail('Domain not allowed', 403);

      const fwd = new Headers();
      if (isStamhoofdApi) {
        if (!(await dataAccessOk(request, env))) return fail('Unauthorized', 401);
        if (!env.STAMHOOFD_API_KEY) return fail('API key not configured', 500);
        fwd.set('Authorization', 'Bearer ' + env.STAMHOOFD_API_KEY);
      }
      const ct = request.headers.get('Content-Type');
      if (ct) fwd.set('Content-Type', ct);
      let res;
      try {
        res = await fetch(new Request(target.toString(), { method: 'GET', headers: fwd }));
      } catch(e) { return fail('Proxy error: ' + e.message, 502); }
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { ...CORS_HEADERS, 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
      });
    }
    return fail('Not found', 404);
  },
};
