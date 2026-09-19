import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export default function LeadsPage() {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    supabase
      .from('leads_v2')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else setLeads(data);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="status msg-error">Failed to load leads: {error}</p>;
  if (leads === null) return <p className="status">Loading leads...</p>;

  return (
    <div>
      <p className="eyebrow">Last 100</p>
      <h1 className="page-title">
        Recent <span className="accent">leads.</span>
      </h1>

      {leads.length === 0 ? (
        <p className="status">No leads yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Name</th>
                <th>Platform</th>
                <th>Score</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td className="nowrap muted">{new Date(lead.created_at).toLocaleString()}</td>
                  <td>{lead.name}</td>
                  <td className="muted">{lead.platform}</td>
                  <td>
                    <span className="score">{lead.ai_score ?? '-'}</span>
                  </td>
                  <td className="msg-cell">{lead.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
