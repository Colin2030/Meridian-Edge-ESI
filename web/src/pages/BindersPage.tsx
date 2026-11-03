import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { ChevronLeft, BookMarked, FolderPlus, Users, Pencil, Trash2, X, Loader2, FileStack, CircleUser } from 'lucide-react';

interface Binder {
  id: number; name: string; description: string | null;
  assigned_to: number | null; created_by: number; created_at: string; updated_at: string;
  doc_count: number; assignee_name: string | null; creator_name: string | null;
}
interface Member { id: number; display_name: string; username: string; role: string; }
interface CaseInfo { id: number; name: string; case_number: string; role: string; }

export default function BindersPage() {
  const { caseId } = useParams();
  const [info, setInfo] = useState<CaseInfo | null>(null);
  const [binders, setBinders] = useState<Binder[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Binder | null>(null);

  const role = info?.role;
  const canManage = role === 'system_admin' || role === 'case_manager';
  const canEdit = canManage || role === 'reviewer';

  const load = useCallback(() => {
    setLoading(true);
    api.get<Binder[]>(`/api/cases/${caseId}/binders`)
      .then(setBinders).catch(() => setBinders([])).finally(() => setLoading(false));
  }, [caseId]);

  useEffect(() => {
    api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo);
    load();
  }, [caseId, load]);

  useEffect(() => {
    if (canEdit) api.get<Member[]>(`/api/cases/${caseId}/binders/assignees`).then(setMembers).catch(() => {});
  }, [caseId, canEdit]);

  const remove = async (b: Binder) => {
    if (!window.confirm(`Delete binder '${b.name}'? The documents themselves are not deleted.`)) return;
    try { await api.del(`/api/cases/${caseId}/binders/${b.id}`); load(); }
    catch (e) { window.alert(e instanceof ApiError ? e.message : 'Could not delete binder.'); }
  };

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <Link to={`/cases/${caseId}/review`} className="text-sm text-slate-400 hover:text-slate-600 flex items-center gap-1"><ChevronLeft size={14} /> Document review</Link>
          <h1 className="text-2xl font-bold text-navy-900 mt-1 flex items-center gap-2"><BookMarked size={22} className="text-accent" /> Binders</h1>
          <p className="text-sm text-slate-500">{info?.name} · {info?.case_number} · group documents and allocate them for review</p>
        </div>
        {canEdit && (
          <button onClick={() => { setEditing(null); setShowForm(true); }} className="btn-primary"><FolderPlus size={16} /> New binder</button>
        )}
      </div>

      {loading ? (
        <div className="card p-16 text-center text-slate-400"><Loader2 className="mx-auto mb-2 animate-spin" size={26} /> Loading binders…</div>
      ) : binders.length === 0 ? (
        <div className="card p-14 text-center">
          <BookMarked className="mx-auto mb-3 text-slate-300" size={34} />
          <h2 className="text-lg font-semibold text-navy-900">No binders yet</h2>
          <p className="text-sm text-slate-500 mt-1 mb-4">Binders group documents together so they can be allocated to a reviewer and shared.</p>
          {canEdit && <button onClick={() => { setEditing(null); setShowForm(true); }} className="btn-primary mx-auto"><FolderPlus size={16} /> New binder</button>}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5">Binder</th>
                <th className="px-4 py-2.5">Documents</th>
                <th className="px-4 py-2.5">Assigned to</th>
                <th className="px-4 py-2.5">Created</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {binders.map((b) => (
                <tr key={b.id} className="hover:bg-accent/[0.03] transition">
                  <td className="px-4 py-3">
                    <Link to={`/cases/${caseId}/binders/${b.id}`} className="font-semibold text-navy-900 hover:text-accent-dark">{b.name}</Link>
                    {b.description && <div className="text-xs text-slate-500 max-w-md truncate">{b.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-slate-600"><span className="inline-flex items-center gap-1.5"><FileStack size={14} className="text-slate-400" />{b.doc_count}</span></td>
                  <td className="px-4 py-3 text-slate-600">
                    {b.assignee_name
                      ? <span className="inline-flex items-center gap-1.5"><CircleUser size={14} className="text-accent" />{b.assignee_name}</span>
                      : <span className="text-slate-400">Unassigned</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                    <div>{fmtDateTime(b.created_at)}</div>
                    {b.creator_name && <div className="text-xs text-slate-400">by {b.creator_name}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Link to={`/cases/${caseId}/binders/${b.id}`} className="btn-ghost text-slate-500 text-xs">Open</Link>
                      {canEdit && <button onClick={() => { setEditing(b); setShowForm(true); }} className="btn-ghost text-slate-500" title="Edit / assign"><Pencil size={15} /></button>}
                      {canEdit && <button onClick={() => remove(b)} className="btn-ghost text-rose-500 hover:text-rose-600" title="Delete (creator or case manager)"><Trash2 size={15} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <BinderForm
          caseId={caseId!}
          members={members}
          binder={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
        />
      )}
    </div>
  );
}

function BinderForm({ caseId, members, binder, onClose, onSaved }: {
  caseId: string; members: Member[]; binder: Binder | null; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(binder?.name || '');
  const [description, setDescription] = useState(binder?.description || '');
  const [assignedTo, setAssignedTo] = useState(binder?.assigned_to ? String(binder.assigned_to) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!name.trim()) { setErr('A binder name is required.'); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), description: description.trim() || null, assignedTo: assignedTo || null };
      if (binder) await api.patch(`/api/cases/${caseId}/binders/${binder.id}`, body);
      else await api.post(`/api/cases/${caseId}/binders`, body);
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not save binder.'); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 sm:p-8" onMouseDown={onClose}>
      <div className="card w-full max-w-lg p-6 mt-8" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold text-navy-900 flex items-center gap-2"><BookMarked size={20} className="text-accent" /> {binder ? 'Edit binder' : 'New binder'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <span className="label">Binder name</span>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Review batch A" />
          </div>
          <div>
            <span className="label">Description (optional)</span>
            <textarea className="input min-h-[72px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this binder is for…" />
          </div>
          <div>
            <span className="label flex items-center gap-1.5"><Users size={14} /> Assign to (optional)</span>
            <select className="input" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name} ({m.role.replace('_', ' ')})</option>)}
            </select>
            <p className="text-xs text-slate-400 mt-1">Allocate this binder to a case member to review.</p>
          </div>
        </div>
        {err && <div className="mt-4 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-slate-500">Cancel</button>
          <button onClick={save} disabled={busy} className="btn-primary">{busy ? <Loader2 size={16} className="animate-spin" /> : <BookMarked size={16} />} {binder ? 'Save changes' : 'Create binder'}</button>
        </div>
      </div>
    </div>
  );
}
