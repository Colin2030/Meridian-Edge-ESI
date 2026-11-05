import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { BadgeCheck, AlertTriangle, ShieldX, UploadCloud, Users, CalendarClock, FileKey } from 'lucide-react';

interface LicenceStatus {
  installed: boolean;
  valid: boolean;
  expired: boolean;
  customer: string | null;
  seats: number | null;
  seatsUsed: number;
  seatsRemaining: number | null;
  issuedAt: string | null;
  validFrom: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  licenceId: string | null;
  reason?: string;
  publicKeyFingerprint?: string;
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function LicencePanel() {
  const [status, setStatus] = useState<LicenceStatus | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.get<LicenceStatus>('/api/admin/licence').then(setStatus).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const onFile = async (f: File | null) => {
    if (!f) return;
    const content = await f.text();
    setText(content);
  };

  const install = async () => {
    setErr(''); setMsg('');
    if (!text.trim()) { setErr('Paste a licence file or choose a .melic file first.'); return; }
    setBusy(true);
    try {
      const s = await api.post<LicenceStatus>('/api/admin/licence', { licence: text });
      setStatus(s);
      setMsg(`Licence installed for ${s.customer} — ${s.seats} seats, expires ${fmtDate(s.expiresAt)}.`);
      setText('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (e: any) {
      setErr(e.message || 'Could not install the licence.');
    } finally {
      setBusy(false);
    }
  };

  const StatusBadge = () => {
    if (!status) return null;
    if (!status.installed) return <span className="badge bg-slate-200 text-slate-700 inline-flex items-center gap-1"><ShieldX size={13} /> No licence</span>;
    if (status.valid) return <span className="badge bg-emerald-100 text-emerald-700 inline-flex items-center gap-1"><BadgeCheck size={13} /> Valid</span>;
    if (status.expired) return <span className="badge bg-rose-100 text-rose-700 inline-flex items-center gap-1"><AlertTriangle size={13} /> Expired</span>;
    return <span className="badge bg-rose-100 text-rose-700 inline-flex items-center gap-1"><AlertTriangle size={13} /> Invalid</span>;
  };

  const seatPct = status && status.seats ? Math.min(100, Math.round((status.seatsUsed / status.seats) * 100)) : 0;
  const seatBarColour = seatPct >= 100 ? 'bg-rose-500' : seatPct >= 85 ? 'bg-amber-500' : 'bg-accent';

  return (
    <div className="space-y-6">
      {err && <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {msg && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">{msg}</div>}

      {/* Current licence */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-navy-900"><FileKey size={18} className="text-accent" /><h3 className="text-base font-bold">Current licence</h3></div>
          <StatusBadge />
        </div>

        {status && !status.installed && (
          <p className="text-sm text-slate-500">No licence is installed. Only system administrators can sign in until a valid licence is uploaded below.</p>
        )}

        {status && status.installed && (
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">Customer</div>
              <div className="text-sm font-medium text-navy-900">{status.customer}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">Licence ID</div>
              <div className="text-sm font-mono text-slate-600 break-all">{status.licenceId}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-400 mb-1"><Users size={13} /> Seats used</div>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full ${seatBarColour}`} style={{ width: `${seatPct}%` }} />
                </div>
                <div className="text-sm font-medium text-navy-900 whitespace-nowrap">{status.seatsUsed} / {status.seats}</div>
              </div>
              {status.seatsRemaining !== null && (
                <div className="text-xs text-slate-500 mt-1">{status.seatsRemaining} seat{status.seatsRemaining === 1 ? '' : 's'} remaining</div>
              )}
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">Issued</div>
              <div className="text-sm text-slate-700">{fmtDate(status.issuedAt)}</div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-400"><CalendarClock size={13} /> Expires</div>
              <div className="text-sm text-slate-700">
                {fmtDate(status.expiresAt)}
                {status.daysRemaining !== null && (
                  <span className={`ml-2 ${status.daysRemaining < 0 ? 'text-rose-600' : status.daysRemaining < 30 ? 'text-amber-600' : 'text-slate-400'}`}>
                    ({status.daysRemaining < 0 ? `${Math.abs(status.daysRemaining)} days ago` : `${status.daysRemaining} days left`})
                  </span>
                )}
              </div>
            </div>
            {status.reason && !status.valid && (
              <div className="sm:col-span-2 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{status.reason}</div>
            )}
          </div>
        )}

        {status?.publicKeyFingerprint && (
          <div className="mt-5 pt-4 border-t border-slate-100 text-xs text-slate-400">
            Verification key fingerprint: <span className="font-mono">{status.publicKeyFingerprint}</span>
          </div>
        )}
      </div>

      {/* Upload */}
      <div className="card p-6">
        <div className="flex items-center gap-2 text-navy-900 mb-1"><UploadCloud size={18} className="text-accent" /><h3 className="text-base font-bold">Install or renew licence</h3></div>
        <p className="text-sm text-slate-500 mb-4">Upload a <span className="font-mono">.melic</span> licence file issued by Meridian Edge, or paste its contents below.</p>

        <div className="flex items-center gap-3 mb-3">
          <input ref={fileRef} type="file" accept=".melic,text/plain" onChange={(e) => onFile(e.target.files?.[0] || null)}
            className="block text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-navy-900 hover:file:bg-slate-200" />
        </div>

        <textarea
          className="input font-mono text-xs h-36 resize-y"
          placeholder={'-----BEGIN MERIDIAN EDGE LICENCE-----\n…\n-----END MERIDIAN EDGE LICENCE-----'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="mt-4">
          <button className="btn-primary" onClick={install} disabled={busy}>{busy ? 'Installing…' : 'Install licence'}</button>
        </div>
      </div>
    </div>
  );
}
