import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
// Single swappable brand image. To change the login logo later, point this one
// import at a different asset (e.g. a stacked/vertical lockup) — nothing else needs editing.
import brandLogo from '../assets/brand/meridian-logo-horizontal-inverted.png';

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
    <div className="min-h-screen flex flex-col items-center bg-[#202020] text-white px-6">
      {/* subtle brand wash, very understated */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 22% 18%, #3b6ea5 0, transparent 40%), radial-gradient(circle at 80% 72%, #4d4d4d 0, transparent 46%)',
        }}
      />

      {/* Main centred column */}
      <div className="relative flex flex-1 flex-col items-center justify-center w-full py-12">
        {/* Large centred logo block */}
        <div className="flex flex-col items-center text-center">
          <img
            src={brandLogo}
            alt="Meridian Edge"
            className="w-[72vw] max-w-[400px] h-auto object-contain select-none"
            draggable={false}
          />
          <h1 className="mt-6 text-2xl sm:text-3xl font-semibold uppercase tracking-[0.42em] text-slate-200">
            <span className="pl-[0.42em]">ESI Review</span>
          </h1>
        </div>

        {/* Sign-in card */}
        <div className="mt-12 w-full max-w-sm">
          <div className="rounded-xl border border-white/10 bg-[#2c2c2c] p-8 shadow-xl shadow-black/30">
            <h2 className="text-base font-semibold text-white">Sign in</h2>
            <p className="mt-1 text-sm text-slate-400">Enter your investigator credentials to continue.</p>

            <form onSubmit={submit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="username" className="block text-xs font-semibold uppercase tracking-wide text-slate-300 mb-1.5">
                  Username
                </label>
                <input
                  id="username"
                  className="w-full rounded-md border border-white/15 bg-[#202020] px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-[#3b6ea5] focus:outline-none focus:ring-2 focus:ring-[#3b6ea5]/40"
                  value={username}
                  onChange={(e) => setU(e.target.value)}
                  autoFocus
                  autoComplete="username"
                />
              </div>
              <div>
                <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wide text-slate-300 mb-1.5">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  className="w-full rounded-md border border-white/15 bg-[#202020] px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-[#3b6ea5] focus:outline-none focus:ring-2 focus:ring-[#3b6ea5]/40"
                  value={password}
                  onChange={(e) => setP(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              {err && (
                <div role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {err}
                </div>
              )}
              <button
                className="w-full rounded-md bg-[#3b6ea5] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#345f8e] focus:outline-none focus:ring-2 focus:ring-[#3b6ea5]/50 focus:ring-offset-2 focus:ring-offset-[#2c2c2c] disabled:opacity-60"
                disabled={busy}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Muted footer */}
      <div className="relative pb-6 text-center text-xs text-slate-500">
        Powered by Meridian Edge Ltd · Authorised use only
      </div>
    </div>
  );
}
