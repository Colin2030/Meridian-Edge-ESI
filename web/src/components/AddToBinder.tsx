import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { X, FolderPlus, Loader2, BookMarked, CircleUser } from 'lucide-react';

interface BinderSummary { id: number; name: string; doc_count: number; assignee_name: string | null; }
interface Member { id: number; display_name: string; username: string; role: string; }

/**
 * Add-to-binder chooser — pick an existing binder or create a new one inline,
 * then add the selected documents. `resolveIds` is called on confirm so a
 * "select all matching" selection can be resolved to ids lazily.
 */
export function AddToBinder({ caseId, count, resolveIds, onClose, onAdded }: {
  caseId: number | string;
  count: number;
  resolveIds: () => Promise<number[]>;
  onClose: () => void;
  onAdded: (result: { added: number; skipped: number; binderName: string }) => void;
}) {
  const [binders, setBinders] = useState<BinderSummary[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [targetId, setTargetId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<BinderSummary[]>(`/api/cases/${caseId}/binders`)
      .then((r) => { setBinders(r); if (r.length === 0) setMode('new'); })
      .catch(() => setMode('new'));
    api.get<Member[]>(`/api/cases/${caseId}/binders/assignees`).then(setMembers).catch(() => {});
  }, [caseId]);

  const confirm = async () => {
    setErr(''); setBusy(true);
    try {
      let binderId = targetId;
      let binderName = binders.find((b) => b.id === targetId)?.name || '';
      if (mode === 'new') {
        const name = newName.trim();
        if (!name) { setErr('Please enter a name for the new binder.'); setBusy(false); return; }
        const created = await api.post<{ id: number; name: string }>(`/api/cases/${caseId}/binders`, {
          name, assignedTo: newAssignee || undefined,
        });
        binderId = created.id; binderName = created.name;
      }
      if (!binderId) { setErr('Please choose a binder.'); setBusy(false); return; }
      const ids = await resolveIds();
      if (ids.length === 0) { setErr('No documents to add.'); setBusy(false); return; }
      const result = await api.post<{ added: number; skipped: number }>(
        `/api/cases/${caseId}/binders/${binderId}/documents`, { documentIds: ids }
      );
      onAdded({ added: result.added, skipped: result.skipped, binderName });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not add documents to the binder.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 sm:p-8" onMouseDown={onClose}>
      <div className="card w-full max-w-lg p-6 mt-4" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <BookMarked size={22} className="text-accent shrink-0 mt-0.5" />
            <div>
              <h2 className="text-lg font-bold text-navy-900">Add to binder</h2>
              <p className="text-sm text-slate-500">{count} document{count === 1 ? '' : 's'} selected</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" title="Close"><X size={20} /></button>
        </div>

        {/* mode toggle */}
        <div className="mt-4 flex gap-1 rounded-lg bg-slate-100 p-1 w-fit">
          <button onClick={() => setMode('existing')} disabled={binders.length === 0}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${mode === 'existing' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            Existing binder
          </button>
          <button onClick={() => setMode('new')}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${mode === 'new' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            New binder
          </button>
        </div>

        {mode === 'existing' ? (
          <div className="mt-4">
            {binders.length === 0 ? (
              <p className="text-sm text-slate-400 py-3">No binders yet — create one.</p>
            ) : (
              <div className="max-h-64 overflow-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                {binders.map((b) => (
                  <label key={b.id} className="flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-slate-50 select-none">
                    <input type="radio" name="binder" className="h-4 w-4 text-accent focus:ring-accent"
                      checked={targetId === b.id} onChange={() => setTargetId(b.id)} />
                    <span className="font-medium text-navy-900 flex-1">{b.name}</span>
                    {b.assignee_name && <span className="text-xs text-slate-400 inline-flex items-center gap-1"><CircleUser size={13} />{b.assignee_name}</span>}
                    <span className="text-xs text-slate-400">{b.doc_count} doc{b.doc_count === 1 ? '' : 's'}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <span className="label">Binder name</span>
              <input className="input" placeholder="e.g. Review batch A" value={newName}
                autoFocus onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div>
              <span className="label">Assign to (optional)</span>
              <select className="input" value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name} ({m.role.replace('_', ' ')})</option>)}
              </select>
              <p className="text-xs text-slate-400 mt-1">Allocate this binder to a case member to review.</p>
            </div>
          </div>
        )}

        {err && <div className="mt-4 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-slate-500">Cancel</button>
          <button onClick={confirm} disabled={busy} className="btn-primary">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FolderPlus size={16} />} Add to binder
          </button>
        </div>
      </div>
    </div>
  );
}
