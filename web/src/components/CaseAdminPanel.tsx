import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { X, UserPlus, Tag as TagIcon, ScrollText, Trash2 } from 'lucide-react';

interface Tag { id: number; name: string; colour: string; }
interface Member { user_id: number; role: string; username: string; display_name: string; email: string; }
interface SysUser { id: number; username: string; display_name: string; }

export function CaseAdminPanel({ caseId, tags, onClose, onChange }: { caseId: number; tags: Tag[]; onClose: () => void; onChange: () => void }) {
  const [tab, setTab] = useState<'members' | 'tags' | 'audit'>('members');
  const [members, setMembers] = useState<Member[]>([]);
  const [allUsers, setAllUsers] = useState<SysUser[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [newTag, setNewTag] = useState(''); const [newColour, setNewColour] = useState('#b08d57');
  const [addUser, setAddUser] = useState(''); const [addRole, setAddRole] = useState('reviewer');
  const [err, setErr] = useState('');

  const loadMembers = () => api.get<Member[]>(`/api/cases/${caseId}/members`).then(setMembers).catch(() => {});
  useEffect(() => { loadMembers(); api.get<SysUser[]>('/api/admin/users').then(setAllUsers).catch(() => {}); }, [caseId]);
  useEffect(() => { if (tab === 'audit') api.get<any[]>(`/api/cases/${caseId}/audit`).then(setAudit).catch(() => {}); }, [tab, caseId]);

  const assign = async () => {
    setErr('');
    if (!addUser) return;
    try { await api.post(`/api/cases/${caseId}/members`, { userId: Number(addUser), role: addRole }); setAddUser(''); loadMembers(); }
    catch (e: any) { setErr(e.message); }
  };
  const remove = async (uid: number) => { await api.del(`/api/cases/${caseId}/members/${uid}`); loadMembers(); };
  const createTag = async () => {
    if (!newTag.trim()) return;
    await api.post(`/api/cases/${caseId}/tags`, { name: newTag.trim(), colour: newColour });
    setNewTag(''); onChange();
  };

  return (
    <div className="card p-5 mb-4 border-accent/30">
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {([['members', 'Members', UserPlus], ['tags', 'Tags', TagIcon], ['audit', 'Audit trail', ScrollText]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k)} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${tab === k ? 'bg-white shadow-sm text-navy-900' : 'text-slate-500'}`}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="btn-ghost"><X size={16} /></button>
      </div>

      {tab === 'members' && (
        <div>
          <div className="flex flex-wrap items-end gap-2 mb-4 p-3 rounded-lg bg-slate-50">
            <div><label className="label">User</label>
              <select className="input w-56" value={addUser} onChange={(e) => setAddUser(e.target.value)}>
                <option value="">Select user…</option>
                {allUsers.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>)}
              </select>
            </div>
            <div><label className="label">Role</label>
              <select className="input w-44" value={addRole} onChange={(e) => setAddRole(e.target.value)}>
                <option value="case_manager">Case manager</option>
                <option value="reviewer">Reviewer</option>
                <option value="read_only">Read only</option>
              </select>
            </div>
            <button onClick={assign} className="btn-accent"><UserPlus size={15} /> Assign</button>
            {err && <span className="text-sm text-rose-600">{err}</span>}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-2">Name</th><th>Username</th><th>Role</th><th></th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((m) => (
                <tr key={m.user_id}><td className="py-2">{m.display_name}</td><td className="text-slate-500">{m.username}</td>
                  <td><span className="badge bg-slate-100 text-slate-700">{m.role.replace('_', ' ')}</span></td>
                  <td className="text-right"><button onClick={() => remove(m.user_id)} className="btn-ghost text-rose-500 hover:bg-rose-50"><Trash2 size={14} /></button></td></tr>
              ))}
              {members.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-slate-400">No members assigned yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'tags' && (
        <div>
          <div className="flex items-end gap-2 mb-4 p-3 rounded-lg bg-slate-50">
            <div><label className="label">New tag</label><input className="input w-56" value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Tag name" /></div>
            <div><label className="label">Colour</label><input type="color" className="h-10 w-14 rounded border border-slate-300" value={newColour} onChange={(e) => setNewColour(e.target.value)} /></div>
            <button onClick={createTag} className="btn-accent"><TagIcon size={15} /> Add tag</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => <span key={t.id} className="badge text-white" style={{ backgroundColor: t.colour }}>{t.name}</span>)}
            {tags.length === 0 && <span className="text-slate-400 text-sm">No tags defined.</span>}
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-500 sticky top-0 bg-white"><th className="py-2">When</th><th>User</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {audit.map((a) => (
                <tr key={a.id}><td className="py-2 text-slate-500 whitespace-nowrap">{fmtDateTime(a.created_at)}</td>
                  <td className="text-slate-600">{a.username || '—'}</td><td><span className="badge bg-slate-100 text-slate-700">{a.action}</span></td>
                  <td className="text-slate-500">{a.target || '—'}</td><td className="text-slate-500">{a.detail || '—'}</td></tr>
              ))}
              {audit.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">No audit entries.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
