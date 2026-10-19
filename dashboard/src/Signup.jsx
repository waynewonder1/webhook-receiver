import { useState } from 'react';
import { supabase } from './supabaseClient';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

// Reached through the link you send a new client: <dashboard>/?signup=<key>.
// The key is checked by the server, which creates the login.
export default function Signup({ signupKey, onSwitchToLogin }) {
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE}/api/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: signupKey, email, password, businessName })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error || `Sign-up failed (${response.status})`);
        setLoading(false);
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      window.history.replaceState(null, '', window.location.pathname);
      // App.jsx hears the new session and opens the Setup page.
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <p className="eyebrow">Get started</p>
      <h1 className="page-title">
        Create your <span className="accent">account.</span>
      </h1>
      <p className="setup-lead">
        Set up an assistant that answers your Instagram DMs in about 5 minutes.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label className="label">Business name</label>
          <input className="input" value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
        </div>
        <div className="field">
          <label className="label">Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label className="label">Password (at least 8 characters)</label>
          <input
            className="input"
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="msg-error">{error}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={loading}>
            {loading ? 'Creating account...' : 'Create account'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onSwitchToLogin}>
            I already have an account
          </button>
        </div>
      </form>
    </div>
  );
}
