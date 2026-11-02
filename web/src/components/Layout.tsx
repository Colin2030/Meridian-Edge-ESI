import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Wordmark } from './Logo';
import { useAuth } from '../lib/auth';
import { LayoutGrid, Shield, LogOut, User } from 'lucide-react';

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const doLogout = async () => { await logout(); nav('/login'); };

  const navItem = (to: string, icon: React.ReactNode, label: string) => {
    const active = loc.pathname === to || (to !== '/' && loc.pathname.startsWith(to));
    return (
      <Link to={to} className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition ${active ? 'bg-navy-800 text-white' : 'text-slate-300 hover:bg-navy-800/60 hover:text-white'}`}>
        {icon}{label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-navy-900 border-b border-navy-800">
        <div className="mx-auto max-w-[1600px] px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/"><Wordmark light /></Link>
            <nav className="hidden md:flex items-center gap-1">
              {navItem('/', <LayoutGrid size={16} />, 'Cases')}
              {user?.isSystemAdmin && navItem('/admin', <Shield size={16} />, 'Administration')}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-sm text-slate-300">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy-700 text-accent-light"><User size={15} /></span>
              <div className="leading-tight">
                <div className="text-white font-medium">{user?.displayName}</div>
                <div className="text-[11px] text-slate-400">{user?.isSystemAdmin ? 'System administrator' : user?.username}</div>
              </div>
            </div>
            <button onClick={doLogout} className="btn-ghost text-slate-300 hover:text-white hover:bg-navy-800" title="Sign out">
              <LogOut size={16} /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full">{children}</main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-[1600px] px-5 py-3 flex items-center justify-between text-xs text-slate-400">
          <span>Powered by <span className="font-semibold text-slate-500">Meridian Edge Ltd</span></span>
          <span>Secure ESI review · For authorised investigators only</span>
        </div>
      </footer>
    </div>
  );
}
