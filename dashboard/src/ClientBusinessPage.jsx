import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

// Deliberately the same five fields the update_my_business() database
// function accepts - a client literally cannot touch anything else (not the
// Instagram token, not the active toggle, not another business's data). See
// the SQL migration for how that's enforced server-side, not just hidden here.
const FIELDS = [
  { key: 'business_name', label: 'Business name', type: 'text' },
  { key: 'notification_email', label: 'Where lead alerts go', type: 'text' },
  { key: 'auto_reply_message', label: 'Fallback reply (used only if the AI is unavailable)', type: 'textarea' },
  { key: 'business_description', label: 'Business description / voice', type: 'textarea' },
  { key: 'knowledge_base', label: 'Knowledge base (prices, services, policies...)', type: 'textarea' }
];

export default function ClientBusinessPage() {
  const [business, setBusiness] = useState(undefined); // undefined = loading, null = none found
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    supabase
      .from('my_business')
      .select('*')
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) return setError(error.message);
        setBusiness(data);
        setDraft(data);
      });
  }, []);

  function setField(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);

    const { error } = await supabase.rpc('update_my_business', {
      p_business_name: draft.business_name,
      p_business_description: draft.business_description,
      p_knowledge_base: draft.knowledge_base,
      p_auto_reply_message: draft.auto_reply_message,
      p_notification_email: draft.notification_email
    });

    setSaving(false);
    setStatus(error ? 'error' : 'saved');
    if (!error) setBusiness(draft);
  }

  if (error) return <p className="status msg-error">Failed to load your business: {error}</p>;
  if (business === undefined) return <p className="status">Loading...</p>;
  if (business === null) {
    return (
      <p className="status">
        No business is linked to your account yet - ask whoever set this up to connect one.
      </p>
    );
  }

  const hasChanges = FIELDS.some(({ key }) => draft[key] !== business[key]);

  return (
    <div>
      <p className="eyebrow">Your business</p>
      <h1 className="page-title">
        Settings<span className="accent">.</span>
      </h1>

      <div className="card">
        <div className="card-meta">
          <span className={`pill ${business.active ? 'on' : 'off'}`}>
            {business.active ? 'Assistant is active' : 'Assistant is inactive'}
          </span>
          {business.instagram_account_id && <span>Instagram connected</span>}
        </div>

        {FIELDS.map(({ key, label, type }) => (
          <div key={key} className="field">
            <label className="label">{label}</label>
            {type === 'textarea' ? (
              <textarea
                className="input"
                rows={key === 'knowledge_base' ? 12 : 3}
                value={draft[key] || ''}
                onChange={(e) => setField(key, e.target.value)}
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
          {status === 'error' && <span className="msg-error">Save failed - try again.</span>}
        </div>
      </div>
    </div>
  );
}
