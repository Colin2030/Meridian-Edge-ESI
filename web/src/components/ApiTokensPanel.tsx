import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { KeyRound, Plus, Copy, Check, Trash2, AlertTriangle, ShieldCheck } from 'lucide-react';

interface SysUser { id: number; username: string; display_name: string; active: boolean; }
interface TokenRow {
  id: number; userId: number; name: string; prefix: string;
  ownerName: string; ownerUsername: string; createdByName: string | null;
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null; revoked: boolean;
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}

// API token management (system-admin area). Create a token for any user, view the
// raw value exactly once, list existing tokens, and revoke. The raw token is
// never retrievable after creation.
export default function ApiTokensPanel({ users }: { users: SysUser[] }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [issued, setIssued] = useState<{ token: string; name: string; owner: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => api.get<TokenRow[]>('/api/tokens').then(setTokens).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setMsg(''); setIssued(null); setCopied(false);
    if (!name.trim()) { setErr('Please give the token a name.'); return; }
    if (!ownerId) { setErr('Choose the user the token will act as.'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ token: string; name: string; prefix: string; ownerId: number }>(
        '/api/tokens', { name: name.trim(), userId: parseInt(ownerId, 10) }
      );
      const owner = users.find((u) => u.id === r.ownerId);
      setIssued({ token: r.token, name: r.name, owner: owner ? owner.display_name : `user ${r.ownerId}` });
      setName(''); setOwnerId('');
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const revoke = async (t: TokenRow) => {
    if (!confirm(`Revoke token "${t.name}" (${t.prefix}…) for ${t.ownerName}? Any integration using it will stop working immediately.`)) return;
    setErr(''); setMsg('');
    try { await api.del(`/api/tokens/${t.id}`); setMsg(`Token "${t.name}" revoked.`); await load(); }
    catch (e: any) { setErr(e.message); }
  };

  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.token); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* ignore */ }
  };

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-6">
      <div className="space-y-4">
        {msg && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">{msg}</div>}
        {err && <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}

        {issued && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div className="flex items-center gap-2 text-amber-800 font-semibold text-sm mb-1"><AlertTriangle size={16} /> Copy this token now — it will not be shown again</div>
            <p className="text-xs text-amber-700 mb-3">New token for <strong>{issued.owner}</strong> ({issued.name}). Store it securely; Meridian Edge keeps only a hash and cannot recover it.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-white border border-amber-200 px-3 py-2 font-mono text-sm text-navy-900 break-all">{issued.token}</code>
              <button onClick={copy} className="btn-outline whitespace-nowrap">{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        )}

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-slate-50 text-left text-xs uppercase text-slate-500"><th className="px-4 py-3">Token</th><th>Owner</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {tokens.map((t) => (
                <tr key={t.id} className={t.revoked ? 'bg-slate-50/60' : ''}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-navy-900">{t.name}</div>
                    <div className="font-mono text-xs text-slate-400">{t.prefix}…</div>
                  </td>
                  <td className="text-slate-600">{t.ownerName}<div className="text-xs text-slate-400">{t.ownerUsername}</div></td>
                  <td className="text-slate-500 text-xs">{fmt(t.createdAt)}{t.createdByName ? <div className="text-slate-400">by {t.createdByName}</div> : null}</td>
                  <td className="text-slate-500 text-xs">{fmt(t.lastUsedAt)}</td>
                  <td>{t.revoked ? <span className="badge bg-rose-100 text-rose-700">Revoked</span> : <span className="badge bg-emerald-100 text-emerald-700">Active</span>}</td>
                  <td className="pr-4 text-right">
                    {!t.revoked && <button onClick={() => revoke(t)} className="btn-ghost text-xs text-rose-500 hover:bg-rose-50" title="Revoke"><Trash2 size={14} /> Revoke</button>}
                  </td>
                </tr>
              ))}
              {tokens.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">No API tokens yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-4">
        <form onSubmit={create} className="card p-5 h-fit">
          <div className="flex items-center gap-2 mb-4 text-navy-900"><KeyRound size={18} className="text-accent" /><h3 className="font-semibold">Create API token</h3></div>
          <div className="space-y-3">
            <div>
              <label className="label">Token name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Forensics ingest pipeline" required />
            </div>
            <div>
              <label className="label">Acts as user</label>
              <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required>
                <option value="">Choose a user…</option>
                {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>)}
              </select>
              <p className="text-[11px] text-slate-400 mt-1">The token inherits this user's permissions and per-case roles.</p>
            </div>
            <button className="btn-primary w-full" disabled={busy}><Plus size={15} /> {busy ? 'Creating…' : 'Create token'}</button>
          </div>
        </form>

        <div className="card p-5 text-xs text-slate-500 space-y-2">
          <div className="flex items-center gap-2 text-navy-900 font-semibold text-sm"><ShieldCheck size={15} className="text-accent" /> About API tokens</div>
          <p>Tokens let an external system feed pre-processed ESI loadfile packages into a case programmatically and check status, using the public API at <code className="text-accent-dark">/api/v1</code>.</p>
          <p>Send the token as <code className="text-accent-dark">Authorization: Bearer me_live_…</code>. A token acts with its owner's permissions, so grant the owning user only the case access they need.</p>
          <p>The full developer guide is in <code className="text-accent-dark">docs/API.md</code> in the repository.</p>
        </div>
      </div>
    </div>
  );
}
