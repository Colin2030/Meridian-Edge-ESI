import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, reviewMeta, REVIEW_STATES } from '../lib/format';
import { PdfView } from '../components/PdfView';
import {
  ChevronLeft, ChevronRight, Bookmark, ZoomIn, ZoomOut, FileType2, FileText,
  MessageSquare, Tag as TagIcon, Plus, Send, Info, ArrowLeft, ArrowRight, X,
} from 'lucide-react';

interface Tag { id: number; name: string; colour: string; }
interface DocDetail {
  id: number; caseId: number; controlNumber: string; nativeType: string; nativeUrl: string | null;
  pageCount: number; hasText: boolean; extractedText: string | null; metadata: Record<string, string>;
  pages: { pageNo: number; url: string }[]; nativeUrlx?: string;
  review: { status: string; reviewed_at?: string; reviewed_by?: string };
  tags: Tag[]; bookmarked: boolean; comments: any[]; role: string;
}

export default function DocumentViewer() {
  const { caseId, docId } = useParams();
  const nav = useNavigate();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [caseTags, setCaseTags] = useState<Tag[]>([]);
  const [docIds, setDocIds] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<'metadata' | 'text' | 'comments'>('metadata');
  const [newComment, setNewComment] = useState('');
  const [showTagMenu, setShowTagMenu] = useState(false);

  const load = useCallback(() => {
    api.get<DocDetail>(`/api/documents/${docId}`).then((d) => { setDoc(d); setPage(1); });
  }, [docId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get<any>(`/api/cases/${caseId}`).then((c) => setCaseTags(c.tags || []));
    api.get<{ documents: { id: number }[] }>(`/api/case/${caseId}/documents?limit=200&sort=control_number`)
      .then((r) => setDocIds(r.documents.map((x) => x.id)));
  }, [caseId]);

  const canReview = doc && (doc.role === 'system_admin' || doc.role === 'case_manager' || doc.role === 'reviewer');

  const idx = useMemo(() => docIds.indexOf(Number(docId)), [docIds, docId]);
  const goPrev = useCallback(() => { if (idx > 0) nav(`/cases/${caseId}/documents/${docIds[idx - 1]}`); }, [idx, docIds, caseId, nav]);
  const goNext = useCallback(() => { if (idx >= 0 && idx < docIds.length - 1) nav(`/cases/${caseId}/documents/${docIds[idx + 1]}`); }, [idx, docIds, caseId, nav]);

  // keyboard navigation
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.key === 'j' || e.key === 'ArrowDown') goNext();
      if (e.key === 'k' || e.key === 'ArrowUp') goPrev();
      if (e.key === 'ArrowRight' && doc && page < doc.pageCount) setPage((p) => p + 1);
      if (e.key === 'ArrowLeft' && page > 1) setPage((p) => p - 1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [goNext, goPrev, doc, page]);

  const setReview = async (status: string) => {
    if (!doc) return;
    await api.put(`/api/documents/${doc.id}/review`, { status });
    setDoc({ ...doc, review: { ...doc.review, status } });
  };
  const toggleBookmark = async () => {
    if (!doc) return;
    const r = await api.post<{ bookmarked: boolean }>(`/api/documents/${doc.id}/bookmark`);
    setDoc({ ...doc, bookmarked: r.bookmarked });
  };
  const addTag = async (tagId: number) => {
    if (!doc) return;
    await api.post(`/api/documents/${doc.id}/tags`, { tagId });
    setShowTagMenu(false); load();
  };
  const removeTag = async (tagId: number) => {
    if (!doc) return;
    await api.del(`/api/documents/${doc.id}/tags/${tagId}`); load();
  };
  const postComment = async () => {
    if (!doc || !newComment.trim()) return;
    await api.post(`/api/documents/${doc.id}/comments`, { body: newComment.trim() });
    setNewComment(''); load();
  };

  if (!doc) return <div className="min-h-[60vh] grid place-items-center text-slate-400">Loading document…</div>;
  const m = doc.metadata || {};
  const rm = reviewMeta(doc.review.status);
  const isPdf = doc.nativeType === 'pdf' && doc.nativeUrl;
  const totalPages = doc.pageCount || doc.pages.length || 1;

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-4">
      {/* top bar */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Link to={`/cases/${caseId}/review`} className="btn-ghost text-slate-500"><ChevronLeft size={16} /> Back to list</Link>
          <div>
            <div className="flex items-center gap-2">
              {isPdf ? <FileType2 size={18} className="text-rose-500" /> : <FileText size={18} className="text-sky-600" />}
              <h1 className="text-lg font-bold text-navy-900">{doc.controlNumber}</h1>
              <span className={`badge ${rm.cls}`}>{rm.label}</span>
            </div>
            <div className="text-xs text-slate-400">{m.SUBJECT || m.FILENAME || ''}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goPrev} disabled={idx <= 0} className="btn-outline" title="Previous document (k)"><ArrowLeft size={15} /> Prev</button>
          <span className="text-xs text-slate-400">{idx >= 0 ? idx + 1 : '—'} / {docIds.length}</span>
          <button onClick={goNext} disabled={idx < 0 || idx >= docIds.length - 1} className="btn-outline" title="Next document (j)">Next <ArrowRight size={15} /></button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        {/* viewer */}
        <div className="card flex flex-col overflow-hidden" style={{ minHeight: '70vh' }}>
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 bg-slate-50">
            <div className="flex items-center gap-1">
              <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={16} /></button>
              <span className="text-sm text-slate-600">Page {page} / {totalPages}</span>
              <button className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={16} /></button>
            </div>
            <div className="flex items-center gap-1">
              <button className="btn-ghost" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(2)))}><ZoomOut size={16} /></button>
              <span className="text-sm text-slate-500 w-12 text-center">{Math.round(zoom * 100)}%</span>
              <button className="btn-ghost" onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)))}><ZoomIn size={16} /></button>
            </div>
          </div>
          <div className="flex-1 overflow-auto bg-slate-200/60 p-5">
            {isPdf ? (
              <PdfView url={doc.nativeUrl!} pageNo={page} zoom={zoom} onPages={() => {}} />
            ) : doc.pages.length > 0 ? (
              <img src={doc.pages[Math.min(page, doc.pages.length) - 1]?.url} alt={`Page ${page}`}
                className="mx-auto shadow-panel rounded bg-white" style={{ width: `${zoom * 70}%`, maxWidth: 'none' }} />
            ) : (
              <div className="grid place-items-center h-full text-slate-400">No image pages available for this document.</div>
            )}
          </div>
        </div>

        {/* side panel */}
        <div className="space-y-4">
          {/* actions */}
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <button onClick={toggleBookmark} className={`btn-outline flex-1 ${doc.bookmarked ? 'border-accent text-accent-dark bg-accent/5' : ''}`}>
                <Bookmark size={15} className={doc.bookmarked ? 'fill-accent text-accent' : ''} /> {doc.bookmarked ? 'Bookmarked' : 'Bookmark'}
              </button>
            </div>
            <label className="label">Review status</label>
            {canReview ? (
              <div className="grid grid-cols-2 gap-1.5">
                {REVIEW_STATES.map((r) => (
                  <button key={r.value} onClick={() => setReview(r.value)}
                    className={`text-xs font-medium rounded-md px-2 py-1.5 border transition ${doc.review.status === r.value ? `${r.cls} ring-2 ring-accent/40 border-transparent` : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            ) : (
              <div><span className={`badge ${rm.cls}`}>{rm.label}</span><p className="text-xs text-slate-400 mt-1">Read-only access — review changes disabled.</p></div>
            )}
            {doc.review.reviewed_by && <p className="text-xs text-slate-400 mt-2">Last reviewed by {doc.review.reviewed_by} · {fmtDateTime(doc.review.reviewed_at)}</p>}

            {/* tags */}
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label className="label mb-0">Tags</label>
                {canReview && (
                  <div className="relative">
                    <button onClick={() => setShowTagMenu((s) => !s)} className="btn-ghost text-accent-dark text-xs"><Plus size={14} /> Add</button>
                    {showTagMenu && (
                      <div className="absolute right-0 z-10 mt-1 w-44 card p-1">
                        {caseTags.filter((t) => !doc.tags.some((dt) => dt.id === t.id)).map((t) => (
                          <button key={t.id} onClick={() => addTag(t.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: t.colour }} />{t.name}
                          </button>
                        ))}
                        {caseTags.filter((t) => !doc.tags.some((dt) => dt.id === t.id)).length === 0 && <div className="px-2 py-1.5 text-xs text-slate-400">No more tags</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {doc.tags.map((t) => (
                  <span key={t.id} className="badge text-white group" style={{ backgroundColor: t.colour }}>
                    {t.name}{canReview && <button onClick={() => removeTag(t.id)} className="ml-0.5 opacity-70 hover:opacity-100"><X size={11} /></button>}
                  </span>
                ))}
                {doc.tags.length === 0 && <span className="text-xs text-slate-400">No tags</span>}
              </div>
            </div>
          </div>

          {/* tabs */}
          <div className="card">
            <div className="flex border-b border-slate-200">
              {([['metadata', 'Metadata', Info], ['text', 'Text', FileText], ['comments', `Comments (${doc.comments.length})`, MessageSquare]] as const).map(([k, label, Icon]) => (
                <button key={k} onClick={() => setTab(k)} className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-accent text-navy-900' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                  <Icon size={15} />{label}
                </button>
              ))}
            </div>
            <div className="p-4 max-h-[48vh] overflow-auto">
              {tab === 'metadata' && (
                <dl className="space-y-0 divide-y divide-slate-100">
                  {Object.entries(m).map(([k, v]) => (
                    <div key={k} className="py-1.5 grid grid-cols-[110px_1fr] gap-2">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400 truncate" title={k}>{k}</dt>
                      <dd className="text-sm text-slate-700 break-words">{v || '—'}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {tab === 'text' && (
                doc.hasText && doc.extractedText ? <pre className="whitespace-pre-wrap text-sm text-slate-700 font-sans">{doc.extractedText}</pre>
                  : <p className="text-sm text-slate-400">No extracted text. Run import with OCR enabled to populate searchable text for image-only documents.</p>
              )}
              {tab === 'comments' && (
                <div>
                  <div className="space-y-3 mb-3">
                    {doc.comments.map((c: any) => (
                      <div key={c.id} className="rounded-lg bg-slate-50 p-3">
                        <div className="flex items-center justify-between"><span className="text-sm font-medium text-navy-900">{c.display_name}</span><span className="text-xs text-slate-400">{fmtDateTime(c.created_at)}</span></div>
                        <p className="text-sm text-slate-600 mt-1">{c.body}</p>
                      </div>
                    ))}
                    {doc.comments.length === 0 && <p className="text-sm text-slate-400">No comments yet.</p>}
                  </div>
                  {canReview ? (
                    <div className="flex gap-2">
                      <input className="input" placeholder="Add a comment…" value={newComment} onChange={(e) => setNewComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && postComment()} />
                      <button onClick={postComment} className="btn-accent"><Send size={15} /></button>
                    </div>
                  ) : <p className="text-xs text-slate-400">Read-only access — commenting disabled.</p>}
                </div>
              )}
            </div>
          </div>
          <p className="text-center text-xs text-slate-400">Tip: use <kbd className="rounded bg-slate-100 px-1">J</kbd>/<kbd className="rounded bg-slate-100 px-1">K</kbd> for next/previous document.</p>
        </div>
      </div>
    </div>
  );
}
