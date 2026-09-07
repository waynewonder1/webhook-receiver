require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const app = express();

// Email is sent through Resend's HTTP API (https://api.resend.com, port 443)
// instead of SMTP. Render blocks outbound SMTP ports (25/465/587), so
// nodemailer/Gmail could never actually connect from here.
//   RESEND_API_KEY - from the Resend dashboard (starts with "re_")
//   MAIL_TO        - the address that receives the lead alerts
//   MAIL_FROM      - optional; a verified Resend sender. Defaults to
//                    onboarding@resend.dev, which can only deliver to the
//                    email you signed up to Resend with.
const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';

app.use(function (req, res, next) {
  console.log('Incoming request:', req.method, req.url);
  next();
});

// We need the RAW request body (not the parsed object) to verify Meta's
// signature below - HMAC has to be computed over the exact bytes Meta
// sent, before JSON.parse touches them. express.json()'s `verify` option
// lets us stash that raw buffer on the request as a side effect of
// parsing, so both the raw bytes and the parsed body are available.
app.use(express.json({
  verify: function (req, res, buf) {
    req.rawBody = buf;
  }
}));

// Small helper: wraps fetch with a timeout so a hanging request (Gemini,
// Supabase, anything) fails fast instead of blocking forever.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Meta webhook signature verification
// ---------------------------------------------------------------------------

// Meta signs every real webhook POST with an X-Hub-Signature-256 header:
// "sha256=<hmac>", where the HMAC is computed over the raw request body
// using your app's secret as the key. Verifying this is the only way to
// know a request claiming to be "from Instagram" actually came from Meta
// and not from anyone who found your URL and forged the same JSON shape.
//
// Requires META_APP_SECRET on Render - this is the "Instagram app secret"
// shown on the API setup page in the Meta dashboard (click "Show").
function isValidMetaSignature(req) {
  if (!process.env.META_APP_SECRET) {
    console.error('META_APP_SECRET not set - cannot verify Meta signature');
    return false;
  }

  const signatureHeader = req.headers['x-hub-signature-256'];
  if (!signatureHeader || !req.rawBody) {
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  // timingSafeEqual requires both buffers to be the same length, so check
  // that first - a length mismatch just means "not equal", not an error.
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

function supabaseHeaders(extra) {
  return {
    'apikey': process.env.SUPABASE_KEY,
    'authorization': `Bearer ${process.env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

// Insert a lead row and return its new id. Throws on any failure; the
// thrown error carries `.statusCode` so the flat-shape caller can pass a
// sensible HTTP status back to whoever is waiting.
async function saveLead({ name, message, email, platform, igMid }) {
  const row = { name, message, email, platform };
  // Only send ig_mid when the column actually exists, otherwise PostgREST
  // rejects the whole insert.
  if (persistentDedupeEnabled && igMid) row.ig_mid = igMid;

  let response;
  try {
    response = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/leads_v2`,
      {
        method: 'POST',
        headers: supabaseHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify(row)
      },
      8000 // 8s timeout
    );
  } catch (err) {
    const wrapped = new Error(`Supabase save threw: ${err.message}`);
    wrapped.statusCode = 500;
    throw wrapped;
  }

  // 409 = unique-constraint violation on ig_mid: this exact message was
  // already saved by a concurrent redelivery. Not an error - just skip.
  if (response.status === 409) {
    const dup = new Error('Duplicate ig_mid - lead already saved');
    dup.duplicate = true;
    throw dup;
  }

  const savedLead = await response.json();
  console.log('Saved to Supabase:', savedLead);

  if (!response.ok || !savedLead[0]) {
    const err = new Error(`Supabase save failed: ${JSON.stringify(savedLead)}`);
    err.statusCode = 502;
    throw err;
  }

  return savedLead[0].id;
}

// Patch fields onto an existing lead row. Throws on failure.
async function updateLead(leadId, fields) {
  return patchLeadsWhere(`id=eq.${leadId}`, fields);
}

// Patch fields onto every lead row matching a PostgREST filter string
// (e.g. "name=eq.Instagram%20user%20123"). Throws on failure.
async function patchLeadsWhere(filter, fields) {
  const response = await fetchWithTimeout(
    `${process.env.SUPABASE_URL}/rest/v1/leads_v2?${filter}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(),
      body: JSON.stringify(fields)
    },
    8000
  );
  if (!response.ok) {
    throw new Error(`Supabase update failed: ${JSON.stringify(await response.json().catch(() => ({})))}`);
  }
}

// ---------------------------------------------------------------------------
// Instagram helpers
// ---------------------------------------------------------------------------

// Instagram's webhook only gives you the sender's numeric ID, not their
// name. This looks up their real name/username via the Graph API.
// Requires INSTAGRAM_ACCESS_TOKEN to be set on Render (the token you
// generated in "Generate access tokens"). Returns null on any failure -
// callers should fall back to using the raw ID instead.
//
// Results are cached in memory so repeated messages from the same person
// don't each trigger a fresh Graph API call: successes for an hour,
// failures for a few minutes (so a transient error gets retried soon, but
// a broken token doesn't get hammered on every incoming message).
const nameCache = new Map(); // senderId -> { value: string|null, expires: number }
const NAME_CACHE_TTL_MS = 60 * 60 * 1000;      // 1 hour for a resolved name
const NAME_CACHE_NEG_TTL_MS = 5 * 60 * 1000;   // 5 min for a failed lookup
const NAME_CACHE_LIMIT = 5000;

async function getInstagramSenderName(senderId) {
  const cached = nameCache.get(senderId);
  if (cached && cached.expires > Date.now()) return cached.value;

  if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
    console.error('INSTAGRAM_ACCESS_TOKEN not set - cannot look up sender name');
    return null;
  }

  let resolved = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `https://graph.instagram.com/v26.0/${senderId}?fields=name,username&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`,
        { method: 'GET' },
        8000
      );

      const data = await response.json();

      if (response.ok) {
        // Prefer their display name; fall back to username if name isn't set.
        resolved = data.name || data.username || null;
        break;
      }

      console.error(`Instagram profile lookup failed (attempt ${attempt}):`, JSON.stringify(data));
      // 4xx (bad token, unknown user, permissions) won't fix itself on a
      // retry - only a 429/5xx is worth trying again.
      if (response.status < 500 && response.status !== 429) break;
    } catch (err) {
      console.error(`Instagram profile lookup threw (attempt ${attempt}):`, err.message);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
  }

  nameCache.set(senderId, {
    value: resolved,
    expires: Date.now() + (resolved ? NAME_CACHE_TTL_MS : NAME_CACHE_NEG_TTL_MS)
  });
  if (nameCache.size > NAME_CACHE_LIMIT) {
    nameCache.delete(nameCache.keys().next().value);
  }
  return resolved;
}

// Meta delivers webhooks "at least once" - the same event can arrive
// several times (retries, or just Meta being Meta). We dedupe on the
// message id (mid) so a redelivery doesn't create a duplicate lead /
// Gemini call / email.
//
// Two layers:
//   1. An in-memory set - fast, but resets on restart/redeploy (which on
//      Render's free tier happens every time the service spins down).
//   2. A check against Supabase (leads_v2.ig_mid) - survives restarts and
//      works across instances. Enabled automatically at boot IF that
//      column exists; otherwise we log a warning and rely on layer 1 only.
//
// For true idempotency under a burst of identical redeliveries, add a
// UNIQUE index on leads_v2.ig_mid - saveLead() turns the resulting 409
// into a silent skip.
const seenMessageIds = new Set();
const SEEN_MESSAGE_LIMIT = 5000;
let persistentDedupeEnabled = false;

function rememberMid(mid) {
  if (!mid) return;
  seenMessageIds.add(mid);
  if (seenMessageIds.size > SEEN_MESSAGE_LIMIT) {
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }
}

async function isDuplicateMid(mid) {
  if (!mid) return false; // can't dedupe without an id - let it through
  if (seenMessageIds.has(mid)) return true;

  if (persistentDedupeEnabled) {
    try {
      const response = await fetchWithTimeout(
        `${process.env.SUPABASE_URL}/rest/v1/leads_v2?ig_mid=eq.${encodeURIComponent(mid)}&select=id&limit=1`,
        { headers: supabaseHeaders() },
        8000
      );
      if (response.ok) {
        const rows = await response.json();
        if (Array.isArray(rows) && rows.length > 0) {
          rememberMid(mid);
          return true;
        }
      }
    } catch (err) {
      console.error('Persistent dedupe check failed - relying on in-memory only:', err.message);
    }
  }

  return false;
}

// Detect once, at boot, whether leads_v2 has the ig_mid column so we know
// whether persistent dedupe is available (and whether saveLead should
// include ig_mid in inserts at all).
async function detectPersistentDedupe() {
  try {
    const response = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/leads_v2?select=ig_mid&limit=1`,
      { headers: supabaseHeaders() },
      8000
    );
    persistentDedupeEnabled = response.ok;
    if (response.ok) {
      console.log('Persistent dedupe ENABLED (leads_v2.ig_mid present)');
    } else {
      console.warn('leads_v2.ig_mid not found - dedupe is in-memory only. To make it survive restarts:\n  alter table leads_v2 add column ig_mid text;\n  create unique index leads_v2_ig_mid_key on leads_v2 (ig_mid);');
    }
  } catch (err) {
    console.warn('Could not probe leads_v2.ig_mid - dedupe is in-memory only:', err.message);
  }
}

// Pull the inbound messages out of an Instagram webhook payload. A single
// POST can carry multiple entries, each with multiple messaging events.
// We skip:
//   - message.is_echo  -> a message YOUR account sent (e.g. your reply)
//   - no message       -> reactions, read receipts, postbacks (logged, not dropped silently)
// Non-text messages (voice notes, images, shares) ARE kept - we can't
// score their content, but "someone with no name sent you a voice note
// about pricing" is still a lead you need to see.
function extractInstagramMessages(body) {
  const messages = [];

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const msg = event.message;

      if (!msg) {
        const kind = event.reaction ? 'reaction'
          : event.read ? 'read-receipt'
          : event.postback ? 'postback'
          : 'other';
        console.log('Instagram non-message event ignored:', kind);
        continue;
      }
      if (msg.is_echo) continue;

      const senderId = event.sender && event.sender.id;
      if (!senderId) continue;

      let text = msg.text;
      if (!text) {
        const kinds = (msg.attachments || []).map(a => a.type).filter(Boolean).join(', ');
        text = `[Instagram ${kinds || 'non-text'} message with no caption - open the DM to see it]`;
        console.log('Instagram non-text message from', senderId, '- attachment types:', kinds || 'unknown');
      }

      messages.push({ senderId, mid: msg.mid, text });
    }
  }

  return messages;
}

// Handle one inbound Instagram message end to end. Runs in the background
// (after we've already 200'd Meta), so it's free to take its time.
async function handleInstagramLead({ senderId, mid, text }) {
  if (await isDuplicateMid(mid)) {
    console.log('Skipping duplicate Instagram message:', mid);
    return;
  }

  const placeholderName = `Instagram user ${senderId}`;

  // Save the lead first with a placeholder name - the profile lookup can
  // take several seconds and we never want to lose a lead waiting on it.
  let leadId;
  try {
    leadId = await saveLead({
      name: placeholderName,
      message: text,
      email: null,
      platform: 'Instagram',
      igMid: mid
    });
  } catch (err) {
    if (err.duplicate) {
      console.log('Duplicate Instagram message (unique constraint) - skipping:', mid);
      rememberMid(mid);
      return;
    }
    console.error('Failed to save Instagram lead from', senderId, '-', err.message);
    return;
  }
  rememberMid(mid);

  // Resolve their real name. If it works, backfill it onto every row from
  // this sender that's still showing the placeholder - that repairs any
  // earlier message whose lookup had failed, so a name failure is never
  // permanent as long as they message again.
  let name = placeholderName;
  const realName = await getInstagramSenderName(senderId);
  if (realName) {
    name = realName;
    try {
      await patchLeadsWhere(`name=eq.${encodeURIComponent(placeholderName)}`, { name: realName });
      console.log('Backfilled name for sender', senderId, '->', realName);
    } catch (err) {
      console.error('Failed to backfill name for lead', leadId, '-', err.message);
    }
  } else {
    console.warn('No name for lead', leadId, '- left as placeholder, will retry on their next message');
  }

  await processLeadInBackground(leadId, name, text, null, 'Instagram');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Meta calls this with a GET request to verify you control this URL,
// before it will send any real webhook events (POST requests) to it.
app.get('/webhook', function (req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    console.log('Webhook verification failed - token mismatch or wrong mode');
    res.sendStatus(403);
  }
});

app.post('/webhook', async function (req, res) {
  console.log('New message received:', JSON.stringify(req.body));

  // Basic shared-secret check so random people can't POST to this endpoint
  // and trigger real Gemini calls (which cost money) and emails to you.
  // Set WEBHOOK_SECRET on Render, and send the same value as this header
  // from whatever is calling this webhook.
  //
  // Note: real Instagram webhooks won't send this header - Meta signs its
  // requests with X-Hub-Signature-256 instead, verified separately below.
  const hasSecret = !!process.env.WEBHOOK_SECRET;
  const secretOk = req.headers['x-webhook-secret'] === process.env.WEBHOOK_SECRET;

  // ----- Real Instagram webhook payload -----
  if (req.body && req.body.object === 'instagram' && Array.isArray(req.body.entry)) {
    // Verify this actually came from Meta before doing anything with it.
    // Without this, anyone who discovers this URL could POST a fake
    // Instagram-shaped payload and it would be processed as a real lead.
    if (!isValidMetaSignature(req)) {
      console.error('Rejected Instagram payload - invalid or missing X-Hub-Signature-256');
      return res.sendStatus(401);
    }

    // ALWAYS ack Meta with a 200, immediately. A non-2xx (or a slow
    // response) just makes Meta redeliver the same event again and again.
    // Events we can't act on are filtered out silently below.
    res.sendStatus(200);

    const messages = extractInstagramMessages(req.body);
    console.log(`Instagram payload: ${messages.length} inbound message(s)`);

    // Fire and forget - the response is already sent.
    for (const msg of messages) {
      handleInstagramLead(msg).catch(function (err) {
        console.error('handleInstagramLead crashed for', msg.senderId, '-', err.message);
      });
    }
    return;
  }

  // ----- Flat shape: curl tests / other simple JSON sources -----
  // These callers ARE waiting on the response, so they get a real status
  // and we do enforce the shared secret.
  if (hasSecret && !secretOk) {
    console.error('Rejected request - missing or wrong x-webhook-secret header');
    return res.sendStatus(401);
  }

  const name = req.body.name;
  const message = req.body.message;
  const email = req.body.email || null;
  const platform = req.body.platform || 'Unknown';

  if (!name || !message) {
    console.error('Rejected request - missing required fields (name/message)');
    return res.status(400).send('Missing required fields: name and message');
  }

  // Step 1: Save to Supabase. This is the ONLY thing the sender waits on.
  let leadId;
  try {
    leadId = await saveLead({ name, message, email, platform });
  } catch (err) {
    console.error(err.message);
    return res.status(err.statusCode || 500).send('Failed to save lead');
  }

  // Respond immediately - the lead is safely saved, so whoever/whatever
  // sent this webhook doesn't need to wait on Gemini or Resend, which can
  // take several seconds (especially with retries). This also protects
  // against webhook providers that time out and re-send if you're slow.
  res.status(200).send('OK');

  // Everything below runs in the background, AFTER the response above has
  // already gone out. Nothing here can affect what the sender sees.
  processLeadInBackground(leadId, name, message, email, platform).catch(function (err) {
    console.error('processLeadInBackground crashed for lead', leadId, '-', err.message);
  });
});

async function processLeadInBackground(leadId, name, message, email, platform) {
  let scoreText = null;

  // Step 2: Score with Gemini (with retry - Gemini occasionally returns a
  // temporary 503 "high demand" error, which usually clears within seconds)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const geminiResponse = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': process.env.GEMINI_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Score this lead 1-10 on buying intent. Name: ${name}. Platform: ${platform}. Message: ${message}`
              }]
            }]
          })
        },
        10000 // 10s timeout per attempt
      );

      const geminiData = await geminiResponse.json();

      if (!geminiResponse.ok || !geminiData.candidates || !geminiData.candidates[0]) {
        console.error(`Gemini API error (attempt ${attempt}):`, JSON.stringify(geminiData));
        // 503 = temporary overload on Google's side, worth retrying.
        // Anything else (bad key, invalid model, etc.) won't fix itself.
        if (geminiData?.error?.code === 503 && attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 1000)); // wait 1s, then 2s
          continue;
        }
        break;
      }

      scoreText = geminiData.candidates[0].content.parts[0].text;
      console.log('Gemini score:', scoreText);
      break;
    } catch (err) {
      console.error(`Gemini call threw (attempt ${attempt}):`, err.message);
      // A timeout/abort is just as retryable as a 503 - the request never
      // even got a response back, so there's no reason to assume it'll
      // fail the same way again. Bad-key/invalid-request errors show up
      // in the response body above, not as a thrown exception, so it's
      // safe to always retry here.
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1000)); // wait 1s, then 2s
        continue;
      }
      break;
    }
  }

  try {
    // Step 3: Save the score back to Supabase, only if we got one.
    // If scoring failed we still email you - the score is a nice-to-have,
    // the lead notification is the point.
    if (scoreText === null) {
      console.error('No Gemini score for lead', leadId, '- emailing anyway without a score');
    } else {
      await updateLead(leadId, { ai_score: scoreText });
      console.log('Score saved back to Supabase for lead:', leadId);
    }

    // Step 4: Email yourself the result (via Resend's HTTP API)
    const emailResponse = await fetchWithTimeout(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: process.env.MAIL_TO,
          subject: `New lead scored: ${name} (${platform})`,
          text: `${name} just got scored.\n\nPlatform: ${platform}\nEmail: ${email || 'not provided'}\nMessage: ${message}\n\nAI Score: ${scoreText === null ? 'unavailable (Gemini scoring failed)' : scoreText}`
        })
      },
      10000
    );

    const emailResult = await emailResponse.json();
    if (!emailResponse.ok) {
      console.error('Resend API error for lead', leadId, '-', JSON.stringify(emailResult));
    } else {
      console.log('Email sent for lead:', leadId, '- Resend id:', emailResult.id);
    }
  } catch (err) {
    // Scoring or emailing failed, but the lead itself is already saved,
    // so we just log the problem - there's no request left to respond to.
    console.error('Post-save processing failed for lead', leadId, '-', err.message);
  }
}

app.listen(3000, function () {
  console.log('WebHook receiver running on http://localhost:3000');
  detectPersistentDedupe();
});