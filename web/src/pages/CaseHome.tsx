import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import {
  FileText, Mail, Users, ChevronLeft, ArrowRight, UploadCloud, Settings2,
  ListChecks, Tag as TagIcon, FolderOpen, BookMarked,
} from 'lucide-react';

// ---- Types for the ECA metrics payload (GET /api/cases/:caseId/eca) ----------
interface CaseMeta { id: number; name: string; case_number: string | null; description: string | null; status: string; created_at: string; }
interface StatusRow { status: string; label: string; count: number; }
interface TagRow { tagId: number; name: string; colour: string; parentId: number | null; doc_count: number; }
interface CustodianRow { custodian: string; doc_count: number; }
interface DoctypeRow { doctype: string; count: number; }
interface Eca {
  case: CaseMeta;
  role: string;
  metrics: { total_documents: number; email_count: number; custodian_count: number };
  custodians: CustodianRow[];
  doctypes: DoctypeRow[];
  tag_summary: TagRow[];
  status_summary: StatusRow[];
}

// Colour per review status for the proportional bars (pure CSS, air-gapped).
const STATUS_BAR: Record<string, string> = {
  unreviewed: 'bg-slate-300', in_review: 'bg-sky-400', responsive: 'bg-emerald-500',
  non_responsive: 'bg-slate-400', privileged: 'bg-rose-500', further_review: 'bg-amber-500',
};

export default function CaseHome() {
  const { caseId } = useParams();
  const [eca, setEca] = useState<Eca | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAllCustodians, setShowAllCustodians] = useState(false);

  useEffect(() => {
    setLoading(true); setError('');
    api.get<Eca>(`/api/cases/${caseId}/eca`)
      .then(setEca)
      .catch((e) => setError(e?.message || 'This case assessment could not be loaded.'))
      .finally(() => setLoading(false));
  }, [caseId]);

  const reviewHref = `/cases/${caseId}/review`;
  const canManage = eca?.role === 'system_admin' || eca?.role === 'case_manager';

  if (loading) return <div className="min-h-[60vh] grid place-items-center text-slate-400">Loading case assessment…</div>;
  if (error) return (
    <div className="mx-auto max-w-3xl px-5 py-16 text-center">
      <div className="card p-10 text-slate-600">
        <p className="mb-4">{error}</p>
        <Link to="/" className="btn-outline inline-flex"><ChevronLeft size={16} /> All cases</Link>
      </div>
    </div>
  );
  if (!eca) return null;

  const m = eca.metrics;
  const totalDocs = m.total_documents;
  const statusTotal = eca.status_summary.reduce((s, r) => s + r.count, 0) || 1;

  // KPI tiles are rendered from this config array — to add a new headline metric
  // later, add an entry here (and the field to the backend `metrics` object).
  const tiles: { key: string; label: string; value: number; icon: JSX.Element; accent: string; href?: string }[] = [
    { key: 'documents', label: 'Documents', value: totalDocs, icon: <FileText size={22} />, accent: 'text-navy-900', href: reviewHref },
    { key: 'emails', label: 'Emails', value: m.email_count, icon: <Mail size={22} />, accent: 'text-accent-dark' },
    { key: 'custodians', label: 'Custodians', value: m.custodian_count, icon: <Users size={22} />, accent: 'text-emerald-700' },
  ];

  const custodiansToShow = showAllCustodians ? eca.custodians : eca.custodians.slice(0, 8);
  const tagsWithDocs = eca.tag_summary.filter((t) => t.doc_count > 0);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-6">
      {/* header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <Link to="/" className="text-sm text-slate-400 hover:text-slate-600 flex items-center gap-1"><ChevronLeft size={14} /> All cases</Link>
          <div className="flex items-center gap-3 mt-1">
            <h1 className="text-2xl font-bold text-navy-900">{eca.case.name}</h1>
            <span className={`badge ${eca.case.status === 'open' ? 'bg-emerald-100 text-emerald-700' : eca.case.status === 'closed' ? 'bg-slate-200 text-slate-600' : 'bg-amber-100 text-amber-700'}`}>
              {eca.case.status || 'open'}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-0.5">
            {eca.case.case_number || '—'} · opened {fmtDate(eca.case.created_at)} · your role: <span className="font-medium text-slate-700">{(eca.role || '').replace('_', ' ')}</span>
          </p>
          {eca.case.description && <p className="text-sm text-slate-500 mt-2 max-w-3xl">{eca.case.description}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link to={`/cases/${caseId}/binders`} className="btn-outline"><BookMarked size={16} /> Binders</Link>
          {canManage && (
            <>
              <Link to={`/cases/${caseId}/import`} className="btn-outline"><UploadCloud size={16} /> Add case data</Link>
              <Link to={`${reviewHref}?settings=1`} className="btn-outline"><Settings2 size={16} /> Case settings</Link>
            </>
          )}
        </div>
      </div>

      {/* Empty-case friendly state */}
      {totalDocs === 0 ? (
        <div className="card p-12 text-center">
          <FolderOpen className="mx-auto mb-3 text-slate-300" size={44} />
          <h2 className="text-lg font-semibold text-navy-900">No documents yet</h2>
          <p className="text-sm text-slate-500 mt-1 mb-5">Once ESI has been loaded into this case, an assessment summary will appear here.</p>
          <div className="flex items-center justify-center gap-2">
            {canManage && <Link to={`/cases/${caseId}/import`} className="btn-primary"><UploadCloud size={16} /> Add case data</Link>}
            <Link to={reviewHref} className="btn-outline">Open review workspace <ArrowRight size={15} /></Link>
          </div>
        </div>
      ) : (
        <>
          {/* KPI tiles + primary CTA */}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 mb-5">
            {tiles.map((t) => {
              const Inner = (
                <>
                  <span className={`flex h-11 w-11 items-center justify-center rounded-lg bg-slate-50 ${t.accent}`}>{t.icon}</span>
                  <div>
                    <div className="text-2xl font-bold text-navy-900 leading-none">{t.value.toLocaleString('en-GB')}</div>
                    <div className="text-xs text-slate-400 mt-1">{t.label}</div>
                  </div>
                </>
              );
              return t.href ? (
                <Link key={t.key} to={t.href} className="card p-5 flex items-center gap-4 hover:border-accent/40 hover:shadow-panel transition">{Inner}</Link>
              ) : (
                <div key={t.key} className="card p-5 flex items-center gap-4">{Inner}</div>
              );
            })}
            {/* Primary action tile */}
            <Link to={reviewHref} className="card p-5 flex flex-col justify-center bg-navy-900 text-white hover:bg-charcoal-800 transition group">
              <span className="text-sm text-white/70">Ready to begin?</span>
              <span className="mt-1 font-semibold flex items-center gap-2">Start reviewing documents <ArrowRight size={17} className="group-hover:translate-x-0.5 transition" /></span>
            </Link>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {/* Status summary */}
            <section className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-navy-900 flex items-center gap-2"><ListChecks size={17} className="text-accent-dark" /> Status summary</h3>
              </div>
              <div className="space-y-3">
                {eca.status_summary.map((s) => {
                  const pct = Math.round((s.count / statusTotal) * 100);
                  return (
                    <Link key={s.status} to={`${reviewHref}?status=${encodeURIComponent(s.status)}`}
                      className="block group" title={`View ${s.label.toLowerCase()} documents`}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-slate-600 group-hover:text-accent-dark">{s.label}</span>
                        <span className="tabular-nums text-slate-500"><span className="font-semibold text-navy-900">{s.count}</span> · {pct}%</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div className={`h-full ${STATUS_BAR[s.status] || 'bg-accent'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>

            {/* Tag summary */}
            <section className="card p-5">
              <h3 className="font-semibold text-navy-900 flex items-center gap-2 mb-3"><TagIcon size={17} className="text-accent-dark" /> Tag summary</h3>
              {tagsWithDocs.length === 0 ? (
                <p className="text-sm text-slate-400">No documents have been tagged yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {tagsWithDocs.map((t) => (
                    <li key={t.tagId}>
                      <Link to={`${reviewHref}?tagId=${t.tagId}`}
                        className="flex items-center justify-between py-1 px-1 -mx-1 rounded hover:bg-accent/[0.04] group"
                        style={{ paddingLeft: t.parentId ? '1rem' : undefined }}>
                        <span className="flex items-center gap-2 text-sm text-slate-700 group-hover:text-accent-dark">
                          <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: t.colour }} />
                          {t.name}
                        </span>
                        <span className="text-sm font-semibold text-navy-900 tabular-nums">{t.doc_count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Custodians */}
            <section className="card p-5">
              <h3 className="font-semibold text-navy-900 flex items-center gap-2 mb-3"><Users size={17} className="text-accent-dark" /> Custodians</h3>
              {eca.custodians.length === 0 ? (
                <p className="text-sm text-slate-400">No custodian information is recorded for this case.</p>
              ) : (
                <>
                  <ul className="space-y-1.5">
                    {custodiansToShow.map((c) => (
                      <li key={c.custodian} className="flex items-center justify-between text-sm">
                        <span className="text-slate-700 truncate pr-2">{c.custodian}</span>
                        <span className="font-semibold text-navy-900 tabular-nums">{c.doc_count}</span>
                      </li>
                    ))}
                  </ul>
                  {eca.custodians.length > 8 && (
                    <button onClick={() => setShowAllCustodians((s) => !s)} className="btn-ghost text-accent-dark text-sm mt-2 px-0">
                      {showAllCustodians ? 'Show fewer' : `Show all ${eca.custodians.length}`}
                    </button>
                  )}
                </>
              )}
            </section>
          </div>

          {/* Document types — cheap context metric, demonstrates the extensible panel pattern */}
          {eca.doctypes.length > 0 && (
            <section className="card p-5 mt-5">
              <h3 className="font-semibold text-navy-900 flex items-center gap-2 mb-3"><FileText size={17} className="text-accent-dark" /> Document types</h3>
              <div className="flex flex-wrap gap-2">
                {eca.doctypes.map((d) => (
                  <span key={d.doctype} className="badge bg-slate-100 text-slate-700">
                    {d.doctype} <span className="font-bold ml-1">{d.count}</span>
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
