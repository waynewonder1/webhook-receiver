require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const app = express();

const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';

// Answered before the request logger so a monitor pinging this every few
// minutes (to stop the free Render instance from sleeping) doesn't fill the logs.
app.get('/health', function (req, res) {
  res.status(200).json({ ok: true, uptime: Math.round(process.uptime()), commit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7) });
});

app.use(function (req, res, next) {
  console.log('Incoming request:', req.method, req.path);
  next();
});

app.use(express.json({
  verify: function (req, res, buf) {
    req.rawBody = buf;
  }
}));

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

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

function supabaseHeaders(extra) {
  return {
    'apikey': process.env.SUPABASE_KEY,
    'authorization': `Bearer ${process.env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}
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

const tenantCache = new Map(); 
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

const nameCache = new Map();
const NAME_CACHE_TTL_MS = 60 * 60 * 1000;
const NAME_CACHE_NEG_TTL_MS = 5 * 60 * 1000;
const NAME_CACHE_LIMIT = 5000;

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

function forgetMid(mid) {
  if (mid) seenMessageIds.delete(mid);
}

async function isDuplicateMid(mid) {
  if (!mid) return false;
  if (seenMessageIds.has(mid)) return true;

  // Claim the message now, before any await. Meta often delivers the same
  // event twice at almost the same moment (especially when a sleeping free
  // instance wakes up); without this, both copies pass the check and the
  // customer gets two replies and two leads.
  rememberMid(mid);

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
// Recent chat with this customer, read from Instagram itself. It includes
// our earlier auto-replies AND anything the business owner typed by hand, so
// the assistant can follow the conversation instead of answering every
// message as if it were the first. Returns oldest-first, or [] on any
// problem (the assistant then just behaves as it did before).
const HISTORY_MESSAGES = 10;
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function getConversationHistory(igId, senderId, accessToken, currentText) {
  if (!accessToken) return [];
  try {
    const url = `https://graph.instagram.com/v26.0/${igId}/conversations?platform=instagram&user_id=${encodeURIComponent(senderId)}` +
      `&fields=messages.limit(${HISTORY_MESSAGES + 3}){created_time,from,message}`;
    const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, 6000);
    const data = await response.json();
    if (!response.ok) {
      console.error('Conversation history lookup failed:', JSON.stringify(data));
      return [];
    }

    const raw = (data.data && data.data[0] && data.data[0].messages && data.data[0].messages.data) || [];
    let msgs = raw.filter((m) => m.message && Date.now() - Date.parse(m.created_time) < HISTORY_MAX_AGE_MS);

    // Newest first. The message we're answering right now may already be in
    // the list - drop it so it isn't shown twice.
    if (msgs[0] && msgs[0].from && msgs[0].from.id === senderId && msgs[0].message === currentText) {
      msgs = msgs.slice(1);
    }

    return msgs
      .slice(0, HISTORY_MESSAGES)
      .reverse()
      .map((m) => ({ who: m.from && m.from.id === senderId ? 'Customer' : 'Us', text: String(m.message).slice(0, 500) }));
  } catch (err) {
    console.error('Conversation history lookup threw:', err.message);
    return [];
  }
}

// If Gemini is slow, the customer gets a short holding message after
// HOLD_AFTER_MS instead of silence (the real answer follows when it is ready).
// If every model fails, we try again later and send the answer as a follow-up.
const HOLD_AFTER_MS = 20 * 1000;
const LATE_ANSWER_DELAYS_MS = [60 * 1000, 3 * 60 * 1000, 10 * 60 * 1000];
const MAX_PENDING_LATE_ANSWERS = 50;
const DEFAULT_HOLDING_REPLY = "Thanks for reaching out! We've received your message and will get back to you shortly.";
let pendingLateAnswers = 0;

const normalizeText = (t) => String(t || '').replace(/\s+/g, ' ').trim();

async function answerLater({ tenant, senderId, text, holdingText, leadId, name, business }) {
  if (pendingLateAnswers >= MAX_PENDING_LATE_ANSWERS) return;
  pendingLateAnswers++;
  try {
    for (let i = 0; i < LATE_ANSWER_DELAYS_MS.length; i++) {
      await new Promise((r) => setTimeout(r, LATE_ANSWER_DELAYS_MS[i]));

      // Only answer if nothing has happened in the chat since our holding
      // message: no reply from the owner, and no newer message from the
      // customer (a newer message gets its own answer that already covers this one).
      const history = await getConversationHistory(tenant.instagram_account_id, senderId, tenant.instagram_access_token, text);
      let earlier = history;
      if (history.length >= 2) {
        const last = history[history.length - 1];
        const prev = history[history.length - 2];
        const stillWaiting = last.who === 'Us' && normalizeText(last.text) === normalizeText(holdingText).slice(0, 500) &&
          prev.who === 'Customer' && normalizeText(prev.text) === normalizeText(text).slice(0, 500);
        if (!stillWaiting) {
          console.log('Late answer skipped for lead', leadId, '- the conversation has moved on');
          return;
        }
        earlier = history.slice(0, -2);
      }

      const assessment = await assessLead({
        history: earlier,
        name,
        message: text,
        platform: 'Instagram',
        businessName: business.name,
        businessContext: business.context,
        knowledgeBase: tenant.knowledge_base || null
      });

      if (assessment && assessment.customer_reply) {
        console.log(`Late answer ready for lead ${leadId} (retry ${i + 1}) - sending`);
        sendInstagramAutoReply(tenant.instagram_account_id, senderId, assessment.customer_reply, tenant.instagram_access_token);
        await processLeadInBackground(leadId, name, text, null, 'Instagram', tenant.notification_email, business, assessment);
        return;
      }
      console.error(`Late answer retry ${i + 1} failed for lead ${leadId}`);
    }
    console.error('Gave up answering lead', leadId, '- it needs a manual reply');
  } finally {
    pendingLateAnswers--;
  }
}

async function handleInstagramLead({ senderId, recipientId, mid, text }) {
  if (await isDuplicateMid(mid)) {
    console.log('Skipping duplicate Instagram message:', mid);
    return;
  }

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
    forgetMid(mid);
    return;
  }
  rememberMid(mid);

  const history = await getConversationHistory(tenant.instagram_account_id, senderId, tenant.instagram_access_token, text);

  const business = { name: tenant.business_name || tenant.name || null, context: tenant.business_description || null };
  const holdingText = tenant.auto_reply_message || DEFAULT_HOLDING_REPLY;

  let holdingSent = false;
  const holdTimer = setTimeout(() => {
    holdingSent = true;
    sendInstagramAutoReply(tenant.instagram_account_id, senderId, holdingText, tenant.instagram_access_token);
  }, HOLD_AFTER_MS);

  let assessment;
  try {
    assessment = await assessLead({
      history,
      name: placeholderName,
      message: text,
      platform: 'Instagram',
      businessName: business.name,
      businessContext: business.context,
      knowledgeBase: tenant.knowledge_base || null
    });
  } finally {
    clearTimeout(holdTimer);
  }

  const answered = !!(assessment && assessment.customer_reply);
  if (answered) {
    sendInstagramAutoReply(tenant.instagram_account_id, senderId, assessment.customer_reply, tenant.instagram_access_token);
  } else if (!holdingSent) {
    holdingSent = true;
    sendInstagramAutoReply(tenant.instagram_account_id, senderId, holdingText, tenant.instagram_access_token);
  }

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

  await processLeadInBackground(leadId, name, text, null, 'Instagram', tenant.notification_email, business, assessment);

  if (!answered) {
    answerLater({ tenant, senderId, text, holdingText, leadId, name, business }).catch(function (err) {
      console.error('answerLater crashed for lead', leadId, '-', err.message);
    });
  }
}


// Routes


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

// Models are tried in order, one per attempt, so if one is overloaded or
// slow the next attempt goes to a different one. Override with a
// comma-separated GEMINI_MODELS env var on Render when Google retires a
// model (older models start returning 404 "no longer available").
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite')
  .split(',').map((m) => m.trim()).filter(Boolean);
const GEMINI_ATTEMPT_TIMEOUT_MS = 30000;
// If a model has not answered after HEDGE_DELAY, the next model is started
// alongside it and whichever answers first wins. A model that fails outright
// is replaced immediately. Everything is abandoned after OVERALL_TIMEOUT.
const GEMINI_HEDGE_DELAY_MS = 8000;
const GEMINI_OVERALL_TIMEOUT_MS = 45000;

async function callGeminiModel(model, prompt, signal) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(GEMINI_ATTEMPT_TIMEOUT_MS)])
    }
  );
  const data = await response.json();
  if (!response.ok || !data.candidates || !data.candidates[0]) {
    throw new Error(JSON.stringify(data).slice(0, 200));
  }
  const raw = data.candidates[0].content.parts[0].text;
  return { model, raw, parsed: JSON.parse(raw) };
}

// Asks the models in order, starting the next one early when the current one
// is slow or fails. Resolves with the first valid answer, or null.
function askGemini(prompt) {
  return new Promise((resolve) => {
    const controllers = [];
    let started = 0;
    let failed = 0;
    let settled = false;
    let hedgeTimer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(overallTimer);
      controllers.forEach((c) => c.abort());
      resolve(value);
    };
    const overallTimer = setTimeout(() => {
      console.error('Gemini gave up after', GEMINI_OVERALL_TIMEOUT_MS, 'ms');
      finish(null);
    }, GEMINI_OVERALL_TIMEOUT_MS);

    const startNext = () => {
      clearTimeout(hedgeTimer);
      if (settled || started >= GEMINI_MODELS.length) return;
      const model = GEMINI_MODELS[started++];
      const controller = new AbortController();
      controllers.push(controller);

      callGeminiModel(model, prompt, controller.signal)
        .then(finish)
        .catch((err) => {
          if (settled) return;
          console.error(`Gemini attempt failed (${model}):`, err.message);
          failed++;
          if (failed >= GEMINI_MODELS.length) finish(null);
          else startNext();
        });

      if (started < GEMINI_MODELS.length) hedgeTimer = setTimeout(startNext, GEMINI_HEDGE_DELAY_MS);
    };

    startNext();
  });
}

async function assessLead({ name, message, platform, businessName, businessContext, knowledgeBase, history }) {
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

${history && history.length ? `Earlier in this same chat (oldest first - "Us" is the business, "Customer" is ${name}):
"""
${history.map((h) => `${h.who}: ${h.text}`).join('\n')}
"""

` : ''}${history && history.length ? 'The customer\'s LATEST message, which you are answering now' : `A person named "${name}" sent this message via ${platform}`}:
"""
${message}
"""

${history && history.length ? `This is a continuing conversation. Use the earlier messages for context (what they already asked, what we already told them). Do not repeat information we already gave, do not greet or re-introduce the business again, and answer the latest message directly. Judge buying intent from the whole conversation, not just the last line.

` : ''}Do two things:

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

  const result = await askGemini(prompt);
  if (!result) return null; // total failure - lead still gets emailed, just without a score

  console.log(`Gemini assessment (${result.model}):`, result.raw);
  const parsed = result.parsed;
  const n = Number(parsed.score);
  return {
    score: Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null,
    category: parsed.category || null,
    reasoning: parsed.reasoning || null,
    recommended_action: parsed.recommended_action || null,
    customer_reply: parsed.customer_reply || null,
    raw: result.raw
  };
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

// "Connect Instagram" - lets a client authorize their own account
//
// Flow: you send the client  /connect/instagram?key=<CONNECT_KEY>&label=<Business name>
// -> we redirect them to Instagram's approval screen -> they log in on their
// own device and tap Allow -> Instagram sends them to the callback below ->
// we swap the one-time code for a long-lived token, subscribe the account to
// webhooks, and save (or update) its row in the tenants table.
//
// Env vars: CONNECT_KEY (secret you put in the link), INSTAGRAM_APP_ID,
// META_APP_SECRET (already set), optional PUBLIC_BASE_URL.
const CONNECT_STATE_TTL_MS = 30 * 60 * 1000;
const INSTAGRAM_SCOPES = 'instagram_business_basic,instagram_business_manage_messages';

function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The state value proves the callback belongs to a link WE issued (blocks
// forged callbacks) and carries the business label through the redirect.
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readState(state) {
  if (typeof state !== 'string') return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', process.env.META_APP_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.t || Date.now() - payload.t > CONNECT_STATE_TTL_MS) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function connectPage(res, status, title, message) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.status(status).type('html').send(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    '<style>body{font-family:system-ui,sans-serif;background:#0a0d0d;color:#eef0ed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:440px}h1{font-size:28px;margin:0 0 12px}p{color:#9aa3a0;line-height:1.5}</style>' +
    `</head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`
  );
}

app.get('/connect/instagram', function (req, res) {
  if (!process.env.CONNECT_KEY || !process.env.INSTAGRAM_APP_ID || !process.env.META_APP_SECRET) {
    return connectPage(res, 503, 'Not set up yet', 'This connection link is not enabled on the server.');
  }
  if (!safeEqual(req.query.key || '', process.env.CONNECT_KEY)) {
    return connectPage(res, 403, 'Invalid link', 'This link is not valid. Please ask for a new one.');
  }

  const label = String(req.query.label || '').slice(0, 80) || null;
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: `${publicBaseUrl(req)}/connect/instagram/callback`,
    response_type: 'code',
    scope: INSTAGRAM_SCOPES,
    state: signState({ t: Date.now(), label })
  }).toString();

  res.redirect(url.toString());
});

app.get('/connect/instagram/callback', async function (req, res) {
  if (!process.env.INSTAGRAM_APP_ID || !process.env.META_APP_SECRET) {
    return connectPage(res, 503, 'Not set up yet', 'This connection link is not enabled on the server.');
  }

  const state = readState(req.query.state);
  if (!state) {
    return connectPage(res, 400, 'Link expired', 'This connection attempt expired or is invalid. Please ask for a new link.');
  }
  if (req.query.error || !req.query.code) {
    return connectPage(res, 200, 'Not connected', 'Permission was not granted, so nothing was connected. Open the link again if you want to retry.');
  }

  try {
    const redirectUri = `${publicBaseUrl(req)}/connect/instagram/callback`;

    // 1. One-time code -> short-lived token
    const shortRes = await fetchWithTimeout('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.INSTAGRAM_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: req.query.code
      }).toString()
    }, 10000);
    const shortData = await shortRes.json();
    const shortEntry = Array.isArray(shortData.data) ? shortData.data[0] : shortData;
    if (!shortRes.ok || !shortEntry || !shortEntry.access_token) {
      throw new Error('Code exchange failed: ' + JSON.stringify(shortData));
    }

    // 2. Short-lived -> long-lived token (about 60 days)
    const longRes = await fetchWithTimeout(
      'https://graph.instagram.com/access_token?' + new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: process.env.META_APP_SECRET,
        access_token: shortEntry.access_token
      }).toString(),
      {},
      10000
    );
    const longData = await longRes.json();
    if (!longRes.ok || !longData.access_token) {
      throw new Error('Long-lived token exchange failed: ' + JSON.stringify(longData));
    }
    const token = longData.access_token;

    // 3. Who connected? user_id here is the same ID the webhook sends. It is
    // read from /me as a STRING - the number in the token response is too
    // large for JavaScript to hold exactly.
    const meRes = await fetchWithTimeout('https://graph.instagram.com/v26.0/me?fields=user_id,username', {
      headers: { Authorization: `Bearer ${token}` }
    }, 8000);
    const me = await meRes.json();
    if (!meRes.ok || !me.user_id) throw new Error('Profile lookup failed: ' + JSON.stringify(me));
    const igId = String(me.user_id);
    const username = me.username || null;

    // 4. Subscribe the account to message webhooks (the dashboard's
    // "Webhook Subscription" toggle does the same thing).
    let subscribed = false;
    try {
      const subRes = await fetchWithTimeout(
        `https://graph.instagram.com/v26.0/${igId}/subscribed_apps?subscribed_fields=messages`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
        8000
      );
      const subData = await subRes.json();
      subscribed = subRes.ok && subData.success !== false;
      if (!subscribed) console.error('Webhook subscription failed for', igId, '-', JSON.stringify(subData));
    } catch (err) {
      console.error('Webhook subscription threw for', igId, '-', err.message);
    }

    // 5. Save: update the token if this account already has a tenant row,
    // otherwise create one (switched OFF until its knowledge base is filled in).
    const existingRes = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/tenants?instagram_account_id=eq.${encodeURIComponent(igId)}&select=id&limit=1`,
      { headers: supabaseHeaders() },
      8000
    );
    const existing = existingRes.ok ? await existingRes.json() : null;
    if (!Array.isArray(existing)) throw new Error('Tenant lookup failed');

    if (existing.length > 0) {
      await patchTenantToken(existing[0].id, token, longData.expires_in);
      console.log(`Connect: refreshed token for @${username} (${igId}), tenant ${existing[0].id}, webhooks subscribed: ${subscribed}`);
    } else {
      const insertRes = await fetchWithTimeout(`${process.env.SUPABASE_URL}/rest/v1/tenants`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify({
          business_name: state.label || (username ? `@${username}` : igId),
          instagram_account_id: igId,
          instagram_access_token: token,
          notification_email: process.env.MAIL_TO || null,
          active: false,
          ...tokenExpiryFields(longData.expires_in)
        })
      }, 8000);
      const inserted = await insertRes.json();
      if (!insertRes.ok) throw new Error('Tenant insert failed: ' + JSON.stringify(inserted));
      console.log(`Connect: created tenant ${inserted[0] && inserted[0].id} for @${username} (${igId}), inactive, webhooks subscribed: ${subscribed}`);
    }
    tenantCache.delete(igId);

    return connectPage(res, 200, 'Connected', `${username ? '@' + username : 'Your Instagram account'} is now connected. You can close this page.`);
  } catch (err) {
    console.error('Instagram connect failed:', err.message);
    return connectPage(res, 500, 'Something went wrong', 'We could not finish connecting the account. Please tell us and we will fix it.');
  }
});

// ---------------------------------------------------------------------------
// Keeping Instagram tokens alive
// ---------------------------------------------------------------------------
// A long-lived Instagram token lasts about 60 days. Renewing one (allowed once
// it is 24h old and before it expires) gives it another 60 days. Once a day
// we renew any active client's token that has under 21 days left, and email
// you if one is close to dying and could not be renewed. When the optional
// tenants.token_expires_at column exists we remember each expiry date;
// without it every token is simply renewed on each check.
const TOKEN_RENEW_WHEN_LEFT_MS = 21 * 24 * 60 * 60 * 1000;
const TOKEN_ALERT_WHEN_LEFT_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
let tokenExpiryColumnEnabled = false;
const tokenAlertedAt = new Map();

function tokenExpiryFields(expiresInSeconds) {
  if (!tokenExpiryColumnEnabled || !Number.isFinite(Number(expiresInSeconds))) return {};
  return { token_expires_at: new Date(Date.now() + Number(expiresInSeconds) * 1000).toISOString() };
}

async function detectTokenExpiryColumn() {
  try {
    const response = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/tenants?select=token_expires_at&limit=1`,
      { headers: supabaseHeaders() },
      8000
    );
    tokenExpiryColumnEnabled = response.ok;
    if (response.ok) {
      console.log('Token expiry tracking ENABLED (tenants.token_expires_at present)');
    } else {
      console.warn('tenants.token_expires_at not found - to track expiry dates run: alter table tenants add column if not exists token_expires_at timestamptz;');
    }
  } catch (err) {
    console.warn('Could not probe tenants.token_expires_at:', err.message);
  }
}

async function renewInstagramToken(token) {
  const response = await fetchWithTimeout(
    'https://graph.instagram.com/refresh_access_token?' +
      new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token }).toString(),
    {},
    10000
  );
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    const err = new Error((data && data.error && data.error.message) || 'Token renewal failed');
    err.code = data && data.error && data.error.code;
    throw err;
  }
  return { token: data.access_token, expiresIn: data.expires_in };
}

async function sendAdminAlert(subject, text) {
  const to = process.env.NOTIFY_OVERRIDE_EMAIL || process.env.MAIL_TO;
  if (!to || !process.env.RESEND_API_KEY) {
    console.error('ALERT (no email configured):', subject);
    return;
  }
  try {
    await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, text })
    }, 10000);
  } catch (err) {
    console.error('Could not send alert email:', err.message);
  }
}

async function renewTenantTokens() {
  const cols = 'id,business_name,instagram_account_id,instagram_access_token' + (tokenExpiryColumnEnabled ? ',token_expires_at' : '');
  const response = await fetchWithTimeout(
    `${process.env.SUPABASE_URL}/rest/v1/tenants?active=eq.true&select=${cols}`,
    { headers: supabaseHeaders() },
    8000
  );
  if (!response.ok) {
    console.error('Token check: could not load tenants:', response.status);
    return;
  }

  for (const t of await response.json()) {
    const token = t.instagram_access_token;
    if (!token || token.startsWith('PASTE')) continue;

    const expiresAt = t.token_expires_at ? Date.parse(t.token_expires_at) : null;
    const left = expiresAt ? expiresAt - Date.now() : null;
    if (left !== null && left > TOKEN_RENEW_WHEN_LEFT_MS) continue;

    try {
      const fresh = await renewInstagramToken(token);
      await patchTenantToken(t.id, fresh.token, fresh.expiresIn);
      tenantCache.delete(t.instagram_account_id);
      console.log(`Token renewed for ${t.business_name} (tenant ${t.id})`);
    } catch (err) {
      console.error(`Token renewal failed for ${t.business_name} (tenant ${t.id}):`, err.message);
      // Code 190 = Instagram says the token is invalid or expired.
      const dying = left !== null && left < TOKEN_ALERT_WHEN_LEFT_MS;
      const dead = err.code === 190;
      const lastAlert = tokenAlertedAt.get(t.id) || 0;
      if ((dying || dead) && Date.now() - lastAlert > TOKEN_CHECK_EVERY_MS) {
        tokenAlertedAt.set(t.id, Date.now());
        await sendAdminAlert(
          `Action needed: Instagram connection for ${t.business_name}`,
          `The Instagram connection for "${t.business_name}" (tenant ${t.id}) ${dead ? 'has expired or been revoked' : 'is about to expire'} and could not be renewed automatically.\n\n` +
          `Reason: ${err.message}\n\nUntil it is reconnected, the assistant cannot reply for this business. ` +
          'Send them the connect link again and ask them to open it and tap Allow.'
        );
      }
    }
  }
}

function startTokenRenewal() {
  const run = () => renewTenantTokens().catch((err) => console.error('Token check crashed:', err.message));
  setTimeout(run, 45 * 1000).unref();
  setInterval(run, TOKEN_CHECK_EVERY_MS).unref();
}

async function patchTenantToken(tenantId, token, expiresInSeconds) {
  const response = await fetchWithTimeout(
    `${process.env.SUPABASE_URL}/rest/v1/tenants?id=eq.${tenantId}`,
    { method: 'PATCH', headers: supabaseHeaders(), body: JSON.stringify({ instagram_access_token: token, ...tokenExpiryFields(expiresInSeconds) }) },
    8000
  );
  if (!response.ok) throw new Error('Token save failed: ' + JSON.stringify(await response.json().catch(() => ({}))));
}

app.listen(3000, function () {
  console.log('WebHook receiver running on http://localhost:3000');
  detectPersistentDedupe();
  detectTokenExpiryColumn();
  startTokenRenewal();
});