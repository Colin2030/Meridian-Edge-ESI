import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { FolderOpen, FileText, CheckCircle2, Bookmark, ArrowRight, ShieldCheck, FolderPlus, Plus, X, Archive } from 'lucide-react';

interface CaseRow {
  id: number; name: string; case_number: string; description: string; status: string; created_at: string;
  doc_count: number; reviewed_count: number; bookmark_count: number; role: string;
}

const roleLabel: Record<string, string> = {
  system_admin: 'System admin', case_manager: 'Case manager', reviewer: 'Reviewer', read_only: 'Read only',
};
const roleCls: Record<string, string> = {
  system_admin: 'bg-navy-900 text-white', case_manager: 'bg-accent/15 text-accent-dark',
  reviewer: 'bg-sky-100 text-sky-700', read_only: 'bg-slate-100 text-slate-600',
};

export default function Dashboard() {
  const { user } = useAuth();
  const loc = useLocation();
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [flash, setFlash] = useState<string>((loc.state as any)?.flash || '');

  const canCreate = !!(user?.isSystemAdmin || user?.canCreateCases);

  useEffect(() => {
    setLoading(true);
    api.get<CaseRow[]>(`/api/cases${showArchived ? '?includeArchived=1' : ''}`)
      .then(setCases).finally(() => setLoading(false));
  }, [showArchived]);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Cases</h1>
          <p className="text-sm text-slate-500 mt-1">Investigations you have been granted access to.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowArchived((s) => !s)} className={`btn-outline ${showArchived ? 'border-accent text-accent-dark bg-accent/5' : ''}`} title="Show or hide archived cases">
            <Archive size={16} /> {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          {canCreate && (
            <button onClick={() => setCreating(true)} className="btn-primary"><FolderPlus size={16} /> New case</button>
          )}
          {user?.isSystemAdmin && (
            <Link to="/admin" className="btn-outline"><ShieldCheck size={16} /> Manage cases & users</Link>
          )}
        </div>
      </div>

      {flash && (
        <div className="mb-5 flex items-start justify-between gap-3 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
          <span>{flash}</span>
          <button onClick={() => setFlash('')} className="opacity-70 hover:opacity-100"><X size={15} /></button>
        </div>
      )}

      {creating && <NewCaseModal onClose={() => setCreating(false)} />}

      {loading ? (
        <div className="text-slate-400 py-20 text-center">Loading cases…</div>
      ) : cases.length === 0 ? (
        <div className="card p-12 text-center text-slate-500">
          <FolderOpen className="mx-auto mb-3 text-slate-300" size={40} />
          No cases are currently assigned to you.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {cases.map((c) => {
            const pct = c.doc_count ? Math.round((c.reviewed_count / c.doc_count) * 100) : 0;
            return (
              <Link key={c.id} to={`/cases/${c.id}`} className={`card p-5 hover:shadow-panel hover:border-accent/40 transition group ${c.status === 'archived' ? 'bg-slate-50/70 border-dashed' : ''}`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy-900/5 text-navy-900"><FolderOpen size={20} /></span>
                    <div>
                      <div className="font-semibold text-navy-900 leading-tight group-hover:text-accent-dark transition flex items-center gap-1.5">
                        {c.name}
                        {c.status === 'archived' && <span className="badge bg-amber-100 text-amber-700"><Archive size={11} /> Archived</span>}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">{c.case_number || '—'} · opened {fmtDate(c.created_at)}</div>
                    </div>
                  </div>
                  <span className={`badge ${roleCls[c.role] || 'bg-slate-100 text-slate-600'}`}>{roleLabel[c.role] || c.role}</span>
                </div>
                {c.description && <p className="mt-3 text-sm text-slate-500 line-clamp-2">{c.description}</p>}
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-slate-50 py-2">
                    <div className="flex items-center justify-center gap-1 text-navy-900 font-semibold"><FileText size={14} />{c.doc_count}</div>
                    <div className="text-[11px] text-slate-400">Documents</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 py-2">
                    <div className="flex items-center justify-center gap-1 text-emerald-700 font-semibold"><CheckCircle2 size={14} />{pct}%</div>
                    <div className="text-[11px] text-slate-400">Reviewed</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 py-2">
                    <div className="flex items-center justify-center gap-1 text-accent-dark font-semibold"><Bookmark size={14} />{c.bookmark_count}</div>
                    <div className="text-[11px] text-slate-400">Bookmarks</div>
                  </div>
                </div>
                <div className="mt-4 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-4 flex items-center justify-end text-sm font-medium text-accent-dark opacity-0 group-hover:opacity-100 transition">
                  Open workspace <ArrowRight size={15} className="ml-1" />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Create-case modal, shown to system admins and users granted the global
// "can create cases" capability. Posts to /api/cases (which both roles may use)
// and navigates the creator into their new case, where they are now the
// case manager and can add data.
function NewCaseModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [caseNumber, setCaseNumber] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Case name is required.'); return; }
    setBusy(true); setErr('');
    try {
      const c = await api.post<{ id: number }>('/api/cases', { name: name.trim(), caseNumber: caseNumber.trim(), description: description.trim() });
      nav(`/cases/${c.id}`);
    } catch (e: any) { setErr(e?.message || 'Could not create the case.'); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal-950/60 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-md card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-navy-900 flex items-center gap-2"><FolderPlus size={18} className="text-accent" /> New case</h3>
          <button type="button" onClick={onClose} className="btn-ghost"><X size={16} /></button>
        </div>
        <p className="text-xs text-slate-500 mb-4">You will become the case manager of this case and can add data to it straight away.</p>
        {err && <div className="mb-3 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <div className="space-y-3">
          <div><label className="label">Case name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required /></div>
          <div><label className="label">Reference / number</label><input className="input" value={caseNumber} onChange={(e) => setCaseNumber(e.target.value)} placeholder="optional" /></div>
          <div><label className="label">Description</label><textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" /></div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost" disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}><Plus size={15} /> {busy ? 'Creating…' : 'Create case'}</button>
        </div>
      </form>
    </div>
  );
}
