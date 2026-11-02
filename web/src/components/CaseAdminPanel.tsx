import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { X, UserPlus, Tag as TagIcon, ScrollText, Trash2, Plus, CornerDownRight } from 'lucide-react';

interface Tag { id: number; name: string; colour: string; parent_id?: number | null; }
interface Member { user_id: number; role: string; username: string; display_name: string; email: string; }
interface SysUser { id: number; username: string; display_name: string; }

// A tag node with its children, for rendering the hierarchy.
interface TagNode extends Tag { children: TagNode[]; }

function buildTree(tags: Tag[]): TagNode[] {
  const byId = new Map<number, TagNode>();
  tags.forEach((t) => byId.set(t.id, { ...t, children: [] }));
  const roots: TagNode[] = [];
  byId.forEach((node) => {
    const pid = node.parent_id ?? null;
    if (pid && byId.has(pid)) byId.get(pid)!.children.push(node);
    else roots.push(node);
  });
  const sortRec = (nodes: TagNode[]) => { nodes.sort((a, b) => a.name.localeCompare(b.name)); nodes.forEach((n) => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}

export function CaseAdminPanel({ caseId, tags, onClose, onChange }: { caseId: number; tags: Tag[]; onClose: () => void; onChange: () => void }) {
  const [tab, setTab] = useState<'members' | 'tags' | 'audit'>('members');
  const [members, setMembers] = useState<Member[]>([]);
  const [allUsers, setAllUsers] = useState<SysUser[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [addUser, setAddUser] = useState(''); const [addRole, setAddRole] = useState('reviewer');
  const [err, setErr] = useState('');

  // tag tree state
  const [newTag, setNewTag] = useState(''); const [newColour, setNewColour] = useState('#3b6ea5');
  const [addingUnder, setAddingUnder] = useState<number | null>(null); // parent id for inline sub-tag form
  const [subName, setSubName] = useState(''); const [subColour, setSubColour] = useState('#3b6ea5');
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [tagErr, setTagErr] = useState('');

  const tree = buildTree(tags);

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

  const createTopTag = async () => {
    setTagErr('');
    if (!newTag.trim()) return;
    try { await api.post(`/api/cases/${caseId}/tags`, { name: newTag.trim(), colour: newColour }); setNewTag(''); onChange(); }
    catch (e: any) { setTagErr(e.message); }
  };
  const createSubTag = async (parentId: number) => {
    setTagErr('');
    if (!subName.trim()) return;
    try {
      await api.post(`/api/cases/${caseId}/tags`, { name: subName.trim(), colour: subColour, parentId });
      setSubName(''); setSubColour('#3b6ea5'); setAddingUnder(null); onChange();
    } catch (e: any) { setTagErr(e.message); }
  };
  const deleteTag = async (tagId: number) => {
    setTagErr('');
    try { await api.del(`/api/cases/${caseId}/tags/${tagId}`); setPendingDelete(null); onChange(); }
    catch (e: any) { setTagErr(e.message); }
  };

  const renderNode = (node: TagNode, depth: number): JSX.Element => (
    <div key={node.id}>
      <div
        className="group flex items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-slate-50"
        style={{ paddingLeft: depth * 22 + 4 }}
      >
        {depth > 0 && <CornerDownRight size={13} className="text-slate-300 shrink-0" />}
        <span className="badge text-white" style={{ backgroundColor: node.colour }}>{node.name}</span>
        {node.children.length > 0 && <span className="text-xs text-slate-400">({node.children.length} sub-tag{node.children.length > 1 ? 's' : ''})</span>}
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
          <button
            onClick={() => { setAddingUnder(addingUnder === node.id ? null : node.id); setSubName(''); setSubColour('#3b6ea5'); setTagErr(''); }}
            className="btn-ghost px-2 py-1 text-xs text-accent-dark" title="Add a sub-tag under this tag"
          ><Plus size={13} /> Sub-tag</button>
          <button onClick={() => { setPendingDelete(node.id); setTagErr(''); }} className="btn-ghost px-2 py-1 text-rose-500 hover:bg-rose-50" title="Delete tag and its sub-tags"><Trash2 size={13} /></button>
        </div>
      </div>

      {pendingDelete === node.id && (
        <div className="my-1 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm" style={{ marginLeft: depth * 22 + 4 }}>
          <span className="text-rose-800">
            Delete <strong>{node.name}</strong>{node.children.length > 0 ? ' and its sub-tags' : ''}? This removes it from all documents.
          </span>
          <div className="mt-2 flex gap-2">
            <button onClick={() => deleteTag(node.id)} className="btn bg-rose-600 text-white hover:bg-rose-700 px-3 py-1 text-xs"><Trash2 size={12} /> Delete</button>
            <button onClick={() => setPendingDelete(null)} className="btn-outline px-3 py-1 text-xs">Cancel</button>
          </div>
        </div>
      )}

      {addingUnder === node.id && (
        <div className="my-1 flex items-end gap-2 rounded-md bg-slate-50 p-2" style={{ marginLeft: depth * 22 + 20 }}>
          <div><label className="label">Sub-tag of “{node.name}”</label>
            <input className="input w-52" value={subName} autoFocus onChange={(e) => setSubName(e.target.value)} placeholder="Sub-tag name"
              onKeyDown={(e) => { if (e.key === 'Enter') createSubTag(node.id); }} />
          </div>
          <input type="color" className="h-10 w-12 rounded border border-slate-300" value={subColour} onChange={(e) => setSubColour(e.target.value)} />
          <button onClick={() => createSubTag(node.id)} className="btn-accent px-3"><Plus size={14} /> Add</button>
          <button onClick={() => setAddingUnder(null)} className="btn-outline px-3">Cancel</button>
        </div>
      )}

      {node.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );

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
                <option value="">Select user...</option>
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
          <p className="mb-3 text-sm text-slate-500">
            Organise review tags into a hierarchy. Add a top-level tag below, or hover a tag to add a <strong>sub-tag</strong> under it. Deleting a tag also removes its sub-tags.
          </p>
          <div className="flex items-end gap-2 mb-4 p-3 rounded-lg bg-slate-50">
            <div><label className="label">New top-level tag</label>
              <input className="input w-56" value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="Tag name"
                onKeyDown={(e) => { if (e.key === 'Enter') createTopTag(); }} />
            </div>
            <div><label className="label">Colour</label><input type="color" className="h-10 w-14 rounded border border-slate-300" value={newColour} onChange={(e) => setNewColour(e.target.value)} /></div>
            <button onClick={createTopTag} className="btn-accent"><TagIcon size={15} /> Add tag</button>
          </div>
          {tagErr && <div className="mb-3 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{tagErr}</div>}
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {tree.length === 0 && <div className="py-6 text-center text-slate-400 text-sm">No tags defined.</div>}
            {tree.map((node) => <div key={node.id} className="py-0.5">{renderNode(node, 0)}</div>)}
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
