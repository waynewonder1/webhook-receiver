import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function api(path, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session && data.session.access_token;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function remembered(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode etc. - the step just shows its button again next visit
  }
}

// The four steps a new client walks through. Each step's "done" comes from
// the server (/api/setup/status), so refreshing or coming back later picks
// up where they left off.
export default function SetupPage({ onFinished }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    return api('/api/setup/status')
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // While waiting for the test DM, check every few seconds.
  const waitingForDm = status && status.instagramConnected && status.hasInfo && !status.lastMessageAt && !status.active;
  useEffect(() => {
    if (!waitingForDm) return undefined;
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [waitingForDm, refresh]);

  if (error && !status) return <p className="status msg-error">{error}</p>;
  if (!status) return <p className="status">Loading your setup...</p>;

  const steps = [
    { done: status.instagramConnected },
    { done: status.hasInfo },
    { done: !!status.lastMessageAt || status.active },
    { done: status.active }
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div>
      <p className="eyebrow">Setup</p>
      <h1 className="page-title">
        {status.active ? 'You’re live' : 'Let’s get you live'}
        <span className="accent">.</span>
      </h1>
      <p className="setup-lead">
        {status.active
          ? 'Your assistant is answering your Instagram DMs. You can change your business info any time in the Business tab.'
          : 'Four short steps. You can leave and come back - your progress is saved.'}
      </p>

      <ol className="steps">
        <Step n={1} title="Connect your Instagram" done={steps[0].done} open={current === 0}>
          <ConnectStep status={status} />
        </Step>
        <Step n={2} title="Tell the assistant about your business" done={steps[1].done} open={current === 1}>
          <InfoStep onSaved={refresh} />
        </Step>
        <Step n={3} title="Allow messages and send a test DM" done={steps[2].done} open={current === 2}>
          <MessagesStep />
        </Step>
        <Step n={4} title="Go live" done={steps[3].done} open={current === 3}>
          <LiveStep />
        </Step>
      </ol>

      {status.active && (
        <div className="actions">
          <button className="btn" onClick={onFinished}>
            See your leads
          </button>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, done, open, children }) {
  return (
    <li className={`step card ${done ? 'done' : ''} ${open ? 'open' : ''}`}>
      <div className="step-head">
        <span className="step-num">{done ? '✓' : n}</span>
        <h2 className="step-title">{title}</h2>
      </div>
      {open && <div className="step-body">{children}</div>}
    </li>
  );
}

function ConnectStep({ status }) {
  const [username, setUsername] = useState('');
  const [inviteSent, setInviteSent] = useState(() => remembered('setup.inviteSent') === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function requestInvite(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup/notify', { method: 'POST', body: JSON.stringify({ kind: 'invite', instagramUsername: username }) });
      remember('setup.inviteSent', '1');
      setInviteSent(true);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api('/api/setup/connect', {
        method: 'POST',
        body: JSON.stringify({ returnTo: window.location.origin + window.location.pathname })
      });
      window.location.href = url;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        Your Instagram must be a <strong>Business</strong> or <strong>Creator</strong> account. Check in Instagram:{' '}
        <em>Settings &rarr; Account type and tools</em>. Switching is free.
      </p>

      {status.testerInvitesRequired && (
        <div className="sub-step">
          <p className="sub-title">a. Get your invite</p>
          {inviteSent ? (
            <p>
              We&rsquo;ll send an invite to your Instagram, usually within a few hours. To accept it, open Instagram:{' '}
              <em>Settings &rarr; Website permissions (Apps and websites) &rarr; Tester invites &rarr; Accept</em>. Then
              continue below.
            </p>
          ) : (
            <form onSubmit={requestInvite} className="inline-form">
              <input
                className="input"
                placeholder="Your Instagram username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <button className="btn" type="submit" disabled={busy}>
                Request invite
              </button>
            </form>
          )}
        </div>
      )}

      <div className="sub-step">
        {status.testerInvitesRequired && <p className="sub-title">b. Connect</p>}
        <p>Log in to Instagram and tap <strong>Allow</strong>. You&rsquo;ll come straight back here.</p>
        <button className="btn" onClick={connect} disabled={busy || (status.testerInvitesRequired && !inviteSent)}>
          Connect Instagram
        </button>
        {status.testerInvitesRequired && !inviteSent && <p className="hint">Request your invite first.</p>}
      </div>
      {error && <p className="msg-error">{error}</p>}
    </>
  );
}

function InfoStep({ onSaved }) {
  const [business, setBusiness] = useState(null);
  const [website, setWebsite] = useState('');
  const [description, setDescription] = useState('');
  const [knowledge, setKnowledge] = useState('');
  const [missing, setMissing] = useState([]);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase
      .from('my_business')
      .select('*')
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) return setError(error.message);
        setBusiness(data);
        setDescription((data && data.business_description) || '');
        setKnowledge((data && data.knowledge_base) || '');
      });
  }, []);

  async function draft(e) {
    e.preventDefault();
    setDrafting(true);
    setError(null);
    try {
      const result = await api('/api/setup/draft', { method: 'POST', body: JSON.stringify({ url: website }) });
      setDescription(result.business_description);
      setKnowledge(result.knowledge_base);
      setMissing(result.missing || []);
    } catch (err) {
      setError(err.message);
    }
    setDrafting(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const { error } = await supabase.rpc('update_my_business', {
      p_business_name: business.business_name,
      p_business_description: description,
      p_knowledge_base: knowledge,
      p_auto_reply_message: business.auto_reply_message,
      p_notification_email: business.notification_email
    });
    setSaving(false);
    if (error) return setError(error.message);
    onSaved();
  }

  if (!business) return error ? <p className="msg-error">{error}</p> : <p className="status">Loading...</p>;

  return (
    <>
      <p>Paste your website and we&rsquo;ll write a first draft for you. No website? Type it in the boxes below.</p>
      <form onSubmit={draft} className="inline-form">
        <input
          className="input"
          placeholder="yourbusiness.com"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          required
        />
        <button className="btn" type="submit" disabled={drafting}>
          {drafting ? 'Reading your site...' : 'Write it for me'}
        </button>
      </form>

      {missing.length > 0 && (
        <div className="notice">
          <strong>Your website didn&rsquo;t say:</strong> {missing.join(', ')}. Add these below so the assistant can
          answer them.
        </div>
      )}

      <div className="field">
        <label className="label">About your business and how you talk to customers</label>
        <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label className="label">Products, prices, delivery, payment, hours, policies</label>
        <textarea className="input" rows={14} value={knowledge} onChange={(e) => setKnowledge(e.target.value)} />
        <p className="hint">The assistant only says what&rsquo;s written here. Check every price is right.</p>
      </div>
      {error && <p className="msg-error">{error}</p>}
      <div className="actions">
        <button className="btn" onClick={save} disabled={saving || knowledge.trim().length < 50}>
          {saving ? 'Saving...' : 'Looks right - save'}
        </button>
      </div>
    </>
  );
}

function MessagesStep() {
  return (
    <>
      <p>
        <strong>1.</strong> In Instagram, open{' '}
        <em>Settings &rarr; Messages and story replies &rarr; Connected tools</em> and turn on{' '}
        <strong>Allow access to messages</strong>.
      </p>
      <p>
        <strong>2.</strong> From a <strong>different</strong> Instagram account (a friend&rsquo;s, or a second account),
        send your business a DM, like &ldquo;Hi, how much is ...?&rdquo;
      </p>
      <p className="waiting">
        <span className="pulse" /> Waiting for your test message...
      </p>
      <p className="hint">
        Nothing after a minute? Check step 1 is on, then send another message. Your assistant won&rsquo;t reply yet -
        this just checks messages reach us.
      </p>
    </>
  );
}

function LiveStep() {
  const [sent, setSent] = useState(() => remembered('setup.liveRequested') === '1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function goLive() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup/notify', { method: 'POST', body: JSON.stringify({ kind: 'live' }) });
      remember('setup.liveRequested', '1');
      setSent(true);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  return (
    <>
      <p className="ok-line">✓ Your test message arrived. Everything is connected.</p>
      {sent ? (
        <p>
          We&rsquo;re doing a final check of your replies and will switch your assistant on shortly - usually the same
          day. This page will say <strong>You&rsquo;re live</strong> when it&rsquo;s on.
        </p>
      ) : (
        <>
          <p>We&rsquo;ll test a few replies with your info, then switch your assistant on.</p>
          <button className="btn" onClick={goLive} disabled={busy}>
            Turn on my assistant
          </button>
        </>
      )}
      {error && <p className="msg-error">{error}</p>}
    </>
  );
}
