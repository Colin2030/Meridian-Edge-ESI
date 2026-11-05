import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Users, FolderPlus, Plus, ShieldCheck, UserCog, Pencil, Trash2, X, AlertTriangle, KeyRound, Power, Shield, Copy, Check, FileKey } from 'lucide-react';
import ApiTokensPanel from '../components/ApiTokensPanel';
import LicencePanel from '../components/LicencePanel';

interface SysUser { id: number; username: string; email: string; display_name: string; is_system_admin: boolean; can_create_cases: boolean; active: boolean; created_at: string; }
interface CaseRow { id: number; name: string; case_number: string | null; description: string | null; status: string; }

export default function Admin() {
  const [tab, setTab] = useState<'users' | 'cases' | 'tokens' | 'licence'>('users');
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
  const [editingUser, setEditingUser] = useState<SysUser | null>(null);

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
  const toggleActive = async (u: SysUser) => {
    setErr(''); setMsg('');
    try {
      const updated = await api.put<SysUser>(`/api/admin/users/${u.id}/active`, { active: !u.active });
      setUsers((us) => us.map((x) => (x.id === updated.id ? updated : x)));
      setMsg(`${updated.display_name} is now ${updated.active ? 'active' : 'inactive'}.`);
    } catch (e: any) { setErr(e.message); }
  };
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
        {([['users', 'Users', Users], ['cases', 'Cases', FolderPlus], ['tokens', 'API tokens', KeyRound], ['licence', 'Licence', FileKey]] as const).map(([k, label, Icon]) => (
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
                  <tr key={u.id} className={u.active ? '' : 'bg-slate-50/60'}>
                    <td className="px-4 py-3"><div className="font-medium text-navy-900">{u.display_name}</div><div className="text-xs text-slate-400">{u.email || '—'}</div></td>
                    <td className="text-slate-600">{u.username}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        {u.is_system_admin ? <span className="badge bg-navy-900 text-white">System admin</span> : <span className="badge bg-slate-100 text-slate-600">Standard</span>}
                        {!u.is_system_admin && u.can_create_cases && <span className="badge bg-accent/15 text-accent-dark" title="May create cases">Can create cases</span>}
                      </div>
                    </td>
                    <td>{u.active ? <span className="badge bg-emerald-100 text-emerald-700">Active</span> : <span className="badge bg-rose-100 text-rose-700">Inactive</span>}</td>
                    <td className="pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setEditingUser(u); setErr(''); setMsg(''); }} className="btn-ghost text-xs text-slate-600" title="Edit user"><Pencil size={14} /> Edit</button>
                        <button onClick={() => toggleActive(u)} className="btn-ghost text-xs text-slate-500" title={u.active ? 'Deactivate' : 'Activate'}>{u.active ? 'Deactivate' : 'Activate'}</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">No users yet.</td></tr>}
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

      {tab === 'tokens' && <ApiTokensPanel users={users} />}
      {tab === 'licence' && <LicencePanel />}

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

      {editingUser && (
        <EditUserModal
          user={editingUser}
          cases={cases}
          onClose={() => setEditingUser(null)}
          onChanged={(updated) => {
            setUsers((us) => us.map((u) => (u.id === updated.id ? updated : u)));
            setEditingUser(updated);
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

// ---- Edit user modal -------------------------------------------------------
interface Membership { case_id: number; role: string; case_name: string; case_number: string | null; }
const ROLE_LABEL: Record<string, string> = { case_manager: 'Case manager', reviewer: 'Reviewer', read_only: 'Read only' };

function EditUserModal({ user, cases, onClose, onChanged }: { user: SysUser; cases: CaseRow[]; onClose: () => void; onChanged: (u: SysUser) => void }) {
  const [displayName, setDisplayName] = useState(user.display_name);
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // password reset
  const [newPw, setNewPw] = useState('');
  const [tempPw, setTempPw] = useState('');
  const [copied, setCopied] = useState(false);

  // memberships
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [addCaseId, setAddCaseId] = useState('');
  const [addRole, setAddRole] = useState('reviewer');

  const loadMemberships = () => api.get<Membership[]>(`/api/admin/users/${user.id}/memberships`).then(setMemberships);
  useEffect(() => { loadMemberships(); }, [user.id]);

  const flash = (m: string) => { setMsg(m); setErr(''); };
  const fail = (e: any) => { setErr(e?.message || 'Request failed'); setMsg(''); };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) { setErr('Display name cannot be empty.'); return; }
    if (!username.trim()) { setErr('Username cannot be empty.'); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      const u = await api.put<SysUser>(`/api/admin/users/${user.id}`, { displayName: displayName.trim(), username: username.trim(), email: email.trim() });
      onChanged(u); flash('Profile saved.');
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  };

  const setPassword = async () => {
    if (newPw.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setBusy(true); setErr(''); setMsg(''); setTempPw('');
    try {
      await api.post(`/api/admin/users/${user.id}/reset-password`, { newPassword: newPw });
      setNewPw(''); flash(`Password reset for ${user.display_name}.`);
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  };

  const genPassword = async () => {
    setBusy(true); setErr(''); setMsg(''); setTempPw(''); setCopied(false);
    try {
      const r = await api.post<{ temporaryPassword: string }>(`/api/admin/users/${user.id}/reset-password`, { generate: true });
      setTempPw(r.temporaryPassword); flash('Temporary password generated — share it securely; it is shown only once.');
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  };

  const copyTemp = async () => { try { await navigator.clipboard.writeText(tempPw); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ } };

  const toggleAdmin = async () => {
    if (!confirm(user.is_system_admin ? `Remove system administrator access from ${user.display_name}?` : `Grant system administrator access to ${user.display_name}?`)) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const u = await api.put<SysUser>(`/api/admin/users/${user.id}/role`, { isSystemAdmin: !user.is_system_admin });
      onChanged(u); flash(u.is_system_admin ? 'Promoted to system administrator.' : 'System administrator access removed.');
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  };

  const toggleCanCreateCases = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const u = await api.put<SysUser>(`/api/admin/users/${user.id}/can-create-cases`, { value: !user.can_create_cases });
      onChanged(u); flash(u.can_create_cases ? 'This user can now create cases.' : 'Case-creation permission removed.');
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  };

  const toggleActive = async () => {
    if (!confirm(user.active ? `Deactivate ${user.display_name}? They will be unable to log in.` : `Reactivate ${user.display_name}?`)) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const u = await api.put<SysUser>(`/api/admin/users/${user.id}/active`, { active: !user.active });
      onChanged(u); flash(u.active ? 'Account reactivated.' : 'Account deactivated.');
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  };

  const addMembership = async () => {
    const cid = parseInt(addCaseId, 10);
    if (!cid) { setErr('Choose a case to add.'); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      await api.post(`/api/admin/users/${user.id}/memberships`, { caseId: cid, role: addRole });
      setAddCaseId(''); await loadMemberships(); flash('Case access updated.');
    } catch (e: any) { fail(e); } finally { setBusy(false); }
  };

  const changeRole = async (caseId: number, role: string) => {
    setErr(''); setMsg('');
    try { await api.post(`/api/admin/users/${user.id}/memberships`, { caseId, role }); await loadMemberships(); flash('Role updated.'); }
    catch (e: any) { fail(e); }
  };

  const removeMembership = async (caseId: number) => {
    setErr(''); setMsg('');
    try { await api.del(`/api/admin/users/${user.id}/memberships/${caseId}`); await loadMemberships(); flash('Removed from case.'); }
    catch (e: any) { fail(e); }
  };

  const available = cases.filter((c) => !memberships.some((m) => m.case_id === c.id));

  return (
    <Modal onClose={onClose} size="lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-navy-900 flex items-center gap-2"><UserCog size={18} className="text-accent" /> Edit user</h3>
        <button type="button" onClick={onClose} className="btn-ghost"><X size={16} /></button>
      </div>

      {msg && <div className="mb-3 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">{msg}</div>}
      {err && <div className="mb-3 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{err}</div>}

      <div className="max-h-[70vh] overflow-y-auto pr-1 space-y-5">
        {/* Profile */}
        <form onSubmit={saveProfile} className="rounded-lg border border-slate-200 p-4">
          <div className="text-sm font-semibold text-navy-900 mb-3">Profile</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div><label className="label">Display name</label><input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
            <div><label className="label">Username</label><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></div>
            <div className="sm:col-span-2"><label className="label">Email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" /></div>
          </div>
          <div className="mt-3 flex justify-end"><button type="submit" className="btn-primary" disabled={busy}>Save profile</button></div>
        </form>

        {/* Password reset */}
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="text-sm font-semibold text-navy-900 mb-1 flex items-center gap-2"><KeyRound size={15} className="text-accent" /> Reset password</div>
          <p className="text-xs text-slate-500 mb-3">Sets a new password for this user immediately. Their current password stops working.</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[180px]"><label className="label">New password (min 8 chars)</label><input className="input" type="text" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="off" placeholder="Type a password" /></div>
            <button type="button" onClick={setPassword} className="btn-outline" disabled={busy}>Set password</button>
            <button type="button" onClick={genPassword} className="btn-outline" disabled={busy}>Generate temporary</button>
          </div>
          {tempPw && (
            <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
              <div className="text-xs text-amber-800 mb-1">Temporary password (shown once — share securely):</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-white border border-amber-200 px-2 py-1 font-mono text-sm text-navy-900 break-all">{tempPw}</code>
                <button type="button" onClick={copyTemp} className="btn-ghost text-xs text-accent-dark" title="Copy">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
              </div>
            </div>
          )}
        </div>

        {/* Global role + activation */}
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="text-sm font-semibold text-navy-900 mb-3 flex items-center gap-2"><Shield size={15} className="text-accent" /> Access</div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">Global role:</span>
              {user.is_system_admin ? <span className="badge bg-navy-900 text-white">System admin</span> : <span className="badge bg-slate-100 text-slate-600">Standard</span>}
              <button type="button" onClick={toggleAdmin} className="btn-ghost text-xs text-accent-dark" disabled={busy}>{user.is_system_admin ? 'Remove admin' : 'Make admin'}</button>
            </div>
            <div className="h-5 w-px bg-slate-200" />
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">Status:</span>
              {user.active ? <span className="badge bg-emerald-100 text-emerald-700">Active</span> : <span className="badge bg-rose-100 text-rose-700">Inactive</span>}
              <button type="button" onClick={toggleActive} className="btn-ghost text-xs text-slate-600 flex items-center gap-1" disabled={busy}><Power size={13} /> {user.active ? 'Deactivate' : 'Activate'}</button>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-sm border-t border-slate-100 pt-3">
            <span className="text-slate-600">Can create cases:</span>
            {user.is_system_admin ? (
              <span className="badge bg-slate-100 text-slate-500" title="System administrators can always create cases">Always (system admin)</span>
            ) : (
              <>
                {user.can_create_cases ? <span className="badge bg-accent/15 text-accent-dark">Yes</span> : <span className="badge bg-slate-100 text-slate-600">No</span>}
                <button type="button" onClick={toggleCanCreateCases} className="btn-ghost text-xs text-accent-dark" disabled={busy}>{user.can_create_cases ? 'Revoke' : 'Grant'}</button>
              </>
            )}
          </div>
        </div>

        {/* Case memberships */}
        <div className="rounded-lg border border-slate-200 p-4">
          <div className="text-sm font-semibold text-navy-900 mb-3 flex items-center gap-2"><FolderPlus size={15} className="text-accent" /> Case access</div>
          {memberships.length === 0 && <p className="text-xs text-slate-400 mb-3">Not a member of any case.</p>}
          <div className="space-y-2 mb-3">
            {memberships.map((m) => (
              <div key={m.case_id} className="flex items-center gap-2">
                <div className="flex-1 text-sm text-navy-900">{m.case_name}{m.case_number ? <span className="text-slate-400"> · {m.case_number}</span> : null}</div>
                <select className="input !w-auto !py-1 text-xs" value={m.role} onChange={(e) => changeRole(m.case_id, e.target.value)}>
                  {Object.keys(ROLE_LABEL).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <button type="button" onClick={() => removeMembership(m.case_id)} className="btn-ghost text-xs text-rose-500" title="Remove"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          {available.length > 0 && (
            <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <div className="flex-1 min-w-[160px]"><label className="label">Add to case</label>
                <select className="input" value={addCaseId} onChange={(e) => setAddCaseId(e.target.value)}>
                  <option value="">Choose a case…</option>
                  {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div><label className="label">Role</label>
                <select className="input" value={addRole} onChange={(e) => setAddRole(e.target.value)}>
                  {Object.keys(ROLE_LABEL).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </div>
              <button type="button" onClick={addMembership} className="btn-outline" disabled={busy}><Plus size={14} /> Add</button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex justify-end"><button type="button" onClick={onClose} className="btn-primary">Done</button></div>
    </Modal>
  );
}

// ---- Small modal shell -----------------------------------------------------
function Modal({ children, onClose, size = 'md' }: { children: React.ReactNode; onClose: () => void; size?: 'md' | 'lg' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal-950/60 p-4" onClick={onClose}>
      <div className={`w-full ${size === 'lg' ? 'max-w-2xl' : 'max-w-md'} card p-6`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
