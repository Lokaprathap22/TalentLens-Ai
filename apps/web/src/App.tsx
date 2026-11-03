import { useEffect, useState } from 'react';

import { healthResponseSchema, type HealthResponse } from '@talentlens/shared';

type ApiStatus = 'loading' | 'connected' | 'unavailable';

function App(): React.JSX.Element {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('loading');
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function checkApi(): Promise<void> {
      try {
        const response = await fetch('/api/v1/health', { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Health request failed with status ${response.status}`);
        }

        const payload: unknown = await response.json();
        const parsed = healthResponseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new Error('Health response did not match the shared schema');
        }

        setHealth(parsed.data);
        setApiStatus('connected');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setHealth(null);
        setApiStatus('unavailable');
      }
    }

    void checkApi();
    return () => controller.abort();
  }, []);

  const statusLabel = {
    loading: 'Checking API',
    connected: 'API connected',
    unavailable: 'API unavailable',
  }[apiStatus];

  return (
    <main className="shell">
      <section className="hero-panel" aria-labelledby="page-title">
        <div className="eyebrow">TalentLens AI · Foundation</div>
        <h1 id="page-title">Explainable recruitment, built for human review.</h1>
        <p className="intro">
          A focused workspace for evidence-backed candidate assessment. This development shell is
          the starting point for the recruiter and client workflows.
        </p>
        <div className="status-card" aria-live="polite">
          <span className={`status-dot status-${apiStatus}`} aria-hidden="true" />
          <div>
            <strong>{statusLabel}</strong>
            <span className="status-detail">
              {health
                ? `Last checked at ${new Date(health.timestamp).toLocaleTimeString()}`
                : 'The API will be checked when the app loads.'}
            </span>
          </div>
        </div>
      </section>
      <aside className="context-panel" aria-label="Project context">
        <span className="panel-kicker">Project context</span>
        <h2>Make every recommendation inspectable.</h2>
        <ul>
          <li>Evidence stays linked to source documents.</li>
          <li>Scores remain deterministic and reviewable.</li>
          <li>Recruiters stay accountable for decisions.</li>
        </ul>
      </aside>
    </main>
  );
}

export default App;
