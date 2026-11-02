import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Users, FolderPlus, Plus, ShieldCheck, UserCog } from 'lucide-react';

interface SysUser { id: number; username: string; email: string; display_name: string; is_system_admin: boolean; active: boolean; created_at: string; }
interface CaseRow { id: number; name: string; case_number: string; }

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
              <thead><tr className="bg-slate-50 text-left text-xs uppercase text-slate-500"><th className="px-4 py-3">Case</th><th>Reference</th><th></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {cases.map((c) => (
                  <tr key={c.id}><td className="px-4 py-3 font-medium text-navy-900">{c.name}</td><td className="text-slate-500">{c.case_number || '—'}</td>
                    <td className="text-right pr-4"><a href={`/cases/${c.id}`} className="btn-ghost text-xs text-accent-dark">Open →</a></td></tr>
                ))}
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
    </div>
  );
}
