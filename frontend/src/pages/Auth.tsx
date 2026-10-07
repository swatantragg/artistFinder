// Sign in and sign up. A brand-new workspace asks for its first account (the System Owner); after that people sign in,
// or create an account when sign-up is open. The session lives in an httpOnly cookie set by the server.
import { BadgeCheck, CopyCheck, Eye, EyeOff, FileUp, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { account, type AuthState, type Me } from '../api/backend';
import { VERSION } from '../lib/version';
import { Button, Field } from '../components/ui';

type Mode = 'login' | 'signup';

export function AuthPage({ state, onSignedIn }: { state: AuthState; onSignedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<Mode>(state.firstAccount ? 'signup' : 'login');
  const [form, setForm] = useState({ name: '', email: '', password: '', again: '' });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [mode]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const signup = mode === 'signup';
  const mismatch = signup && !!form.again && form.password !== form.again;
  const ready = signup ? !!form.name.trim() && !!form.email.trim() && form.password.length >= 8 && form.password === form.again : !!form.email.trim() && !!form.password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try { onSignedIn(signup ? await account.signup(form.name, form.email, form.password) : await account.login(form.email, form.password)); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };

  const title = signup ? (state.firstAccount ? 'Set up ArtistFinder' : 'Create your account') : 'Sign in';
  const subtitle = signup
    ? state.firstAccount ? 'This is a new workspace. The first account is its System Owner: you can add your team next.' : 'Accounts start as User. An Admin can change your role.'
    : 'Welcome back. Sign in with your work email.';

  return (
    <div className="flex min-h-full flex-col bg-bg lg:flex-row">
      <aside className="relative overflow-hidden border-b border-nav-line bg-nav px-5 py-6 text-nav-text sm:px-8 lg:flex lg:w-[44%] lg:flex-col lg:justify-between lg:border-b-0 lg:border-r lg:px-12 lg:py-12">
        <div aria-hidden className="brand-fill pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-25 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="brand-mark flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-md font-bold shadow-[0_4px_14px_-4px_rgb(137_44_220/0.7)]">AF</span>
          <span className="leading-tight">
            <span className="block text-xl font-semibold text-white">ArtistFinder</span>
            <span className="block text-sm text-nav-muted">Goongoonalo · G Amplify</span>
          </span>
        </div>
        <div className="relative mt-6 hidden lg:block">
          <h2 className="text-3xl font-semibold leading-tight text-white">Find every artist in your catalogue, verify them, and bring them on board.</h2>
          <ul className="mt-8 space-y-4 text-base">
            <Point icon={<FileUp size={18} />} text="Upload your backend export: artists, songs and credits." />
            <Point icon={<Search size={18} />} text="Find each artist’s own profiles: Spotify, YouTube, Instagram and more." />
            <Point icon={<CopyCheck size={18} />} text="Spot duplicate artists before they cause trouble." />
            <Point icon={<BadgeCheck size={18} />} text="Verify artists and track their Goongoonalo status." />
          </ul>
        </div>
        <p className="relative mt-6 hidden text-xs tracking-wide text-nav-muted lg:block">{VERSION}</p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8">
        <div className="w-full max-w-[460px]">
          <h1 className="text-2xl font-semibold text-ink sm:text-3xl">{title}</h1>
          <p className="mt-2 text-base text-muted">{subtitle}</p>

          <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-lg)] sm:p-6" noValidate>
            {signup && (
              <Field label="Your name" required>
                <input className="field" value={form.name} onChange={set('name')} autoComplete="name" autoFocus maxLength={80} placeholder="First and last name" />
              </Field>
            )}
            <Field label="Email" required>
              <input className="field" type="email" value={form.email} onChange={set('email')} autoComplete={signup ? 'email' : 'username'} autoFocus={!signup} placeholder="name@company.com" />
            </Field>
            <Field label="Password" required help={signup ? 'At least 8 characters.' : undefined}>
              <div className="relative">
                <input className="field pr-11" type={show ? 'text' : 'password'} value={form.password} onChange={set('password')} autoComplete={signup ? 'new-password' : 'current-password'} />
                <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted hover:text-ink">
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </Field>
            {signup && (
              <Field label="Password again" required help={mismatch ? <span className="text-[var(--t-red)]">The passwords do not match.</span> : undefined}>
                <input className="field" type={show ? 'text' : 'password'} value={form.again} onChange={set('again')} autoComplete="new-password" />
              </Field>
            )}
            {error && <p role="alert" className="rounded-lg border border-[var(--t-red-bd)] bg-[var(--t-red-bg)] px-3 py-2 text-sm text-[var(--t-red)]">{error}</p>}
            <Button type="submit" variant="primary" loading={busy} disabled={!ready} className="w-full justify-center">
              {signup ? (state.firstAccount ? 'Create owner account' : 'Create account') : 'Sign in'}
            </Button>
          </form>

          {!state.firstAccount && (
            <p className="mt-5 text-center text-sm text-muted">
              {signup ? <>Already have an account? <Switch onClick={() => setMode('login')}>Sign in</Switch></>
                : state.signupOpen ? <>New here? <Switch onClick={() => setMode('signup')}>Create an account</Switch></>
                : 'Need an account? Ask an Admin.'}
            </p>
          )}
          <p className="mt-8 text-center text-2xs tracking-wide text-faint lg:hidden">{VERSION}</p>
        </div>
      </main>
    </div>
  );
}

function Point({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nav-active text-lavender">{icon}</span>
      <span className="pt-1 text-nav-text">{text}</span>
    </li>
  );
}

function Switch({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="font-semibold text-accent-text hover:underline">{children}</button>;
}
