import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import Login from './Login';
import TenantsPage from './TenantsPage';
import LeadsPage from './LeadsPage';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [tab, setTab] = useState('tenants');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <p className="status shell">Loading...</p>;
  if (session === null) return <Login />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          Dashboard<span>.</span>
        </div>

        <nav className="nav">
          <button
            className={`nav-link ${tab === 'tenants' ? 'active' : ''}`}
            onClick={() => setTab('tenants')}
          >
            Tenants
          </button>
          <button
            className={`nav-link ${tab === 'leads' ? 'active' : ''}`}
            onClick={() => setTab('leads')}
          >
            Leads
          </button>
        </nav>

        <div className="user-box">
          <span>{session.user.email}</span>
          <button className="btn btn-ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {tab === 'tenants' ? <TenantsPage /> : <LeadsPage />}
    </div>
  );
}
