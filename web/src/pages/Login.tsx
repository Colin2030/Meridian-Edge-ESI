import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Wordmark } from '../components/Logo';
import { ShieldCheck, Lock } from 'lucide-react';
// Stacked (vertical) white-on-transparent lockup — the centrepiece of the charcoal brand panel.
import stackedLogo from '../assets/brand/meridian-logo-stacked-inverted.png';

export default function Login() {
  const { login, user } = useAuth();
  const nav = useNavigate();
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) { nav('/'); }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await login(username, password); nav('/'); }
    catch (e: any) { setErr(e.message || 'Login failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Brand panel (charcoal) — hidden below lg */}
      <div className="hidden lg:flex flex-col justify-between bg-charcoal-900 p-12 text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, #3b6ea5 0, transparent 42%), radial-gradient(circle at 80% 70%, #4d4d4d 0, transparent 45%)' }} />

        {/* top spacer to balance the footer so the centrepiece sits in the true middle */}
        <div className="relative h-6" aria-hidden="true" />

        {/* Centrepiece: large stacked logo, centred, with supporting copy below */}
        <div className="relative flex flex-col items-center text-center">
          <img
            src={stackedLogo}
            alt="Meridian Edge"
            className="w-[70%] max-w-[340px] h-auto object-contain select-none"
            draggable={false}
          />
          <div className="mt-12 max-w-md">
            <h1 className="text-3xl font-bold leading-tight">Review electronically stored information with clarity and control.</h1>
            <p className="mt-4 text-slate-300 leading-relaxed">
              A calm, defensible environment for investigators to load, search, view and review Concordance-format evidence —
              built for secure and air-gapped networks.
            </p>
            <ul className="mt-8 inline-block text-left space-y-3 text-sm text-slate-300">
              <li className="flex items-center gap-2"><ShieldCheck size={18} className="text-accent-light" /> Per-case role-based access control</li>
              <li className="flex items-center gap-2"><ShieldCheck size={18} className="text-accent-light" /> Full audit trail for law-enforcement defensibility</li>
              <li className="flex items-center gap-2"><ShieldCheck size={18} className="text-accent-light" /> Zero external runtime dependencies</li>
            </ul>
          </div>
        </div>

        <div className="relative text-center text-xs text-slate-400">Powered by Meridian Edge Ltd · Authorised use only</div>
      </div>

      {/* Form panel (light) */}
      <div className="flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-sm">
          {/* Mobile/narrow: dark-on-light logo above the card (charcoal icon + wordmark) */}
          <div className="lg:hidden mb-8 flex justify-center"><Wordmark /></div>
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
          <p className="mt-4 text-center text-xs text-slate-400">Meridian Edge · ESI Review Platform</p>
        </div>
      </div>
    </div>
  );
}
