require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const app = express();

// Email is sent through Resend's HTTP API (https://api.resend.com, port 443)
// instead of SMTP. Render blocks outbound SMTP ports (25/465/587), so
// nodemailer/Gmail could never actually connect from here.
//   RESEND_API_KEY - from the Resend dashboard (starts with "re_")
//   MAIL_TO        - fallback recipient for the flat/curl-test path only.
//                     Real Instagram leads use the owning tenant's
//                     notification_email instead (see tenants table).
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
// sent, before JSON.parse touches them.
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

// Meta signs every real webhook POST with an X-Hub-Signature-256 header.
// Verifying this confirms a request claiming to be "from Instagram"
// actually came from Meta, not from anyone who found your URL.
// Requires META_APP_SECRET on Render (the "Instagram app secret" shown
// on the API setup page in the Meta dashboard).
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
async function saveLead({ name, message, email, platform, igMid, tenantId }) {
  const row = { name, message, email, platform };
  if (persistentDedupeEnabled && igMid) row.ig_mid = igMid;
  if (tenantId != null) row.tenant_id = tenantId;

  let response;
  try {
    response = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/leads_v2`,
      {
        method: 'POST',
        headers: supabaseHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify(row)
      },
      8000
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

async function updateLead(leadId, fields) {
  return patchLeadsWhere(`id=eq.${leadId}`, fields);
}

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
// Tenants (multi-business support)
// ---------------------------------------------------------------------------

// Which business a message belongs to is determined by `recipient.id` on
// the webhook event - that's the Instagram-scoped ID of the account that
// RECEIVED the message, i.e. your customer's connected account, not the
// sender. We look that ID up in the tenants table to get their own
// access token and notification email, so every customer's leads use
// their own credentials, not yours.
//
// Cached for 5 minutes so a burst of messages doesn't hit Supabase once
// per message - tenant config changes rarely, so a short staleness
// window is a fine tradeoff for far fewer queries.
const tenantCache = new Map(); // instagramAccountId -> { value: tenant|null, expires }
const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;

async function getTenantByInstagramAccountId(instagramAccountId) {
  const cached = tenantCache.get(instagramAccountId);
  if (cached && cached.expires > Date.now()) return cached.value;

  let tenant = null;
  try {
    const response = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/tenants?instagram_account_id=eq.${encodeURIComponent(instagramAccountId)}&active=eq.true&select=*&limit=1`,
      { headers: supabaseHeaders() },
      8000
    );
    if (response.ok) {
      const rows = await response.json();
      tenant = rows[0] || null;
    } else {
      console.error('Tenant lookup failed:', response.status);
    }
  } catch (err) {
    console.error('Tenant lookup threw:', err.message);
  }

  tenantCache.set(instagramAccountId, { value: tenant, expires: Date.now() + TENANT_CACHE_TTL_MS });
  return tenant;
}

// ---------------------------------------------------------------------------
// Instagram helpers
// ---------------------------------------------------------------------------

// Instagram's webhook only gives you the sender's numeric ID, not their
// name. This looks up their real name/username via the Graph API, using
// the OWNING TENANT's access token (not a global one - each business's
// token only works for messages sent to THEIR account).
//
// Results are cached in memory: successes for an hour, failures for a
// few minutes (so a transient error gets retried soon, but a broken
// token doesn't get hammered on every incoming message).
const nameCache = new Map(); // `${tenantId}:${senderId}` -> { value, expires }
const NAME_CACHE_TTL_MS = 60 * 60 * 1000;
const NAME_CACHE_NEG_TTL_MS = 5 * 60 * 1000;
const NAME_CACHE_LIMIT = 5000;

// Sends an automated text reply to whoever just messaged the tenant's
// Instagram account. Fire-and-forget from the caller's point of view -
// a failed reply is logged but never blocks saving the lead or scoring
// it, since the lead itself matters more than the acknowledgment.
//
// igId is the TENANT's own Instagram account ID (the business account
// sending the reply) - the endpoint is /<IG_ID>/messages, and the
// recipient is the person who messaged in (senderId).
async function sendInstagramAutoReply(igId, senderId, text, accessToken) {
  if (!accessToken) {
    console.error('No access token available - cannot send auto-reply to', senderId);
    return;
  }

  try {
    const response = await fetchWithTimeout(
      `https://graph.instagram.com/v26.0/${igId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          recipient: { id: senderId },
          message: { text }
        })
      },
      8000
    );

    const data = await response.json();
    if (!response.ok) {
      console.error('Auto-reply failed for', senderId, '-', JSON.stringify(data));
    } else {
      console.log('Auto-reply sent to', senderId, '- message id:', data.message_id);
    }
  } catch (err) {
    console.error('Auto-reply threw for', senderId, '-', err.message);
  }
}

async function getInstagramSenderName(senderId, accessToken, tenantId) {
  const cacheKey = `${tenantId}:${senderId}`;
  const cached = nameCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  if (!accessToken) {
    console.error('No access token available for tenant', tenantId, '- cannot look up sender name');
    return null;
  }

  let resolved = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `https://graph.instagram.com/v26.0/${senderId}?fields=name,username&access_token=${accessToken}`,
        { method: 'GET' },
        8000
      );

      const data = await response.json();

      if (response.ok) {
        resolved = data.name || data.username || null;
        break;
      }

      console.error(`Instagram profile lookup failed (attempt ${attempt}):`, JSON.stringify(data));
      if (response.status < 500 && response.status !== 429) break;
    } catch (err) {
      console.error(`Instagram profile lookup threw (attempt ${attempt}):`, err.message);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
  }

  nameCache.set(cacheKey, {
    value: resolved,
    expires: Date.now() + (resolved ? NAME_CACHE_TTL_MS : NAME_CACHE_NEG_TTL_MS)
  });
  if (nameCache.size > NAME_CACHE_LIMIT) {
    nameCache.delete(nameCache.keys().next().value);
  }
  return resolved;
}

// Meta delivers webhooks "at least once" - dedupe on message id (mid) so
// a redelivery doesn't create a duplicate lead / Gemini call / email.
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
  if (!mid) return false;
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
      console.warn('leads_v2.ig_mid not found - dedupe is in-memory only.');
    }
  } catch (err) {
    console.warn('Could not probe leads_v2.ig_mid - dedupe is in-memory only:', err.message);
  }
}

// Pull the inbound messages out of an Instagram webhook payload. A single
// POST can carry multiple entries, each with multiple messaging events.
// Each message also carries `recipientId` - the tenant's account ID -
// so the caller knows which business it belongs to.
function extractInstagramMessages(body) {
  const messages = [];

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const msg = event.message;
      const recipientId = event.recipient && event.recipient.id;

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
      if (!senderId || !recipientId) continue;

      let text = msg.text;
      if (!text) {
        const kinds = (msg.attachments || []).map(a => a.type).filter(Boolean).join(', ');
        text = `[Instagram ${kinds || 'non-text'} message with no caption - open the DM to see it]`;
        console.log('Instagram non-text message from', senderId, '- attachment types:', kinds || 'unknown');
      }

      messages.push({ senderId, recipientId, mid: msg.mid, text });
    }
  }

  return messages;
}

// Handle one inbound Instagram message end to end. Runs in the background
// (after we've already 200'd Meta), so it's free to take its time.
async function handleInstagramLead({ senderId, recipientId, mid, text }) {
  if (await isDuplicateMid(mid)) {
    console.log('Skipping duplicate Instagram message:', mid);
    return;
  }

  // Figure out which tenant (business) this message belongs to, using
  // whichever account RECEIVED it. Every downstream step - the sender
  // name lookup, the notification email - uses THIS tenant's own
  // credentials, never a global one.
  const tenant = await getTenantByInstagramAccountId(recipientId);
  if (!tenant) {
    console.error('No active tenant found for Instagram account', recipientId, '- message dropped. Add a row to the tenants table to fix this.');
    return;
  }

  const placeholderName = `Instagram user ${senderId}`;

  let leadId;
  try {
    leadId = await saveLead({
      name: placeholderName,
      message: text,
      email: null,
      platform: 'Instagram',
      igMid: mid,
      tenantId: tenant.id
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

  // Ask Gemini to both assess this lead AND draft a real, specific reply
  // grounded in the tenant's knowledge_base (products/services/pricing).
  // This costs a few seconds of delay before the customer sees anything -
  // worth it for a reply that actually engages with what they asked,
  // instead of an instant but generic "thanks for reaching out". If this
  // fails entirely, fall back to the tenant's static default, then a
  // generic line, so a Gemini outage never leaves someone unanswered.
  const assessment = await assessLead({
    name: placeholderName,
    message: text,
    platform: 'Instagram',
    businessName: tenant.business_name || tenant.name || null,
    businessContext: tenant.business_description || null,
    knowledgeBase: tenant.knowledge_base || null
  });

  const replyText = (assessment && assessment.customer_reply) ||
    tenant.auto_reply_message ||
    "Thanks for reaching out! We've received your message and will get back to you shortly.";
  sendInstagramAutoReply(tenant.instagram_account_id, senderId, replyText, tenant.instagram_access_token);

  let name = placeholderName;
  const realName = await getInstagramSenderName(senderId, tenant.instagram_access_token, tenant.id);
  if (realName) {
    name = realName;
    try {
      await patchLeadsWhere(
        `name=eq.${encodeURIComponent(placeholderName)}&tenant_id=eq.${tenant.id}`,
        { name: realName }
      );
      console.log('Backfilled name for sender', senderId, '(tenant', tenant.id, ') ->', realName);
    } catch (err) {
      console.error('Failed to backfill name for lead', leadId, '-', err.message);
    }
  } else {
    console.warn('No name for lead', leadId, '- left as placeholder, will retry on their next message');
  }

  await processLeadInBackground(
    leadId, name, text, null, 'Instagram', tenant.notification_email,
    { name: tenant.business_name || tenant.name || null, context: tenant.business_description || null },
    assessment
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

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

  const hasSecret = !!process.env.WEBHOOK_SECRET;
  const secretOk = req.headers['x-webhook-secret'] === process.env.WEBHOOK_SECRET;

  // ----- Real Instagram webhook payload -----
  if (req.body && req.body.object === 'instagram' && Array.isArray(req.body.entry)) {
    if (!isValidMetaSignature(req)) {
      console.error('Rejected Instagram payload - invalid or missing X-Hub-Signature-256');
      return res.sendStatus(401);
    }

    res.sendStatus(200);

    const messages = extractInstagramMessages(req.body);
    console.log(`Instagram payload: ${messages.length} inbound message(s)`);

    for (const msg of messages) {
      handleInstagramLead(msg).catch(function (err) {
        console.error('handleInstagramLead crashed for', msg.senderId, '-', err.message);
      });
    }
    return;
  }

  // ----- Flat shape: curl tests / other simple JSON sources -----
  // Uses MAIL_TO directly (no tenant lookup) - this path is for your own
  // testing, not real customer traffic.
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

  let leadId;
  try {
    leadId = await saveLead({ name, message, email, platform });
  } catch (err) {
    console.error(err.message);
    return res.status(err.statusCode || 500).send('Failed to save lead');
  }

  res.status(200).send('OK');

  processLeadInBackground(leadId, name, message, email, platform, process.env.MAIL_TO).catch(function (err) {
    console.error('processLeadInBackground crashed for lead', leadId, '-', err.message);
  });
});

// Ask Gemini to assess the lead AND draft the actual reply we send back to
// the customer on Instagram - one call does both jobs, grounded in the
// tenant's own knowledge_base (products/services/pricing/policies) so the
// reply can be specific instead of "thanks for reaching out". Returns:
//   { score, category, reasoning, recommended_action, customer_reply, raw }
// `score` is 1-10, or null if we couldn't get a usable answer. `raw` is
// the model's original text, kept as a fallback for the internal email.
//
// Guardrail: the prompt explicitly forbids inventing prices/products that
// aren't in the knowledge base, because customer_reply gets sent to a real
// person with NO human review in between. If the knowledge base is empty,
// the model is told to be honest about not having details yet rather than
// making something up.
async function assessLead({ name, message, platform, businessName, businessContext, knowledgeBase }) {
  const persona = businessName
    ? `You are a real, knowledgeable staff member replying to DMs for "${businessName}".` +
      (businessContext ? ` About the business: ${businessContext}` : '')
    : 'You are a sales assistant helping a small business owner triage inbound DMs.';

  const kb = (knowledgeBase || '').trim();

  const prompt = `${persona}

Here is everything you're allowed to know about the business's products, services, pricing, and policies. Treat it as the ONLY source of truth - never invent a price, product, or policy that isn't in here:
"""
${kb || '(no product/pricing info has been provided yet)'}
"""

A person named "${name}" sent this message via ${platform}:
"""
${message}
"""

Do two things:

1. Assess this as a sales lead for the internal team (they will NOT see your reply to the customer, only this assessment).
2. Draft the actual reply to send back to the customer right now, as a real conversation - not a form letter. Address what they specifically asked. If the knowledge base above answers their question (a price, a product detail, availability, a policy), state it directly and confidently. If it does NOT contain the answer, say so honestly and let them know a team member will follow up with the specifics - do NOT guess or make up numbers. Keep it warm, 2-5 sentences.

Reply with ONLY a JSON object - no markdown, no code fences - in exactly this shape:
{
  "score": <integer 1-10 for buying intent; 1 = spam/bot/irrelevant, 10 = ready to buy now>,
  "category": "<one of: hot, warm, cold, spam>",
  "reasoning": "<1-2 sentences for the internal team, specific to THIS message>",
  "recommended_action": "<the single most useful next step for the owner, concrete and short>",
  "customer_reply": "<the message to send back to the customer, per the rules above>"
}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': process.env.GEMINI_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
          })
        },
        10000
      );

      const data = await response.json();

      if (!response.ok || !data.candidates || !data.candidates[0]) {
        console.error(`Gemini API error (attempt ${attempt}):`, JSON.stringify(data));
        if (data?.error?.code === 503 && attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 1000));
          continue;
        }
        break;
      }

      const raw = data.candidates[0].content.parts[0].text;
      console.log('Gemini assessment:', raw);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        console.error('Gemini returned non-JSON - using raw text:', e.message);
        return { score: null, category: null, reasoning: null, recommended_action: null, customer_reply: null, raw };
      }

      const n = Number(parsed.score);
      return {
        score: Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null,
        category: parsed.category || null,
        reasoning: parsed.reasoning || null,
        recommended_action: parsed.recommended_action || null,
        customer_reply: parsed.customer_reply || null,
        raw
      };
    } catch (err) {
      console.error(`Gemini call threw (attempt ${attempt}):`, err.message);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1000));
        continue;
      }
      break;
    }
  }

  return null; // total failure - lead still gets emailed, just without a score
}

const CATEGORY_EMOJI = { hot: '🔥', warm: '🌤️', cold: '❄️', spam: '🚫' };

function buildLeadEmail({ name, message, email, platform, assessment }) {
  const lines = [];

  if (assessment && assessment.score != null) {
    const cat = assessment.category ? assessment.category.toUpperCase() : 'UNCATEGORIZED';
    lines.push(`SCORE: ${assessment.score}/10   (${cat})`);
    lines.push('');
    if (assessment.reasoning) lines.push(`Why:  ${assessment.reasoning}`);
    if (assessment.recommended_action) lines.push(`Next: ${assessment.recommended_action}`);
    if (assessment.customer_reply) {
      lines.push('');
      lines.push('What we auto-replied to them on Instagram:');
      lines.push(`  ${assessment.customer_reply}`);
    }
  } else if (assessment && assessment.raw) {
    lines.push(assessment.raw);
  } else {
    lines.push('AI scoring failed - review this lead manually.');
  }

  lines.push('');
  lines.push('----------------------------------------');
  lines.push(`From:     ${name}`);
  lines.push(`Platform: ${platform}`);
  lines.push(`Email:    ${email || 'not provided'}`);
  lines.push('');
  lines.push('Their message:');
  lines.push(message);

  return lines.join('\n');
}

// `precomputedAssessment` lets a caller that already ran assessLead() (the
// Instagram flow does, so it can send the customer_reply immediately)
// skip paying for a second Gemini call here.
async function processLeadInBackground(leadId, name, message, email, platform, notificationEmail, business, precomputedAssessment) {
  const assessment = precomputedAssessment !== undefined
    ? precomputedAssessment
    : await assessLead({
        name,
        message,
        platform,
        businessName: business && business.name,
        businessContext: business && business.context,
        knowledgeBase: business && business.knowledgeBase
      });

  try {
    if (!assessment) {
      console.error('No Gemini assessment for lead', leadId, '- emailing anyway without a score');
    } else if (assessment.score != null) {
      await updateLead(leadId, { ai_score: String(assessment.score) });
      console.log('Score saved back to Supabase for lead:', leadId, '- score', assessment.score);
    }

    // While testing (no verified domain), Resend's shared sender only
    // delivers to your own Resend-account address. Setting
    // NOTIFY_OVERRIDE_EMAIL routes EVERY lead email there instead of the
    // tenant's real address, so you still see all leads during testing.
    // The intended tenant recipient is shown in the subject and body.
    // Remove this env var once you've verified a domain.
    const override = process.env.NOTIFY_OVERRIDE_EMAIL || null;
    const intendedRecipient = notificationEmail;
    const actualRecipient = override || notificationEmail;

    if (!actualRecipient) {
      console.error('No recipient for lead', leadId, '- skipping email. Set NOTIFY_OVERRIDE_EMAIL / MAIL_TO / the tenant\'s notification_email.');
      return;
    }

    const businessLabel = business && business.name ? `[${business.name}] ` : '';
    const emoji = assessment && assessment.category ? (CATEGORY_EMOJI[assessment.category] || '') : '';
    const scoreTag = assessment && assessment.score != null ? ` (${assessment.score}/10)` : '';
    const subject = `${businessLabel}${emoji ? emoji + ' ' : ''}New ${platform} lead: ${name}${scoreTag}`.trim();

    let text = buildLeadEmail({ name, message, email, platform, assessment });
    if (override && intendedRecipient && override !== intendedRecipient) {
      text = `(Testing mode - this would normally go to ${intendedRecipient})\n\n${text}`;
    }

    const emailResponse = await fetchWithTimeout(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: MAIL_FROM, to: actualRecipient, subject, text })
      },
      10000
    );

    const emailResult = await emailResponse.json();
    if (!emailResponse.ok) {
      console.error('Resend API error for lead', leadId, '-', JSON.stringify(emailResult));
    } else {
      console.log('Email accepted by Resend for lead:', leadId, '- id:', emailResult.id, '- to:', actualRecipient);
      // The shared onboarding@resend.dev sender is accepted (200) but only
      // actually delivered to the Resend account owner's own address.
      if (MAIL_FROM === 'onboarding@resend.dev' && !override) {
        console.warn('NOTE: MAIL_FROM is onboarding@resend.dev - Resend will only DELIVER this if', actualRecipient, 'is your Resend signup email. Set NOTIFY_OVERRIDE_EMAIL for testing, or verify a domain for production.');
      }
    }
  } catch (err) {
    console.error('Post-save processing failed for lead', leadId, '-', err.message);
  }
}

app.listen(3000, function () {
  console.log('WebHook receiver running on http://localhost:3000');
  detectPersistentDedupe();
});