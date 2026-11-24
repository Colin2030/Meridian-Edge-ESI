import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Image as ImageIcon, UploadCloud, RotateCcw } from 'lucide-react';
import stackedLogo from '../assets/brand/meridian-logo-stacked-inverted.png';

interface LogoStatus {
  set: boolean;
  url?: string;
  mime?: string;
  filename?: string;
  uploadedAt?: string;
}

function fmtDateTime(s?: string): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function BrandingPanel() {
  const [status, setStatus] = useState<LogoStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  // cache-buster so the preview refreshes immediately after a change
  const [v, setV] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.get<LogoStatus>('/api/admin/branding/login-logo').then((s) => { setStatus(s); setV(Date.now()); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const upload = async (f: File | null) => {
    if (!f) return;
    setErr(''); setMsg(''); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('logo', f);
      const res = await fetch('/api/admin/branding/login-logo', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) {
        let m = res.statusText;
        try { const j = await res.json(); m = j.error || m; } catch { /* ignore */ }
        throw new Error(m);
      }
      const s = await res.json();
      setStatus(s); setV(Date.now());
      setMsg('Login logo updated. It now appears on the sign-in page.');
      if (fileRef.current) fileRef.current.value = '';
    } catch (e: any) {
      setErr(e.message || 'Could not upload the logo.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      const s = await api.del<LogoStatus>('/api/admin/branding/login-logo');
      setStatus(s); setV(Date.now());
      setMsg('Reverted to the bundled Meridian Edge logo.');
      if (fileRef.current) fileRef.current.value = '';
    } catch (e: any) {
      setErr(e.message || 'Could not reset the logo.');
    } finally {
      setBusy(false);
    }
  };

  const usingCustom = !!status?.set;
  // Preview on the same charcoal treatment the login panel uses, so admins see it in context.
  const previewSrc = usingCustom && status?.url ? `${status.url}?v=${v}` : stackedLogo;

  return (
    <div className="space-y-6 max-w-2xl">
      {err && <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {msg && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">{msg}</div>}

      <div className="card p-6">
        <div className="flex items-center gap-2 text-navy-900 mb-1"><ImageIcon size={18} className="text-accent" /><h3 className="text-base font-bold">Login page logo</h3></div>
        <p className="text-sm text-slate-500 mb-4">
          Replace the logo shown on the sign-in page for this deployment. The logo appears centred on a dark charcoal
          background, so a light/white (transparent) logo works best. Cosmetic branding only — it changes nothing about the
          view-only review platform.
        </p>

        {/* Current logo preview, rendered on charcoal to match the login screen */}
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
            Current logo {usingCustom ? <span className="badge bg-accent/15 text-accent-dark ml-1">Custom</span> : <span className="badge bg-slate-100 text-slate-600 ml-1">Default</span>}
          </div>
          <div className="rounded-lg bg-charcoal-900 p-8 flex flex-col items-center justify-center">
            <img src={previewSrc} alt="Login logo preview" className="max-h-28 w-auto max-w-[280px] object-contain" />
            <p className="mt-4 text-sm tracking-wide text-slate-200">ESI Review Platform</p>
          </div>
          {usingCustom && (
            <p className="text-xs text-slate-400 mt-2">
              {status?.filename} · {status?.mime} · uploaded {fmtDateTime(status?.uploadedAt)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
            disabled={busy}
            onChange={(e) => upload(e.target.files?.[0] || null)}
            className="block text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-navy-900 hover:file:bg-slate-200"
          />
          <button type="button" onClick={() => fileRef.current?.click()} className="btn-primary" disabled={busy}>
            <UploadCloud size={15} /> {busy ? 'Uploading…' : usingCustom ? 'Replace logo' : 'Upload logo'}
          </button>
          {usingCustom && (
            <button type="button" onClick={reset} className="btn-outline" disabled={busy}>
              <RotateCcw size={15} /> Reset to default
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-3">Accepted: PNG, JPEG or SVG · maximum 2 MB.</p>
      </div>
    </div>
  );
}
