require('dotenv').config();

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
      break; // includes timeout aborts from fetchWithTimeout
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
});