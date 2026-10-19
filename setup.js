// Self-serve client setup, used by the dashboard's Setup page.
//
// Flow: you send a client  <dashboard>/?signup=<CONNECT_KEY>  -> they create a
// login (POST /api/signup) -> connect Instagram (POST /api/setup/connect hands
// back the Instagram approval URL; the callback in server.js links the new
// tenant row to their login) -> paste their website and let the AI draft
// their business info (POST /api/setup/draft) -> send a test DM, which the
// status endpoint reports -> ask to go live (POST /api/setup/notify), which
// emails you. Switching a tenant on stays an admin-only action.
//
// Env vars: CONNECT_KEY (also the sign-up key), MAIL_TO (where setup emails
// go), TESTER_INVITES_REQUIRED=false once Meta App Review is approved.

const dns = require('dns').promises;
const net = require('net');

const SIGNUP_LIMIT_PER_HOUR = 5;
const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const PAGE_MAX_BYTES = 1500000;
const DRAFT_MAX_TEXT = 24000;
const DRAFT_MIN_TEXT = 300;
const EXTRA_PAGE_HINTS = /(shop|store|product|price|pricing|menu|service|package|book|order|deliver|shipping|faq|contact|about)/i;

function registerSetupRoutes(app, deps) {
  const { fetchWithTimeout, supabaseHeaders, askGemini, sendResendEmail, verifyDashboardUser, safeEqual, instagramAuthorizeUrl, lastInboundAt } = deps;

  const signupsByIp = new Map(); // ip -> [timestamps]
  const lastNotify = new Map(); // `${userId}:${kind}` -> ms

  async function requireUser(req, res) {
    const user = await verifyDashboardUser(req);
    if (!user || !user.id) {
      res.status(401).json({ error: 'Not signed in' });
      return null;
    }
    return user;
  }

  async function ownedTenant(userId) {
    const response = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/tenants?owner_user_id=eq.${encodeURIComponent(userId)}` +
        '&select=id,business_name,instagram_account_id,active,knowledge_base&limit=1',
      { headers: supabaseHeaders() },
      8000
    );
    if (!response.ok) throw new Error('Tenant lookup failed');
    const rows = await response.json();
    return rows[0] || null;
  }

  function notifyAdmin(subject, lines) {
    return sendResendEmail(process.env.MAIL_TO, subject, lines.join('\n'));
  }

  // ----- Create a client login -----
  app.post('/api/signup', async function (req, res) {
    const { key, email, password, businessName } = req.body || {};
    if (!process.env.CONNECT_KEY || !safeEqual(key || '', process.env.CONNECT_KEY)) {
      return res.status(403).json({ error: 'This sign-up link is not valid. Please ask for a new one.' });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const recent = (signupsByIp.get(ip) || []).filter((t) => Date.now() - t < 60 * 60 * 1000);
    if (recent.length >= SIGNUP_LIMIT_PER_HOUR) {
      return res.status(429).json({ error: 'Too many sign-ups from this network. Try again in an hour.' });
    }

    const cleanEmail = String(email || '').trim().toLowerCase();
    const name = String(businessName || '').trim().slice(0, 80);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (String(password || '').length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
    if (!name) return res.status(400).json({ error: 'Enter your business name.' });

    try {
      const response = await fetchWithTimeout(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: supabaseHeaders(),
        body: JSON.stringify({ email: cleanEmail, password, email_confirm: true, user_metadata: { business_name: name } })
      }, 10000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = String(data.msg || data.message || data.error_description || '');
        if (response.status === 422 || /already/i.test(msg)) {
          return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
        }
        console.error('Signup failed:', response.status, JSON.stringify(data));
        return res.status(500).json({ error: 'Could not create your account. Please try again.' });
      }

      recent.push(Date.now());
      signupsByIp.set(ip, recent);
      console.log(`Setup: new client login for "${name}"`);
      notifyAdmin(`New sign-up: ${name}`, [
        `${name} (${cleanEmail}) just created an account and is starting setup.`,
        '',
        'Nothing to do yet - you will get another email when they ask for an Instagram tester invite or to go live.'
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.error('Signup threw:', err.message);
      res.status(500).json({ error: 'Could not create your account. Please try again.' });
    }
  });

  // ----- Where is this client in the setup? -----
  app.get('/api/setup/status', async function (req, res) {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const tenant = await ownedTenant(user.id);
      res.json({
        email: user.email,
        businessName: (tenant && tenant.business_name) || (user.user_metadata && user.user_metadata.business_name) || null,
        testerInvitesRequired: process.env.TESTER_INVITES_REQUIRED !== 'false',
        instagramConnected: !!(tenant && tenant.instagram_account_id),
        hasInfo: !!(tenant && (tenant.knowledge_base || '').trim().length >= 50),
        active: !!(tenant && tenant.active),
        lastMessageAt: (tenant && lastInboundAt.get(String(tenant.instagram_account_id))) || null
      });
    } catch (err) {
      console.error('Setup status failed:', err.message);
      res.status(500).json({ error: 'Could not load your setup. Refresh to try again.' });
    }
  });

  // ----- Start the Instagram connection for this login -----
  app.post('/api/setup/connect', async function (req, res) {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!process.env.INSTAGRAM_APP_ID || !process.env.META_APP_SECRET) {
      return res.status(503).json({ error: 'Instagram connection is not enabled on the server.' });
    }
    const back = String((req.body && req.body.returnTo) || '');
    const url = instagramAuthorizeUrl(req, {
      t: Date.now(),
      label: (user.user_metadata && user.user_metadata.business_name) || null,
      owner: user.id,
      email: user.email,
      back: /^https?:\/\//.test(back) ? back.slice(0, 300) : null
    });
    res.json({ url });
  });

  // ----- Draft business info from their website -----
  app.post('/api/setup/draft', async function (req, res) {
    const user = await requireUser(req, res);
    if (!user) return;

    let start;
    try {
      start = new URL(/^https?:\/\//i.test(String(req.body && req.body.url).trim()) ? String(req.body.url).trim() : `https://${String(req.body && req.body.url).trim()}`);
    } catch (e) {
      return res.status(400).json({ error: 'That doesn\'t look like a website address.' });
    }

    try {
      const pages = await readSite(start, fetchWithTimeout);
      const text = pages.map((p) => `--- ${p.url} ---\n${p.text}`).join('\n\n').slice(0, DRAFT_MAX_TEXT);
      if (text.replace(/---.*---/g, '').trim().length < DRAFT_MIN_TEXT) {
        return res.status(422).json({ error: 'We couldn\'t read enough from that website (some sites only load in a browser). Type your prices and info into the boxes below instead.' });
      }

      const result = await askGemini(draftPrompt(text));
      const parsed = result && result.parsed;
      if (!parsed || !parsed.knowledge_base) {
        return res.status(502).json({ error: 'The AI did not answer. Wait a minute and try again.' });
      }
      console.log(`Setup: drafted business info for ${user.id} from ${start.hostname} (${pages.length} page(s))`);
      res.json({
        business_description: String(parsed.business_description || '').trim(),
        knowledge_base: String(parsed.knowledge_base || '').trim(),
        missing: Array.isArray(parsed.missing) ? parsed.missing.map(String).slice(0, 12) : []
      });
    } catch (err) {
      console.error('Setup draft failed:', err.message);
      res.status(422).json({ error: err.userMessage || 'We couldn\'t open that website. Check the address, or type your info into the boxes below instead.' });
    }
  });

  // ----- Ask the admin for a tester invite, or to go live -----
  app.post('/api/setup/notify', async function (req, res) {
    const user = await requireUser(req, res);
    if (!user) return;
    const kind = req.body && req.body.kind;
    if (kind !== 'invite' && kind !== 'live') return res.status(400).json({ error: 'Unknown request.' });

    const cooldownKey = `${user.id}:${kind}`;
    if (Date.now() - (lastNotify.get(cooldownKey) || 0) < NOTIFY_COOLDOWN_MS) {
      return res.json({ ok: true, alreadySent: true });
    }

    try {
      const tenant = await ownedTenant(user.id);
      const name = (tenant && tenant.business_name) || (user.user_metadata && user.user_metadata.business_name) || user.email;
      let sent;
      if (kind === 'invite') {
        const username = String((req.body && req.body.instagramUsername) || '').trim().replace(/^@/, '').slice(0, 60);
        if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) return res.status(400).json({ error: 'Enter your Instagram username, e.g. mybusiness.' });
        sent = await notifyAdmin(`Tester invite needed: @${username}`, [
          `${name} (${user.email}) needs an Instagram tester invite for @${username}.`,
          '',
          'Meta Developer dashboard -> your app -> App roles -> Roles -> Add people -> Instagram tester -> ' + username,
          'They have been told how to accept it, then they connect Instagram from their Setup page.'
        ]);
      } else {
        if (!tenant || !tenant.instagram_account_id) return res.status(400).json({ error: 'Connect your Instagram account first.' });
        sent = await notifyAdmin(`Ready to go live: ${name}`, [
          `${name} (${user.email}) finished setup and asked to switch their assistant on.`,
          '',
          `Tenant #${tenant.id}. Check their business info and test a few replies in the dashboard Test tab,`,
          'then tick Active on their tenant and save.'
        ]);
      }
      if (!sent) return res.status(502).json({ error: 'Could not send your request. Try again in a minute.' });
      lastNotify.set(cooldownKey, Date.now());
      res.json({ ok: true });
    } catch (err) {
      console.error('Setup notify failed:', err.message);
      res.status(500).json({ error: 'Could not send your request. Try again in a minute.' });
    }
  });
}

// ----- Website reading -----

function draftPrompt(siteText) {
  return `You are setting up an Instagram DM assistant for a small business. Below is text taken from the business's website. Write the information the assistant will use to answer customer DMs.

Rules:
- Use ONLY facts in the website text. Never invent or estimate a price, product, policy, address, hour or phone number.
- Copy prices exactly as written, with their currency.
- Leave out claims about health effects, cures, results or what a product does to the body, even if the website makes them. Describe such products only by name, size/option and price.
- If something customers usually ask about is not in the text (prices, delivery, payment methods, hours, location, refunds, how to order), leave it out of the knowledge base and list it in "missing".
- Keep the knowledge base as plain text with short headings and "- " bullet points, easy for the owner to edit.
- Always end the knowledge base with this section, unchanged:
LIMITS
- Never promise discounts, free items or delivery dates.
- Never give medical, legal or financial advice. If asked, say a team member will follow up.
- If something isn't written here, say a team member will follow up - don't guess.

Website text:
"""
${siteText}
"""

Reply with ONLY a JSON object, no markdown, in exactly this shape:
{
  "business_description": "<2-3 sentences: who the business is, where it is, who it serves, and the tone to use with customers (e.g. warm and casual)>",
  "knowledge_base": "<the full knowledge base text>",
  "missing": ["<short name of each important thing the website didn't say>"]
}`;
}

async function readSite(start, fetchWithTimeout) {
  const first = await fetchPage(start, fetchWithTimeout);
  const pages = [{ url: first.url, text: first.text }];

  // Follow a few same-site links that usually hold prices, services or policies.
  const seen = new Set([normalise(first.url)]);
  const extra = [];
  for (const href of first.links) {
    let u;
    try { u = new URL(href, first.url); } catch (e) { continue; }
    if (u.hostname !== new URL(first.url).hostname || !/^https?:$/.test(u.protocol)) continue;
    if (!EXTRA_PAGE_HINTS.test(u.pathname)) continue;
    const key = normalise(u.toString());
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(u);
    if (extra.length >= 4) break;
  }

  const results = await Promise.allSettled(extra.map((u) => fetchPage(u, fetchWithTimeout)));
  for (const r of results) if (r.status === 'fulfilled' && r.value.text) pages.push({ url: r.value.url, text: r.value.text });
  return pages;
}

function normalise(u) {
  const x = new URL(u);
  return `${x.hostname}${x.pathname.replace(/\/+$/, '')}`;
}

// Fetches a public web page, refusing anything that resolves to a private or
// local address so the server can't be pointed at its own network.
async function fetchPage(url, fetchWithTimeout) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(current.protocol)) throw userError('Only http and https website addresses work.');
    await assertPublicHost(current.hostname);

    const response = await fetchWithTimeout(current.toString(), {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoAgentSetup/1.0)', Accept: 'text/html,application/xhtml+xml' }
    }, 10000);

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current);
      continue;
    }
    if (!response.ok) throw userError(`That website answered with an error (${response.status}).`);
    const type = response.headers.get('content-type') || '';
    if (!/html|text\/plain/i.test(type)) throw userError('That address isn\'t a web page.');

    const html = (await response.text()).slice(0, PAGE_MAX_BYTES);
    return { url: current.toString(), text: htmlToText(html), links: extractLinks(html) };
  }
  throw userError('That website redirects too many times.');
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw userError('That address isn\'t a public website.');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => {
    throw userError('We couldn\'t find that website. Check the address.');
  });
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw userError('That address isn\'t a public website.');
  }
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

function htmlToText(html) {
  const meta = [];
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)/i);
  if (desc) meta.push(desc[1]);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (title) meta.push(title[1]);

  const body = html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  return [...meta, body].join('\n').trim();
}

function extractLinks(html) {
  const links = [];
  const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 200) links.push(m[1]);
  return links;
}

function userError(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

module.exports = { registerSetupRoutes };
