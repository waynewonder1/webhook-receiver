// Public Privacy Policy, Terms of Service and Data Deletion pages. Meta App
// Review requires these URLs before the app can serve accounts that aren't
// testers. Set BRAND_NAME and CONTACT_EMAIL on Render to change the wording.

const LAST_UPDATED = '19 October 2026';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function brand() {
  return {
    name: process.env.BRAND_NAME || 'Instagram DM Assistant',
    email: process.env.CONTACT_EMAIL || process.env.MAIL_TO || ''
  };
}

function legalPage(res, title, bodyHtml) {
  const { name } = brand();
  res.status(200).type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - ${esc(name)}</title>` +
    '<style>body{font-family:system-ui,sans-serif;background:#0a0d0d;color:#eef0ed;margin:0;padding:40px 16px;line-height:1.6}main{max-width:720px;margin:0 auto}' +
    'h1{font-size:30px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 8px}p,li{color:#c3cac7}a{color:#7fd1b9}.muted{color:#8a938f;font-size:14px}' +
    'nav{margin-top:40px;padding-top:16px;border-top:1px solid #222a28;font-size:14px}nav a{margin-right:16px}</style>' +
    `</head><body><main><h1>${esc(title)}</h1><p class="muted">${esc(name)} · Last updated ${LAST_UPDATED}</p>${bodyHtml}` +
    '<nav><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/data-deletion">Data Deletion</a></nav>' +
    '</main></body></html>'
  );
}

function contactLine() {
  const { email } = brand();
  return email
    ? `email us at <a href="mailto:${esc(email)}">${esc(email)}</a>`
    : 'contact us through the business that set up the assistant for you';
}

function registerLegalRoutes(app) {
  app.get('/privacy', function (req, res) {
    const { name } = brand();
    legalPage(res, 'Privacy Policy', `
<p>${esc(name)} ("we", "us") provides an automated assistant that replies to Instagram direct messages on behalf of businesses that sign up for it ("client businesses"). This policy explains what information we handle and why.</p>

<h2>Information we collect</h2>
<p><strong>From client businesses</strong>, when they connect their Instagram professional account: the Instagram account ID and username, an access token issued by Instagram, the business name, a contact email for lead alerts, and the business information they give us (products, prices, policies).</p>
<p><strong>From people who message a client business on Instagram</strong>: their Instagram-scoped user ID, their name and username as provided by Instagram, the content of messages they send to that business, and recent messages in that conversation.</p>

<h2>How we use it</h2>
<ul>
<li>To write and send replies to messages on the client business's behalf.</li>
<li>To score each conversation for buying interest and send the client business an email alert about it.</li>
<li>To show the client business its conversations in a private dashboard.</li>
<li>To keep the service working, prevent duplicate replies and fix problems.</li>
</ul>
<p>We do not sell personal information, use it for advertising, or use it for any purpose other than providing the service to the client business the message was sent to.</p>

<h2>Service providers</h2>
<p>We use these providers to run the service, and they process information only on our behalf:</p>
<ul>
<li><strong>Meta / Instagram</strong> - to receive and send messages.</li>
<li><strong>Google (Gemini API)</strong> - message text and the business's information are sent to generate replies and lead scores.</li>
<li><strong>Supabase</strong> - database storage.</li>
<li><strong>Render</strong> - application hosting.</li>
<li><strong>Resend</strong> - sending lead alert emails.</li>
</ul>

<h2>How long we keep it</h2>
<p>We keep conversation and lead records for as long as the client business uses the service, so it can follow up with its customers. When a client business stops using the service, or when someone asks us to delete their data, we delete it as described on our <a href="/data-deletion">Data Deletion</a> page.</p>

<h2>Security</h2>
<p>Access tokens and records are stored in an access-controlled database, connections use HTTPS, and incoming Instagram events are checked against Meta's signature before they are processed.</p>

<h2>Your choices and rights</h2>
<p>You can ask us to access, correct or delete information about you. Client businesses can disconnect their Instagram account at any time from Instagram's settings. To make a request, ${contactLine()}.</p>

<h2>Changes</h2>
<p>We may update this policy. The date at the top shows the latest version.</p>

<h2>Contact</h2>
<p>For any privacy question, ${contactLine()}.</p>`);
  });

  app.get('/terms', function (req, res) {
    const { name } = brand();
    legalPage(res, 'Terms of Service', `
<p>These terms apply to businesses that use ${esc(name)} (the "service") to reply to Instagram direct messages.</p>

<h2>The service</h2>
<p>The service automatically replies to direct messages sent to your Instagram professional account, using the business information you provide, and sends you alerts about potential customers. Replies are generated automatically and are sent without human review.</p>

<h2>Your responsibilities</h2>
<ul>
<li>You must own or be authorised to manage the Instagram account you connect.</li>
<li>The business information you give us must be accurate and kept up to date. Replies are only as accurate as that information.</li>
<li>You must follow Instagram's Terms of Use, Meta's Platform Terms and Commerce Policies, and the laws that apply to your business, including any rules on what you sell and how you advertise it.</li>
<li>You must not use the service to send spam, mislead customers, or offer products or services that Meta's policies prohibit.</li>
</ul>

<h2>Automated replies</h2>
<p>Automated replies can be wrong. You remain responsible for your business's dealings with your customers, including prices, orders and advice. Check your conversations regularly and tell us about any reply that needs correcting.</p>

<h2>Availability</h2>
<p>We aim to keep the service running but do not guarantee it will be uninterrupted. Replies may be delayed or not sent if Instagram, our providers or the service are unavailable.</p>

<h2>Ending the service</h2>
<p>You can stop using the service at any time by telling us or by removing the app's access in your Instagram settings. We may suspend the service for accounts that break these terms or Meta's policies.</p>

<h2>Privacy</h2>
<p>Our <a href="/privacy">Privacy Policy</a> explains how we handle information.</p>

<h2>Contact</h2>
<p>For questions about these terms, ${contactLine()}.</p>`);
  });

  app.get('/data-deletion', function (req, res) {
    legalPage(res, 'Data Deletion Instructions', `
<p>You can ask us to delete the information we hold about you at any time.</p>

<h2>If you messaged a business that uses this service</h2>
<ol>
<li>${contactLine().replace(/^./, (c) => c.toUpperCase())} with the subject "Delete my data".</li>
<li>Include your Instagram username and the name of the business you messaged, so we can find your records.</li>
</ol>
<p>We will delete your messages, name, username and related lead records within 30 days and confirm by email.</p>

<h2>If you are a business using this service</h2>
<ol>
<li>Remove the app's access in Instagram: Settings &rarr; Website permissions (Apps and websites) &rarr; remove the app.</li>
<li>${contactLine().replace(/^./, (c) => c.toUpperCase())} asking us to delete your account.</li>
</ol>
<p>We will delete your access token, business information and stored conversations within 30 days and confirm by email.</p>`);
  });
}

module.exports = { registerLegalRoutes };
