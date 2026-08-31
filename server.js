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

app.post('/webhook', async function (req, res) {
  console.log('New message received:');
  console.log(req.body);

  const name = req.body.name;
  const message = req.body.message;
  const email = req.body.email || null;
  const platform = req.body.platform || 'Unknown';

  let leadId;

  // Step 1: Save to Supabase
  try {
    const supabaseResponse = await fetch(
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
      }
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

  // From here on, the lead is safely saved. Nothing below should be able
  // to break the response the sender/webhook gets back.
  let scoreText = null;

  // Step 2: Score with Gemini (with retry — Gemini occasionally returns a
  // temporary 503 "high demand" error, which usually clears within seconds)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const geminiResponse = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent',
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
        }
      );

      const geminiData = await geminiResponse.json();

      if (!geminiResponse.ok || !geminiData.candidates || !geminiData.candidates[0]) {
        console.error(`Gemini API error (attempt ${attempt}):`, JSON.stringify(geminiData));
        // 503 = temporary overload on Google's side, worth retrying.
        // Anything else (bad key, invalid model, etc.) won't fix itself, so stop retrying.
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
      break;
    }
  }

  try {
    // Step 3: Save the score back to Supabase (only if we actually got one)
    if (scoreText === null) {
      console.error('Skipping Supabase score update and email — no score for lead', leadId);
      return res.status(200).send('OK');
    }

    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/leads_v2?id=eq.${leadId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': process.env.SUPABASE_KEY,
          'authorization': `Bearer ${process.env.SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ai_score: scoreText })
      }
    );
    console.log('Score saved back to Supabase for lead:', leadId);

    // Step 4: Email yourself the result
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: `New lead scored: ${name} (${platform})`,
      text: `${name} just got scored.\n\nPlatform: ${platform}\nEmail: ${email || 'not provided'}\nMessage: ${message}\n\nAI Score: ${scoreText}`
    });

    console.log('Email sent for lead:', leadId);
  } catch (err) {
    // Scoring or emailing failed, but the lead itself is already saved,
    // so we log the problem instead of crashing the request.
    console.error('Post-save processing failed for lead', leadId, '-', err.message);
  }

  res.status(200).send('OK');
});

app.listen(3000, function () {
  console.log('WebHook receiver running on http://localhost:3000');
});