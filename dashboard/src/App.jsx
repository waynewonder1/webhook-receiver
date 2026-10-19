import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import Login from './Login';
import TenantsPage from './TenantsPage';
import LeadsPage from './LeadsPage';
import TestPage from './TestPage';
import ClientBusinessPage from './ClientBusinessPage';
import Signup from './Signup';
import SetupPage from './SetupPage';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [isAdmin, setIsAdmin] = useState(undefined); // undefined = still checking
  const [tab, setTab] = useState(null);
  const [signupKey, setSignupKey] = useState(() => new URLSearchParams(window.location.search).get('signup'));

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setIsAdmin(undefined);
      setTab(null);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    // A user can only ever see their OWN row here (see the "a user can check
    // their own admin status" policy) - a plain client gets an empty result,
    // never a way to check anyone else's status.
    supabase
      .from('admins')
      .select('user_id')
      .then(async ({ data }) => {
        const admin = !!(data && data.length);
        if (admin) {
          setIsAdmin(true);
          setTab('tenants');
          return;
        }
        // A client whose assistant is already on lands on their leads;
        // anyone still setting up lands on Setup.
        const { data: business } = await supabase.from('my_business').select('active').maybeSingle();
        setIsAdmin(false);
        setTab(business && business.active ? 'leads' : 'setup');
      });
  }, [session]);

  if (session === undefined) return <p className="status shell">Loading...</p>;
  if (session === null) {
    return signupKey ? (
      <Signup
        signupKey={signupKey}
        onSwitchToLogin={() => {
          window.history.replaceState(null, '', window.location.pathname);
          setSignupKey(null);
        }}
      />
    ) : (
      <Login />
    );
  }
  if (isAdmin === undefined) return <p className="status shell">Loading...</p>;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          Dashboard<span>.</span>
        </div>

        <nav className="nav">
          {isAdmin ? (
            <>
              <button className={`nav-link ${tab === 'tenants' ? 'active' : ''}`} onClick={() => setTab('tenants')}>
                Tenants
              </button>
              <button className={`nav-link ${tab === 'leads' ? 'active' : ''}`} onClick={() => setTab('leads')}>
                Leads
              </button>
              <button className={`nav-link ${tab === 'test' ? 'active' : ''}`} onClick={() => setTab('test')}>
                Test
              </button>
            </>
          ) : (
            <>
              <button className={`nav-link ${tab === 'setup' ? 'active' : ''}`} onClick={() => setTab('setup')}>
                Setup
              </button>
              <button className={`nav-link ${tab === 'business' ? 'active' : ''}`} onClick={() => setTab('business')}>
                Business
              </button>
              <button className={`nav-link ${tab === 'leads' ? 'active' : ''}`} onClick={() => setTab('leads')}>
                Leads
              </button>
            </>
          )}
        </nav>

        <div className="user-box">
          <span>{session.user.email}</span>
          <button className="btn btn-ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {isAdmin ? (
        <>
          {tab === 'tenants' && <TenantsPage />}
          {tab === 'leads' && <LeadsPage source="leads_v2" />}
          {tab === 'test' && <TestPage />}
        </>
      ) : (
        <>
          {tab === 'setup' && <SetupPage onFinished={() => setTab('leads')} />}
          {tab === 'business' && <ClientBusinessPage />}
          {tab === 'leads' && <LeadsPage source="my_leads" />}
        </>
      )}
    </div>
  );
}
