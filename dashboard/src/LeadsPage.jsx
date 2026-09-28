import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';

// One customer's messages, grouped together instead of one row each. Click
// to expand and see the full thread. If leads_v2.sender_id isn't set up yet
// (see the warning server.js logs on startup), every lead just falls back to
// being its own one-message "conversation" - nothing looks broken either way.
function ConversationCard({ group }) {
  const [open, setOpen] = useState(false);
  const latest = group.messages[group.messages.length - 1];
  const hasMore = group.messages.length > 1;

  return (
    <div className="card">
      <div
        onClick={() => hasMore && setOpen((o) => !o)}
        style={{ cursor: hasMore ? 'pointer' : 'default' }}
      >
        <div className="card-meta">
          <span>{latest.name}</span>
          <span className="muted">{latest.platform}</span>
          {hasMore && <span className="pill on">{group.messages.length} messages{open ? ' – hide' : ' – show all'}</span>}
          <span className="muted">{new Date(latest.created_at).toLocaleString()}</span>
          <span className="score">{latest.ai_score ?? '-'}</span>
        </div>
        <div className="msg-cell">{latest.message}</div>
      </div>

      {open && hasMore && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          {group.messages.slice(0, -1).map((m) => (
            <div key={m.id} style={{ marginBottom: 14 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {new Date(m.created_at).toLocaleString()} - score {m.ai_score ?? '-'}
              </div>
              <div className="msg-cell">{m.message}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LeadsPage() {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    supabase
      .from('leads_v2')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else setLeads(data);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // `leads` is newest-first. Group each customer's messages together (by
  // tenant + sender_id), keeping that same newest-first order inside each
  // group, then flip each group to oldest-first for a natural read.
  const conversations = useMemo(() => {
    if (!leads) return [];
    const groups = new Map();
    for (const lead of leads) {
      const key = lead.sender_id ? `${lead.tenant_id}:${lead.sender_id}` : `lead-${lead.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(lead);
    }
    return Array.from(groups.values())
      .map((messages) => ({ key: messages[0].id, messages: messages.slice().reverse() }))
      .sort((a, b) => new Date(b.messages[b.messages.length - 1].created_at) - new Date(a.messages[a.messages.length - 1].created_at));
  }, [leads]);

  if (error) return <p className="status msg-error">Failed to load leads: {error}</p>;
  if (leads === null) return <p className="status">Loading leads...</p>;

  return (
    <div>
      <p className="eyebrow">Conversations</p>
      <h1 className="page-title">
        Recent <span className="accent">leads.</span>
      </h1>

      {conversations.length === 0 ? (
        <p className="status">No leads yet.</p>
      ) : (
        conversations.map((group) => <ConversationCard key={group.key} group={group} />)
      )}
    </div>
  );
}
