// Sign in and sign up. A brand-new workspace asks for its first account (the System Owner, with the owner setup code
// from the server log); after that people sign in, or ask for an account (an Admin approves it). With two-step sign-in
// a code from the authenticator app follows the password. The session lives in an httpOnly cookie set by the server.
import { BadgeCheck, CheckCircle2, CopyCheck, Eye, EyeOff, FileUp, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { account, type AuthState, type Me } from '../api/backend';
import { VERSION } from '../lib/version';
import { Button, Field } from '../components/ui';

type Mode = 'login' | 'signup' | 'code' | 'requested';

export function AuthPage({ state, onSignedIn }: { state: AuthState; onSignedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<Mode>(state.firstAccount ? 'signup' : 'login');
  const [form, setForm] = useState({ name: '', email: '', password: '', again: '', setupCode: '', website: '', code: '' });
  const [ticket, setTicket] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [notice, setNotice] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [mode]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const min = state.passwordMin || 12;
  const signup = mode === 'signup';
  const needCaptcha = signup && !!state.captchaSiteKey;
  const mismatch = signup && !!form.again && form.password !== form.again;
  const ready = mode === 'code' ? form.code.replace(/[^0-9a-z]/gi, '').length >= 6
    : signup ? !!form.name.trim() && !!form.email.trim() && form.password.length >= min && form.password === form.again && (!state.firstAccount || !!form.setupCode.trim()) && (!needCaptcha || !!captcha)
    : !!form.email.trim() && !!form.password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      if (mode === 'code') { onSignedIn(await account.loginCode(ticket, form.code)); return; }
      if (signup) {
        const r = await account.signup({ name: form.name, email: form.email, password: form.password, setupCode: form.setupCode || undefined, captcha: captcha || undefined, website: form.website });
        if ('me' in r) { onSignedIn(r.me); return; }
        setNotice(r.message); setMode('requested'); setBusy(false); return;
      }
      const r = await account.login(form.email, form.password);
      if ('me' in r) { onSignedIn(r.me); return; }
      setTicket(r.ticket); setForm(f => ({ ...f, code: '' })); setMode('code'); setBusy(false);
    } catch (err) {
      setError((err as Error).message); setBusy(false);
      if (mode === 'code' && /Sign in again/.test((err as Error).message)) setMode('login');
    }
  };

  const title = mode === 'code' ? 'Two-step sign-in' : mode === 'requested' ? 'Request sent' : signup ? (state.firstAccount ? 'Set up ArtistFinder' : 'Ask for an account') : 'Sign in';
  const subtitle = mode === 'code' ? 'Enter the 6-digit code from your authenticator app.'
    : mode === 'requested' ? notice
    : signup ? state.firstAccount ? 'This is a new workspace. The first account is its System Owner: you can add your team next.' : 'An Admin approves each new account. You start as User.'
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
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-ink sm:text-3xl">{mode === 'code' && <ShieldCheck size={26} className="text-accent-text" />}{mode === 'requested' && <CheckCircle2 size={26} className="text-[var(--t-green)]" />}{title}</h1>
          <p className="mt-2 text-base text-muted">{subtitle}</p>

          {mode === 'requested' ? (
            <div className="mt-6 rounded-2xl border border-line bg-surface p-5 text-sm text-ink-2 shadow-[var(--shadow-lg)] sm:p-6">
              <p>You will be able to sign in with <b className="text-ink">{form.email.trim().toLowerCase()}</b> once an Admin has approved the request.</p>
              <Button variant="primary" className="mt-4 w-full justify-center" onClick={() => { setForm(f => ({ ...f, password: '', again: '' })); setMode('login'); }}>Back to sign in</Button>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-lg)] sm:p-6" noValidate>
              {mode === 'code' ? (
                <Field label="Code" required help="Lost the phone? Enter one of your recovery codes (xxxx-xxxx) instead.">
                  <input className="field text-center font-mono text-lg tracking-[0.3em]" value={form.code} onChange={set('code')} inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={12} placeholder="123456" />
                </Field>
              ) : (
                <>
                  {signup && state.firstAccount && (
                    <Field label="Owner setup code" required help="Printed in the server log at start-up (or OWNER_SETUP_TOKEN in .env). Only needed once.">
                      <input className="field font-mono uppercase" value={form.setupCode} onChange={set('setupCode')} autoComplete="off" autoFocus placeholder="XXXX-XXXX-XXXX" />
                    </Field>
                  )}
                  {signup && (
                    <Field label="Your name" required>
                      <input className="field" value={form.name} onChange={set('name')} autoComplete="name" autoFocus={!state.firstAccount} maxLength={80} placeholder="First and last name" />
                    </Field>
                  )}
                  <Field label="Email" required>
                    <input className="field" type="email" value={form.email} onChange={set('email')} autoComplete={signup ? 'email' : 'username'} autoFocus={!signup} placeholder="name@company.com" />
                  </Field>
                  <Field label="Password" required help={signup ? `At least ${min} characters. A few unrelated words work well.` : undefined}>
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
                  {/* Bot trap: people never see or fill this field. */}
                  {signup && <input name="website" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} />}
                  {needCaptcha && <Turnstile siteKey={state.captchaSiteKey!} onToken={setCaptcha} />}
                </>
              )}
              {error && <p role="alert" className="rounded-lg border border-[var(--t-red-bd)] bg-[var(--t-red-bg)] px-3 py-2 text-sm text-[var(--t-red)]">{error}</p>}
              <Button type="submit" variant="primary" loading={busy} disabled={!ready} className="w-full justify-center">
                {mode === 'code' ? 'Verify and sign in' : signup ? (state.firstAccount ? 'Create owner account' : 'Ask for an account') : 'Sign in'}
              </Button>
              {mode === 'code' && <button type="button" onClick={() => setMode('login')} className="w-full text-center text-sm text-muted hover:text-ink">Back</button>}
            </form>
          )}

          {!state.firstAccount && (mode === 'login' || mode === 'signup') && (
            <p className="mt-5 text-center text-sm text-muted">
              {signup ? <>Already have an account? <Switch onClick={() => setMode('login')}>Sign in</Switch></>
                : state.signupOpen ? <>New here? <Switch onClick={() => setMode('signup')}>Ask for an account</Switch></>
                : 'Need an account? Ask an Admin.'}
            </p>
          )}
          <p className="mt-8 text-center text-2xs tracking-wide text-faint lg:hidden">{VERSION}</p>
        </div>
      </main>
    </div>
  );
}

/** Cloudflare Turnstile "I am human" check (only when the server has a site key). */
declare global { interface Window { turnstile?: { render(el: HTMLElement, o: Record<string, unknown>): string; remove(id: string): void } } }
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let id: string | null = null, alive = true;
    const render = () => {
      if (!alive || !ref.current || !window.turnstile) return;
      id = window.turnstile.render(ref.current, { sitekey: siteKey, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'auto', callback: onToken, 'expired-callback': () => onToken(''), 'error-callback': () => onToken('') });
    };
    if (window.turnstile) render();
    else {
      let s = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
      if (!s) { s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.dataset.turnstile = '1'; document.head.appendChild(s); }
      s.addEventListener('load', render);
      s.addEventListener('error', () => setFailed(true));
    }
    return () => { alive = false; if (id && window.turnstile) window.turnstile.remove(id); };
  }, [siteKey, onToken]);
  return <div>{failed ? <p className="text-sm text-[var(--t-red)]">The “I am human” check could not load. Check the connection and reload.</p> : <div ref={ref} className="min-h-[65px]" />}</div>;
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
