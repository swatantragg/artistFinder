// Entry: connect to the API, sign in, then render the app. Without the API there is no data, and the start screen says
// how to start it.
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { account, connect, createBackend, type AuthState } from './api/backend';
import { ActionHost } from './components/actions';
import { Layout } from './components/Layout';
import { Empty } from './components/ui';
import { AppProvider } from './lib/app';
import { AuditPage, ReportsPage, SettingsPage, applyStoredTheme } from './pages/Admin';
import Artists from './pages/Artists';
import { AuthPage } from './pages/Auth';
import Dashboard from './pages/Dashboard';
import Deduplicate from './pages/Deduplicate';
import Dossier from './pages/dossier/Dossier';
import ImportResult from './pages/ImportResult';
import Imports from './pages/Imports';
import { ResearchPage, RoutesPage } from './pages/Overviews';
import Queue from './pages/Queue';
import VerifiedArtists from './pages/VerifiedArtists';
import './styles.css';

/** Old links (bookmarks, notifications) keep working: they open the same thing in the artist-centric layout. */
function ToArtist({ tab }: { tab?: string }) {
  const { id = '' } = useParams();
  const { search } = useLocation();
  const q = new URLSearchParams(search);
  if (tab) q.set('tab', tab);
  return <Navigate to={`/artists/${id}${q.toString() ? `?${q}` : ''}`} replace />;
}

applyStoredTheme();

function Boot() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null); setStatus('Connecting…');
    connect(setStatus).then(account.state).then(setAuth).catch(e => setError(String(e?.message ?? e)));
  }, [attempt]);
  // When the server ends the session (signed out, expired, password changed elsewhere) go back to the sign-in page.
  const signedOut = useCallback(() => {
    setAuth(a => (a?.me ? { ...a, me: null } : a));
    account.state().then(setAuth).catch(() => undefined);
  }, []);
  const backend = useMemo(() => createBackend(signedOut), [signedOut]);
  if (error) return <Splash text={error} error onRetry={() => setAttempt(a => a + 1)} />;
  if (!auth) return <Splash text={status} />;
  if (!auth.me) return <AuthPage state={auth} onSignedIn={me => setAuth({ ...auth, me, firstAccount: false })} />;
  return (
    <AppProvider key={auth.me.id} backend={backend} me={auth.me} onSignOut={signedOut}>
      <HashRouter>
        <ActionHost>
          <Layout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/artists" element={<Artists />} />
              <Route path="/artists/:id" element={<Dossier />} />
              <Route path="/deduplicate" element={<Deduplicate />} />
              <Route path="/verified" element={<VerifiedArtists />} />
              <Route path="/imports" element={<Imports />} />
              <Route path="/imports/:id" element={<ImportResult />} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* Tools kept inside Settings → More tools */}
              <Route path="/queue" element={<Queue />} />
              <Route path="/routes" element={<RoutesPage />} />
              <Route path="/research" element={<ResearchPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/audit" element={<AuditPage />} />
              {/* v1 addresses */}
              <Route path="/cases" element={<Navigate to="/artists" replace />} />
              <Route path="/cases/:id" element={<ToArtist />} />
              <Route path="/discovery" element={<Navigate to="/artists" replace />} />
              <Route path="/discovery/:id" element={<ToArtist tab="evidence" />} />
              <Route path="/identity" element={<Navigate to="/deduplicate" replace />} />
              <Route path="/reopened" element={<Navigate to="/artists?status=REOPENED" replace />} />
              <Route path="/claims" element={<Navigate to="/verified" replace />} />
              <Route path="*" element={<Empty title="Page not found." text="Use the menu on the left." />} />
            </Routes>
          </Layout>
        </ActionHost>
      </HashRouter>
    </AppProvider>
  );
}

function Splash({ text, error, onRetry }: { text: string; error?: boolean; onRetry?: () => void }) {
  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="max-w-md text-center">
        <div className="brand-mark mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl text-md font-bold">AF</div>
        {error && <p className="mb-1 text-lg font-semibold text-ink">ArtistFinder cannot start</p>}
        <p className={error ? 'text-sm text-ink-2' : 'text-sm text-muted'}>{text}</p>
        {error && <code className="mt-3 block whitespace-pre rounded-lg border border-line bg-surface px-3 py-2 text-left font-mono text-xs text-ink-2">docker compose up --build</code>}
        {onRetry && <button type="button" onClick={onRetry} className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-accent bg-accent px-4 text-sm font-semibold text-accent-ink hover:bg-accent-hover">Try again</button>}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Boot /></StrictMode>);
