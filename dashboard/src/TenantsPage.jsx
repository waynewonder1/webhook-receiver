import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

const EDITABLE_FIELDS = [
  { key: 'business_name', label: 'Business name', type: 'text' },
  { key: 'notification_email', label: 'Notification email', type: 'text' },
  { key: 'auto_reply_message', label: 'Fallback auto-reply (used only if AI reply generation fails)', type: 'textarea' },
  { key: 'business_description', label: 'Business description / voice', type: 'textarea' },
  { key: 'knowledge_base', label: 'Knowledge base (prices, services, policies...)', type: 'textarea' }
];

// Shows how many days a client's Instagram token has left, so a token that
// is about to expire is visible at a glance (the server renews them itself,
// but this is where you'd notice if that ever stops working).
function TokenPill({ expiresAt }) {
  if (!expiresAt) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
  return (
    <span className={`pill ${days > 14 ? 'on' : 'off'}`}>
      {days > 0 ? `Token: ${days}d left` : 'Token expired'}
    </span>
  );
}

// One editable tenant card. Keeps its own draft state so typing doesn't
// touch the parent list until you actually hit Save.
function TenantCard({ tenant, onSaved }) {
  const [draft, setDraft] = useState(tenant);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // 'saved' | 'error' | null

  function setField(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);

    const updates = { active: !!draft.active };
    for (const { key } of EDITABLE_FIELDS) updates[key] = draft[key];

    const { error } = await supabase.from('tenants').update(updates).eq('id', tenant.id);

    setSaving(false);
    setStatus(error ? 'error' : 'saved');
    if (!error) onSaved(draft);
  }

  const hasChanges =
    !!draft.active !== !!tenant.active || EDITABLE_FIELDS.some(({ key }) => draft[key] !== tenant[key]);

  return (
    <div className="card">
      <div className="card-meta">
        <span>Tenant #{tenant.id}</span>
        <span className={`pill ${tenant.active ? 'on' : 'off'}`}>
          {tenant.active ? 'Active' : 'Inactive'}
        </span>
        <TokenPill expiresAt={tenant.token_expires_at} />
        <span>IG account: {tenant.instagram_account_id || 'not set'}</span>
      </div>

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={!!draft.active}
            onChange={(e) => setField('active', e.target.checked)}
          />
          Active - the assistant replies to messages on this account
        </label>
      </div>

      {EDITABLE_FIELDS.map(({ key, label, type }) => (
        <div key={key} className="field">
          <label className="label">{label}</label>
          {type === 'textarea' ? (
            <textarea
              className="input"
              value={draft[key] || ''}
              onChange={(e) => setField(key, e.target.value)}
              rows={key === 'knowledge_base' ? 12 : 3}
            />
          ) : (
            <input
              className="input"
              type="text"
              value={draft[key] || ''}
              onChange={(e) => setField(key, e.target.value)}
            />
          )}
        </div>
      ))}

      <div className="actions">
        <button className="btn" onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? 'Saving...' : 'Save changes'}
        </button>
        {status === 'saved' && <span className="msg-ok">Saved.</span>}
        {status === 'error' && <span className="msg-error">Save failed - check the console.</span>}
      </div>
    </div>
  );
}

export default function TenantsPage() {
  const [tenants, setTenants] = useState(null); // null = still loading
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    supabase
      .from('tenants')
      .select('*')
      .order('id')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else setTenants(data);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="status msg-error">Failed to load tenants: {error}</p>;
  if (tenants === null) return <p className="status">Loading tenants...</p>;
  if (tenants.length === 0) return <p className="status">No tenants found.</p>;

  return (
    <div>
      <p className="eyebrow">Configuration</p>
      <h1 className="page-title">
        Your <span className="accent">tenants.</span>
      </h1>
      {tenants.map((tenant) => (
        <TenantCard
          key={tenant.id}
          tenant={tenant}
          onSaved={(updated) =>
            setTenants((list) => list.map((t) => (t.id === tenant.id ? { ...t, ...updated } : t)))
          }
        />
      ))}
    </div>
  );
}
