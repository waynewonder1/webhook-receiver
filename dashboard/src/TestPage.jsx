import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

export default function TestPage() {
  const [tenants, setTenants] = useState(null);
  const [tenantId, setTenantId] = useState('');
  const [thread, setThread] = useState([]); // [{ who: 'Customer'|'Us', text }]
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase
      .from('tenants')
      .select('id,business_name')
      .order('id')
      .then(({ data, error }) => {
        if (error) return setError(error.message);
        setTenants(data);
        if (data && data[0]) setTenantId(String(data[0].id));
      });
  }, []);

  async function send() {
    const message = draft.trim();
    if (!message || !tenantId) return;

    setLoading(true);
    setError(null);
    const nextThread = [...thread, { who: 'Customer', text: message }];
    setThread(nextThread);
    setDraft('');

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session && sessionData.session.access_token;

      const response = await fetch(`${API_BASE}/api/test-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tenantId: Number(tenantId),
          message,
          // send everything before this message as its history, same shape the real server uses
          history: thread.slice(-10)
        })
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error || `Request failed (${response.status})`);
        return;
      }

      setThread((t) => [...t, { who: 'Us', text: result.customer_reply || '(no reply text)', meta: result }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!API_BASE) {
    return (
      <p className="status msg-error">
        VITE_API_BASE_URL is not set in dashboard/.env - point it at your server's URL (e.g.
        https://your-app.onrender.com) and restart the dashboard.
      </p>
    );
  }

  if (error && tenants === null) return <p className="status msg-error">Failed to load tenants: {error}</p>;
  if (tenants === null) return <p className="status">Loading...</p>;

  return (
    <div>
      <p className="eyebrow">Try it out</p>
      <h1 className="page-title">
        Test the <span className="accent">assistant.</span>
      </h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        Type a question as if you were a customer. This calls the real AI with that
        tenant's real knowledge base, but sends nothing to Instagram and saves no lead.
      </p>

      <div className="field">
        <label className="label">Testing as tenant</label>
        <select
          className="input"
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value);
            setThread([]);
          }}
        >
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.id} - {t.business_name}
            </option>
          ))}
        </select>
      </div>

      <div className="card" style={{ minHeight: 200 }}>
        {thread.length === 0 && <p className="muted">No messages yet - type one below.</p>}
        {thread.map((m, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <div className="label" style={{ marginBottom: 4 }}>{m.who === 'Customer' ? 'Customer (you)' : 'Assistant'}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
            {m.meta && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                score {m.meta.score ?? '?'}/10 ({m.meta.category ?? 'unknown'})
                {m.meta.reasoning ? ` - ${m.meta.reasoning}` : ''}
              </div>
            )}
          </div>
        ))}
        {loading && <p className="muted">Thinking...</p>}
      </div>

      {error && <p className="msg-error" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="field">
        <textarea
          className="input"
          rows={2}
          placeholder="Type a test customer message and press Enter..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
      </div>
      <div className="actions">
        <button className="btn" onClick={send} disabled={loading || !draft.trim()}>
          {loading ? 'Sending...' : 'Send'}
        </button>
        {thread.length > 0 && (
          <button className="btn btn-ghost" onClick={() => setThread([])} disabled={loading}>
            Clear conversation
          </button>
        )}
      </div>
    </div>
  );
}
