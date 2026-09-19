import { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (error) setError(error.message);
    // On success App.jsx hears the auth state change and swaps the view.
  }

  return (
    <div className="login-wrap">
      <p className="eyebrow">Admin access</p>
      <h1 className="page-title">
        Sign <span className="accent">in.</span>
      </h1>

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label className="label">Email</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="msg-error">{error}</p>}
        <button className="btn" type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
