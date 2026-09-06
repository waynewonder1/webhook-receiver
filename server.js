require('dotenv').config();

// Force Node to prefer IPv4 for all DNS lookups. Render's outbound network
// can't reach Gmail's SMTP server over IPv6, which was causing ENETUNREACH.
require('dns').setDefaultResultOrder('ipv4first');

const express = require('express');
const app = express();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  family: 4, // force IPv4 - Render's network can't reach Gmail over IPv6
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

app.use(function (req, res, next) {
  console.log('Incoming request:', req.method, req.url);
  next();
});

app.use(express.json());

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

// Instagram's webhook only gives you the sender's numeric ID, not their
// name. This looks up their real name/username via the Graph API.
// Requires INSTAGRAM_ACCESS_TOKEN to be set on Render (the token you
// generated in "Generate access tokens"). Returns null on any failure -
// callers should fall back to using the raw ID instead.
async function getInstagramSenderName(senderId) {
  if (!process.env.INSTAGRAM_ACCESS_TOKEN) {
    console.error('INSTAGRAM_ACCESS_TOKEN not set - cannot look up sender name');
    return null;
  }

  try {
    const response = await fetchWithTimeout(
      `https://graph.instagram.com/v26.0/${senderId}?fields=name,username&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`,
      { method: 'GET' },
      8000
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Instagram profile lookup failed:', JSON.stringify(data));
      return null;
    }

    // Prefer their display name; fall back to username if name isn't set.
    return data.name || data.username || null;
  } catch (err) {
    console.error('Instagram profile lookup threw:', err.message);
    return null;
  }
}

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
  console.log('New message received:');
  console.log(req.body);

  // Basic shared-secret check so random people can't POST to this endpoint
  // and trigger real Gemini calls (which cost money) and emails to you.
  // Set WEBHOOK_SECRET on Render, and send the same value as this header
  // from whatever is calling this webhook.
  if (process.env.WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    console.error('Rejected request - missing or wrong x-webhook-secret header');
    return res.sendStatus(401);
  }

  // Real Instagram webhook events arrive as a nested payload shaped like:
  //   { object: 'instagram', entry: [ { messaging: [ { sender, message: { text } } ] } ] }
  // Your own curl tests send a flat shape instead: { name, message, email, platform }.
  // This parses whichever shape actually arrived so both keep working.
  let name, message, email, platform;

  if (req.body.object === 'instagram' && Array.isArray(req.body.entry)) {
    const messagingEvent = req.body.entry?.[0]?.messaging?.[0];
    const senderId = messagingEvent?.sender?.id;
    const text = messagingEvent?.message?.text;

    // Look up the sender's real name/username via the Graph API. Falls
    // back to a placeholder using their raw ID if the lookup fails for
    // any reason (missing token, API error, etc.) so a lead is never lost
    // just because we couldn't get their name.
    const lookedUpName = senderId ? await getInstagramSenderName(senderId) : null;
    name = lookedUpName || (senderId ? `Instagram user ${senderId}` : null);
    message = text || null;
    email = null;
    platform = 'Instagram';
  } else {
    // Flat shape - curl tests, or any other source sending simple JSON.
    name = req.body.name;
    message = req.body.message;
    email = req.body.email || null;
    platform = req.body.platform || 'Unknown';
  }

  if (!name || !message) {
    console.error('Rejected request - missing required fields (name/message)');
    return res.status(400).send('Missing required fields: name and message');
  }

  // Step 1: Save to Supabase. This is the ONLY thing the sender waits on.
  let leadId;
  try {
    const supabaseResponse = await fetchWithTimeout(
      `${process.env.SUPABASE_URL}/rest/v1/leads_v2`,
      {
        method: 'POST',
        headers: {
          'apikey': process.env.SUPABASE_KEY,
          'authorization': `Bearer ${process.env.SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ name: name, message: message, email: email, platform: platform })
      },
      8000 // 8s timeout
    );

    const savedLead = await supabaseResponse.json();
    console.log('Saved to Supabase:', savedLead);

    if (!supabaseResponse.ok || !savedLead[0]) {
      console.error('Supabase save failed:', JSON.stringify(savedLead));
      return res.status(502).send('Failed to save lead');
    }

    leadId = savedLead[0].id;
  } catch (err) {
    console.error('Supabase save threw an error:', err.message);
    return res.status(500).send('Server error saving lead');
  }

  // Respond immediately - the lead is safely saved, so whoever/whatever
  // sent this webhook doesn't need to wait on Gemini or Gmail, which can
  // take several seconds (especially with retries). This also protects
  // against webhook providers that time out and re-send if you're slow.
  res.status(200).send('OK');

  // Everything below runs in the background, AFTER the response above has
  // already gone out. Nothing here can affect what the sender sees.
  processLeadInBackground(leadId, name, message, email, platform);
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
      await fetchWithTimeout(
        `${process.env.SUPABASE_URL}/rest/v1/leads_v2?id=eq.${leadId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': process.env.SUPABASE_KEY,
            'authorization': `Bearer ${process.env.SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ai_score: scoreText })
        },
        8000
      );
      console.log('Score saved back to Supabase for lead:', leadId);
    }

    // Step 4: Email yourself the result
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: `New lead scored: ${name} (${platform})`,
      text: `${name} just got scored.\n\nPlatform: ${platform}\nEmail: ${email || 'not provided'}\nMessage: ${message}\n\nAI Score: ${scoreText === null ? 'unavailable (Gemini scoring failed)' : scoreText}`
    });

    console.log('Email sent for lead:', leadId);
  } catch (err) {
    // Scoring or emailing failed, but the lead itself is already saved,
    // so we just log the problem - there's no request left to respond to.
    console.error('Post-save processing failed for lead', leadId, '-', err.message);
  }
}

app.listen(3000, function () {
  console.log('WebHook receiver running on http://localhost:3000');
});