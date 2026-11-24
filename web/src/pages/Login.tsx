import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Wordmark } from '../components/Logo';
import { Lock } from 'lucide-react';
// Stacked (vertical) white-on-transparent lockup — the default centrepiece of the
// charcoal brand panel when no custom login logo has been configured.
import stackedLogo from '../assets/brand/meridian-logo-stacked-inverted.png';

export default function Login() {
  const { login, user } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  // Return the user to the page they originally requested (e.g. a shared binder URL).
  const dest = (loc.state as { from?: string } | null)?.from || '/';
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Admin-configurable login logo (cosmetic branding). Fetched pre-auth from the
  // public branding endpoint; falls back to the bundled default if unset or if the
  // request fails (e.g. offline / air-gapped first boot).
  const [customLogoUrl, setCustomLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/branding', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (active && j?.loginLogo?.url) setCustomLogoUrl(j.loginLogo.url); })
      .catch(() => { /* degrade gracefully to the bundled default */ });
    return () => { active = false; };
  }, []);

  if (user) { nav(dest, { replace: true }); }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await login(username, password); nav(dest, { replace: true }); }
    catch (e: any) { setErr(e.message || 'Login failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen grid md:grid-cols-2">
      {/* Brand panel (charcoal) — hidden below md */}
      <div className="hidden md:flex flex-col justify-between bg-charcoal-900 p-12 text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, #3b6ea5 0, transparent 42%), radial-gradient(circle at 80% 70%, #4d4d4d 0, transparent 45%)' }} />

        {/* top spacer to balance the footer so the centrepiece sits in the true middle */}
        <div className="relative h-6" aria-hidden="true" />

        {/* Centrepiece: logo (custom or bundled default), centred, with the platform caption below */}
        <div className="relative flex flex-col items-center text-center">
          <img
            src={customLogoUrl || stackedLogo}
            alt="Meridian Edge"
            className="w-[70%] max-w-[340px] h-auto object-contain select-none"
            draggable={false}
            // If a configured custom logo fails to load, fall back to the bundled default.
            onError={(e) => { if (customLogoUrl) { setCustomLogoUrl(null); (e.currentTarget as HTMLImageElement).src = stackedLogo; } }}
          />
          <p className="mt-6 text-lg tracking-wide text-slate-200">ESI Review Platform</p>
        </div>

        <div className="relative text-center text-xs text-slate-400">Powered by Meridian Edge - Authorised use only</div>
      </div>

      {/* Form panel (light) */}
      <div className="flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-sm">
          {/* Mobile/narrow: logo + platform caption above the card (dark-on-light treatment) */}
          <div className="md:hidden mb-8 flex flex-col items-center gap-2">
            {customLogoUrl
              ? <img src={customLogoUrl} alt="Meridian Edge" className="h-12 w-auto object-contain" draggable={false} onError={() => setCustomLogoUrl(null)} />
              : <Wordmark />}
            <p className="text-sm tracking-wide text-slate-500">ESI Review Platform</p>
          </div>
          <div className="card p-8">
            <div className="mb-6">
              <div className="flex items-center gap-2 text-navy-900"><Lock size={18} className="text-accent" /><h2 className="text-lg font-bold">Sign in</h2></div>
              <p className="mt-1 text-sm text-slate-500">Enter your investigator credentials to continue.</p>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label">Username</label>
                <input className="input" value={username} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" />
              </div>
              <div>
                <label className="label">Password</label>
                <input className="input" type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
              </div>
              {err && <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}
              <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
