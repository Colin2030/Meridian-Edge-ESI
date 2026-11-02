import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppShell } from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CaseHome from './pages/CaseHome';
import CaseWorkspace from './pages/CaseWorkspace';
import DocumentViewer from './pages/DocumentViewer';
import AddCaseData from './pages/AddCaseData';
import Admin from './pages/Admin';

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="min-h-screen grid place-items-center text-slate-400">Loading…</div>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <AppShell>{children}</AppShell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/cases/:caseId" element={<Protected><CaseHome /></Protected>} />
      <Route path="/cases/:caseId/review" element={<Protected><CaseWorkspace /></Protected>} />
      <Route path="/cases/:caseId/import" element={<Protected><AddCaseData /></Protected>} />
      <Route path="/cases/:caseId/documents/:docId" element={<Protected><DocumentViewer /></Protected>} />
      <Route path="/admin" element={<Protected><Admin /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
