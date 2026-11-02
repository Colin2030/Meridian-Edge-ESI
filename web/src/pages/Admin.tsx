import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Users, FolderPlus, Plus, ShieldCheck, UserCog, Pencil, Trash2, X, AlertTriangle } from 'lucide-react';

interface SysUser { id: number; username: string; email: string; display_name: string; is_system_admin: boolean; active: boolean; created_at: string; }
interface CaseRow { id: number; name: string; case_number: string | null; description: string | null; status: string; }

export default function Admin() {
  const [tab, setTab] = useState<'users' | 'cases'>('users');
  const [users, setUsers] = useState<SysUser[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // new user form
  const [nu, setNu] = useState({ username: '', password: '', displayName: '', email: '', isSystemAdmin: false });
  // new case form
  const [nc, setNc] = useState({ name: '', caseNumber: '', description: '' });
  // edit / delete modal targets
  const [editing, setEditing] = useState<CaseRow | null>(null);
  const [deleting, setDeleting] = useState<CaseRow | null>(null);

  const loadUsers = () => api.get<SysUser[]>('/api/admin/users').then(setUsers);
  const loadCases = () => api.get<CaseRow[]>('/api/cases').then(setCases);
  useEffect(() => { loadUsers(); loadCases(); }, []);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setMsg('');
    try {
      await api.post('/api/admin/users', nu);
      setMsg(`User "${nu.username}" created.`); setNu({ username: '', password: '', displayName: '', email: '', isSystemAdmin: false }); loadUsers();
    } catch (e: any) { setErr(e.message); }
  };
  const toggleActive = async (u: SysUser) => { await api.put(`/api/admin/users/${u.id}`, { active: !u.active }); loadUsers(); };
  const createCase = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setMsg('');
    try { await api.post('/api/admin/cases', nc); setMsg(`Case "${nc.name}" created.`); setNc({ name: '', caseNumber: '', description: '' }); loadCases(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-8">
      <div className="flex items-center gap-2 mb-1"><ShieldCheck className="text-accent" size={22} /><h1 className="text-2xl font-bold text-navy-900">Administration</h1></div>
      <p className="text-sm text-slate-500 mb-6">Manage investigator accounts and cases. Assign users to cases from each case's settings panel.</p>

      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 w-fit mb-5">
        {([['users', 'Users', Users], ['cases', 'Cases', FolderPlus]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => { setTab(k); setErr(''); setMsg(''); }} className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium ${tab === k ? 'bg-white shadow-sm text-navy-900' : 'text-slate-500'}`}>
            <Icon size={15} />{label}
          </button>
        ))}
      </div>

      {msg && <div className="mb-4 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">{msg}</div>}
      {err && <div className="mb-4 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}

      {tab === 'users' && (
        <div className="grid lg:grid-cols-[1fr_340px] gap-6">
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-50 text-left text-xs uppercase text-slate-500"><th className="px-4 py-3">Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3"><div className="font-medium text-navy-900">{u.display_name}</div><div className="text-xs text-slate-400">{u.email || '—'}</div></td>
                    <td className="text-slate-600">{u.username}</td>
                    <td>{u.is_system_admin ? <span className="badge bg-navy-900 text-white">System admin</span> : <span className="badge bg-slate-100 text-slate-600">Standard</span>}</td>
                    <td>{u.active ? <span className="badge bg-emerald-100 text-emerald-700">Active</span> : <span className="badge bg-rose-100 text-rose-700">Disabled</span>}</td>
                    <td className="text-right pr-4"><button onClick={() => toggleActive(u)} className="btn-ghost text-xs text-slate-500">{u.active ? 'Disable' : 'Enable'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form onSubmit={createUser} className="card p-5 h-fit">
            <div className="flex items-center gap-2 mb-4 text-navy-900"><UserCog size={18} className="text-accent" /><h3 className="font-semibold">Create user</h3></div>
            <div className="space-y-3">
              <div><label className="label">Display name</label><input className="input" value={nu.displayName} onChange={(e) => setNu({ ...nu, displayName: e.target.value })} required /></div>
              <div><label className="label">Username</label><input className="input" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} required /></div>
              <div><label className="label">Email</label><input className="input" type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></div>
              <div><label className="label">Password</label><input className="input" type="text" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required /></div>
              <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={nu.isSystemAdmin} onChange={(e) => setNu({ ...nu, isSystemAdmin: e.target.checked })} /> System administrator</label>
              <button className="btn-primary w-full"><Plus size={15} /> Create user</button>
            </div>
          </form>
        </div>
      )}

      {tab === 'cases' && (
        <div className="grid lg:grid-cols-[1fr_340px] gap-6">
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-50 text-left text-xs uppercase text-slate-500"><th className="px-4 py-3">Case</th><th>Reference</th><th>Status</th><th className="text-right pr-4">Actions</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 font-medium text-navy-900">{c.name}</td>
                    <td className="text-slate-500">{c.case_number || '—'}</td>
                    <td><span className="badge bg-slate-100 text-slate-600 capitalize">{c.status || 'open'}</span></td>
                    <td className="pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setEditing(c); setErr(''); setMsg(''); }} className="btn-ghost text-xs text-slate-600" title="Edit case"><Pencil size={14} /> Edit</button>
                        <a href={`/cases/${c.id}`} className="btn-ghost text-xs text-accent-dark">Open →</a>
                        <button onClick={() => { setDeleting(c); setErr(''); setMsg(''); }} className="btn-ghost text-xs text-rose-500 hover:bg-rose-50" title="Delete case"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {cases.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-slate-400">No cases yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <form onSubmit={createCase} className="card p-5 h-fit">
            <div className="flex items-center gap-2 mb-4 text-navy-900"><FolderPlus size={18} className="text-accent" /><h3 className="font-semibold">Create case</h3></div>
            <div className="space-y-3">
              <div><label className="label">Case name</label><input className="input" value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} required /></div>
              <div><label className="label">Reference / number</label><input className="input" value={nc.caseNumber} onChange={(e) => setNc({ ...nc, caseNumber: e.target.value })} /></div>
              <div><label className="label">Description</label><textarea className="input" rows={3} value={nc.description} onChange={(e) => setNc({ ...nc, description: e.target.value })} /></div>
              <button className="btn-primary w-full"><Plus size={15} /> Create case</button>
            </div>
          </form>
        </div>
      )}

      {editing && (
        <EditCaseModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setCases((cs) => cs.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)));
            setEditing(null);
            setMsg(`Case "${updated.name}" updated.`);
          }}
        />
      )}

      {deleting && (
        <DeleteCaseModal
          row={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(id, name) => {
            setCases((cs) => cs.filter((c) => c.id !== id));
            setDeleting(null);
            setMsg(`Case "${name}" and all its data were permanently deleted.`);
          }}
        />
      )}
    </div>
  );
}

// ---- Edit case modal -------------------------------------------------------
function EditCaseModal({ row, onClose, onSaved }: { row: CaseRow; onClose: () => void; onSaved: (c: CaseRow) => void }) {
  const [name, setName] = useState(row.name);
  const [caseNumber, setCaseNumber] = useState(row.case_number || '');
  const [description, setDescription] = useState(row.description || '');
  const [status, setStatus] = useState(row.status || 'open');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Case name cannot be empty.'); return; }
    setBusy(true); setErr('');
    try {
      const updated = await api.put<CaseRow>(`/api/cases/${row.id}`, {
        name: name.trim(), caseNumber: caseNumber.trim(), description, status,
      });
      onSaved(updated);
    } catch (e: any) { setErr(e.message || 'Failed to save'); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <form onSubmit={save}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-navy-900 flex items-center gap-2"><Pencil size={18} className="text-accent" /> Edit case</h3>
          <button type="button" onClick={onClose} className="btn-ghost"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div><label className="label">Case name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div><label className="label">Reference / number</label><input className="input" value={caseNumber} onChange={(e) => setCaseNumber(e.target.value)} /></div>
          <div><label className="label">Description</label><textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div><label className="label">Status</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          {err && <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-outline">Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Delete case modal (friction-ful: type the name to confirm) ------------
function DeleteCaseModal({ row, onClose, onDeleted }: { row: CaseRow; onClose: () => void; onDeleted: (id: number, name: string) => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const matches = confirmText.trim() === row.name.trim();

  const del = async () => {
    if (!matches) return;
    setBusy(true); setErr('');
    try {
      await api.del(`/api/admin/cases/${row.id}`);
      onDeleted(row.id, row.name);
    } catch (e: any) { setErr(e.message || 'Failed to delete'); setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-rose-700 flex items-center gap-2"><AlertTriangle size={18} /> Delete case</h3>
        <button type="button" onClick={onClose} className="btn-ghost"><X size={16} /></button>
      </div>
      <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-800">
        <p className="font-semibold">This permanently removes the entire case.</p>
        <p className="mt-1">All of its <strong>documents, page images, review states, bookmarks, tags, folders, comments, memberships and import history</strong> will be deleted. This action cannot be undone.</p>
      </div>
      <div className="mt-4">
        <label className="label">Type the case name <span className="font-bold text-navy-900">{row.name}</span> to confirm</label>
        <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={row.name} autoFocus autoComplete="off" />
      </div>
      {err && <div className="mt-3 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn-outline">Cancel</button>
        <button
          type="button"
          onClick={del}
          disabled={!matches || busy}
          className="btn bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Trash2 size={15} /> {busy ? 'Deleting…' : 'Permanently delete'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Small modal shell -----------------------------------------------------
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal-950/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md card p-6" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
