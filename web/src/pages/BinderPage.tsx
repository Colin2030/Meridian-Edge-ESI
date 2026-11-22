import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { fmtDate, fmtDateTime, reviewMeta } from '../lib/format';
import { displayName, displayType, displayDate, displaySubject, displayFrom, displayTo } from '../lib/displayFields';
import { ChevronLeft, ChevronRight, BookMarked, Link2, Check, Trash2, FileText, FileType2, CircleUser, Filter } from 'lucide-react';

interface Tag { id: number; name: string; colour: string; }
interface DocRow {
  id: number; control_number: string; native_type: string;
  native_mime?: string | null; native_filename?: string | null; page_count: number;
  metadata: Record<string, string>; review_status: string; tags: Tag[];
}
interface BinderMeta {
  id: number; name: string; description: string | null;
  assigned_to: number | null; assignee_name: string | null;
  created_by: number; creator_name: string | null; created_at: string; updated_at: string;
}
interface CaseInfo { id: number; name: string; case_number: string; role: string; }

export default function BinderPage() {
  const { caseId, binderId } = useParams();
  const [info, setInfo] = useState<CaseInfo | null>(null);
  const [binder, setBinder] = useState<BinderMeta | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const limit = 50;

  const role = info?.role;
  const canEdit = role === 'system_admin' || role === 'case_manager' || role === 'reviewer';

  const load = useCallback(() => {
    setLoading(true);
    api.get<{ binder: BinderMeta; total: number; documents: DocRow[] }>(
      `/api/cases/${caseId}/binders/${binderId}?limit=${limit}&offset=${page * limit}`
    )
      .then((r) => { setBinder(r.binder); setDocs(r.documents); setTotal(r.total); setNotFound(false); })
      .catch((e) => { if (e instanceof ApiError && e.status === 404) setNotFound(true); })
      .finally(() => setLoading(false));
  }, [caseId, binderId, page]);

  useEffect(() => { api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo).catch(() => {}); }, [caseId]);
  useEffect(() => { load(); }, [load]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // Clipboard API unavailable (e.g. no secure context) — fall back to a text selection.
      const ta = document.createElement('textarea');
      ta.value = window.location.href; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 2500);
  };

  const removeDoc = async (d: DocRow) => {
    if (!window.confirm(`Remove ${d.control_number} from this binder? The document itself is not deleted.`)) return;
    try { await api.del(`/api/cases/${caseId}/binders/${binderId}/documents/${d.id}`); load(); }
    catch (e) { window.alert(e instanceof ApiError ? e.message : 'Could not remove document.'); }
  };

  const pages = Math.ceil(total / limit);

  if (notFound) {
    return (
      <div className="mx-auto max-w-[1000px] px-5 py-16 text-center">
        <BookMarked className="mx-auto mb-3 text-slate-300" size={34} />
        <h1 className="text-xl font-bold text-navy-900">Binder not found</h1>
        <p className="text-sm text-slate-500 mt-1">This binder does not exist in this case, or you do not have access.</p>
        <Link to={`/cases/${caseId}/binders`} className="btn-outline mx-auto mt-4"><ChevronLeft size={15} /> Back to binders</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <Link to={`/cases/${caseId}/binders`} className="text-sm text-slate-400 hover:text-slate-600 flex items-center gap-1"><ChevronLeft size={14} /> All binders</Link>
          <h1 className="text-2xl font-bold text-navy-900 mt-1 flex items-center gap-2"><BookMarked size={22} className="text-accent shrink-0" /> {binder?.name || 'Loading…'}</h1>
          {binder?.description && <p className="text-sm text-slate-600 mt-1 max-w-3xl">{binder.description}</p>}
          <p className="text-sm text-slate-500 mt-1">
            {info?.name} · {total} document{total === 1 ? '' : 's'}
            {binder?.assignee_name
              ? <> · assigned to <span className="font-medium text-navy-900 inline-flex items-center gap-1"><CircleUser size={13} className="text-accent" />{binder.assignee_name}</span></>
              : <> · <span className="text-slate-400">unassigned</span></>}
            {binder?.creator_name && <> · created by {binder.creator_name} on {fmtDateTime(binder.created_at)}</>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button onClick={copyLink} className="btn-outline" title="Copy a link to this binder">
            {copied ? <><Check size={16} className="text-emerald-500" /> Link copied</> : <><Link2 size={16} /> Copy link</>}
          </button>
          <span className="text-xs text-slate-400 max-w-[220px] text-right">Share this binder — the recipient needs access to this case.</span>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2.5">Control #</th>
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">From / To</th>
              <th className="px-3 py-2.5">Subject</th>
              <th className="px-3 py-2.5">Type</th>
              <th className="px-3 py-2.5">Pages</th>
              <th className="px-3 py-2.5">Tags</th>
              <th className="px-3 py-2.5">Review</th>
              {canEdit && <th className="px-3 py-2.5"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={canEdit ? 9 : 8} className="py-16 text-center text-slate-400">Loading…</td></tr>
            ) : docs.length === 0 ? (
              <tr><td colSpan={canEdit ? 9 : 8} className="py-16 text-center text-slate-400"><Filter className="mx-auto mb-2 text-slate-300" size={28} />This binder has no documents yet.</td></tr>
            ) : docs.map((d) => {
              const m = d.metadata || {};
              const rm = reviewMeta(d.review_status);
              const nameVal = displayName(m, d.control_number);
              const fromVal = displayFrom(m);
              const toVal = displayTo(m);
              const subjVal = displaySubject(m);
              return (
                <tr key={d.id} className="hover:bg-accent/[0.03] transition">
                  <td className="px-3 py-2.5">
                    <Link to={`/cases/${caseId}/documents/${d.id}`} className="font-medium text-navy-900 hover:text-accent-dark">{nameVal}</Link>
                    {nameVal !== d.control_number && <div className="text-xs text-slate-400 truncate max-w-[220px]" title={d.control_number}>{d.control_number}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDate(displayDate(m))}</td>
                  <td className="px-3 py-2.5 text-slate-600 max-w-[200px] truncate" title={`${fromVal || ''} → ${toVal || ''}`}>
                    <div className="truncate">{fromVal || '—'}</div>
                    <div className="truncate text-xs text-slate-400">{toVal || ''}</div>
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 max-w-[260px] truncate" title={subjVal}>{subjVal || '—'}</td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1 text-slate-500">
                      {d.native_type === 'pdf' ? <FileType2 size={14} className="text-rose-500" /> : <FileText size={14} className="text-sky-600" />}
                      {displayType(m, d.native_type, d.native_mime, d.native_filename)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-slate-500">{d.page_count}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {d.tags.map((t) => <span key={t.id} className="badge text-white" style={{ backgroundColor: t.colour }}>{t.name}</span>)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5"><span className={`badge ${rm.cls}`}>{rm.label}</span></td>
                  {canEdit && (
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => removeDoc(d)} className="btn-ghost text-rose-500 hover:text-rose-600" title="Remove from binder"><Trash2 size={15} /></button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
          <span>Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}</span>
          <div className="flex gap-2">
            <button className="btn-outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={15} /> Prev</button>
            <span className="px-3 py-2">Page {page + 1} / {pages}</span>
            <button className="btn-outline" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight size={15} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
