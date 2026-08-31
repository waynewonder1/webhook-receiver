require('dotenv').config();

const express = require('express');
const app = express();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
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
  try {
    // Step 2: Score with Gemini
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
      console.error('Gemini API error:', JSON.stringify(geminiData));
      throw new Error('Gemini scoring failed');
    }

    const scoreText = geminiData.candidates[0].content.parts[0].text;
    console.log('Gemini score:', scoreText);

    // Step 3: Save the score back to Supabase
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