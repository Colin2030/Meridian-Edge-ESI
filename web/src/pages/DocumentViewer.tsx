import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, reviewMeta, REVIEW_STATES } from '../lib/format';
import { displayName, displayType, displaySubject } from '../lib/displayFields';
import { PdfView } from '../components/PdfView';
import {
  ChevronLeft, ChevronRight, Bookmark, ZoomIn, ZoomOut, FileType2, FileText,
  MessageSquare, Tag as TagIcon, Plus, Send, Info, ArrowLeft, ArrowRight, X, Download,
  MessagesSquare, CornerDownRight, Languages, Paperclip, AlertTriangle, Trash2,
} from 'lucide-react';

interface Tag { id: number; name: string; colour: string; }
interface DocDetail {
  id: number; caseId: number; controlNumber: string; nativeType: string; nativeUrl: string | null;
  pageCount: number; hasText: boolean; extractedText: string | null; metadata: Record<string, string>;
  pages: { pageNo: number; url: string }[]; nativeUrlx?: string;
  threadId: string | null; threadSubject: string | null; threadCount: number;
  threadPosition?: number | null; threadSize?: number | null; parentControlNumber?: string | null;
  hasNative?: boolean; nativeFilename?: string | null; nativeMime?: string | null;
  nativeDownloadUrl?: string | null; imageFormat?: string | null; imagePageCount?: number | null;
  review: { status: string; reviewed_at?: string; reviewed_by?: string };
  tags: Tag[]; bookmarked: boolean; comments: any[]; role: string;
}
interface ThreadMsg {
  id: number; controlNumber: string; subject: string; from: string; to: string;
  date: string; reviewStatus: string; current: boolean; position?: number | null;
}
interface TextVersion {
  id: number; language: string; kind: string; isOriginal: boolean;
  translatedFrom: string | null; method: string | null; charLength: number | null; content: string | null;
}
interface Family {
  controlNumber: string; parentControlNumber: string | null; parentNotFound: boolean;
  parent: { id: number; controlNumber: string; nativeType: string | null } | null;
  attachments: { id: number; controlNumber: string; nativeType: string | null; nativeFilename: string | null; current: boolean }[];
  isFamily: boolean;
}

export default function DocumentViewer() {
  const { caseId, docId } = useParams();
  const nav = useNavigate();
  // The list's active search/filter state is carried in the URL query string so
  // prev/next walk the SAME ordered result set the list showed, and "Back to
  // list" restores that exact filtered list. See CaseWorkspace navParams/docLink.
  const [sp] = useSearchParams();
  const listSearch = sp.toString();
  const backTo = `/cases/${caseId}/review${listSearch ? `?${listSearch}` : ''}`;
  // Params for the ordered-ids endpoint: the same filters, minus the list's page
  // (we want ALL matching ids, not one page).
  const idsQuery = useMemo(() => {
    const p = new URLSearchParams(sp);
    p.delete('page');
    return p.toString();
  }, [sp]);
  // Append the list state to a sibling-document link so navigating within the
  // viewer keeps the result set and back-navigation stays filtered.
  const withList = useCallback((path: string) => `${path}${listSearch ? `?${listSearch}` : ''}`, [listSearch]);
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [caseTags, setCaseTags] = useState<Tag[]>([]);
  const [docIds, setDocIds] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState<'metadata' | 'text' | 'comments'>('metadata');
  const [newComment, setNewComment] = useState('');
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [thread, setThread] = useState<ThreadMsg[]>([]);
  const [versions, setVersions] = useState<TextVersion[]>([]);
  const [selVersion, setSelVersion] = useState<number | null>(null);
  const [family, setFamily] = useState<Family | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<DocDetail>(`/api/documents/${docId}`).then((d) => { setDoc(d); setPage(1); });
  }, [docId]);
  useEffect(() => { load(); }, [load]);
  // Fetch the conversation thread siblings (ordered by position) for the thread panel.
  useEffect(() => {
    setThread([]);
    api.get<{ messages: ThreadMsg[] }>(`/api/documents/${docId}/thread`)
      .then((r) => setThread(r.messages || []))
      .catch(() => setThread([]));
  }, [docId]);
  // #1 Translations: fetch every text version; default to the ORIGINAL.
  useEffect(() => {
    setVersions([]); setSelVersion(null);
    api.get<{ versions: TextVersion[] }>(`/api/cases/${caseId}/documents/${docId}/text-versions`)
      .then((r) => {
        const vs = r.versions || [];
        setVersions(vs);
        const orig = vs.find((v) => v.isOriginal) || vs[0];
        if (orig) setSelVersion(orig.id);
      })
      .catch(() => setVersions([]));
  }, [caseId, docId]);
  // #3 Families: fetch parent + attachments.
  useEffect(() => {
    setFamily(null);
    api.get<Family>(`/api/cases/${caseId}/documents/${docId}/family`)
      .then((f) => setFamily(f))
      .catch(() => setFamily(null));
  }, [caseId, docId]);
  useEffect(() => {
    api.get<any>(`/api/cases/${caseId}`).then((c) => setCaseTags(c.tags || []));
  }, [caseId]);
  // Fetch the ordered id list for the CURRENT search/filter so prev/next walk the
  // exact result set the user was viewing. With no filter params this returns the
  // whole case ordered by control number (default navigation).
  useEffect(() => {
    api.get<{ ids: number[] }>(`/api/case/${caseId}/documents/ids${idsQuery ? `?${idsQuery}` : ''}`)
      .then((r) => setDocIds(r.ids || []))
      .catch(() => setDocIds([]));
  }, [caseId, idsQuery]);

  const canReview = doc && (doc.role === 'system_admin' || doc.role === 'case_manager' || doc.role === 'reviewer');

  const idx = useMemo(() => docIds.indexOf(Number(docId)), [docIds, docId]);
  const goPrev = useCallback(() => { if (idx > 0) nav(withList(`/cases/${caseId}/documents/${docIds[idx - 1]}`)); }, [idx, docIds, caseId, nav, withList]);
  const goNext = useCallback(() => { if (idx >= 0 && idx < docIds.length - 1) nav(withList(`/cases/${caseId}/documents/${docIds[idx + 1]}`)); }, [idx, docIds, caseId, nav, withList]);

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
  // #10 Soft-delete this single document (manager only), then go back to the list.
  const deleteDoc = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      await api.del(`/api/cases/${caseId}/documents/${doc.id}`);
      nav(backTo, { state: { flash: `Document ${doc.controlNumber} deleted. It can be restored within 7 days.` } });
    } catch { setBusy(false); setConfirmDelete(false); }
  };

  if (!doc) return <div className="min-h-[60vh] grid place-items-center text-slate-400">Loading document…</div>;
  const m = doc.metadata || {};
  const rm = reviewMeta(doc.review.status);
  const isPdf = doc.nativeType === 'pdf' && doc.nativeUrl;
  const totalPages = doc.pageCount || doc.pages.length || 1;
  const canManage = doc.role === 'system_admin' || doc.role === 'case_manager';
  const activeVersion = versions.find((v) => v.id === selVersion) || null;
  const langLabel = (v: TextVersion) => {
    const lang = (v.language || 'und').toUpperCase();
    const kind = v.isOriginal ? 'Original' : (v.kind === 'translation' ? 'Translation' : v.kind === 'ocr' ? 'OCR' : 'Extracted');
    const via = !v.isOriginal && v.method ? ` · ${v.method}` : '';
    const from = !v.isOriginal && v.translatedFrom ? ` (from ${v.translatedFrom.toUpperCase()})` : '';
    return `${lang} · ${kind}${from}${via}`;
  };

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-4">
      {/* top bar */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Link to={backTo} className="btn-ghost text-slate-500"><ChevronLeft size={16} /> Back to list</Link>
          <div>
            <div className="flex items-center gap-2">
              {isPdf ? <FileType2 size={18} className="text-rose-500" /> : <FileText size={18} className="text-sky-600" />}
              <h1 className="text-lg font-bold text-navy-900">{displayName(m, doc.controlNumber)}</h1>
              <span className="badge bg-slate-100 text-slate-600">{displayType(m, doc.nativeType, doc.nativeMime, doc.nativeFilename)}</span>
              <span className={`badge ${rm.cls}`}>{rm.label}</span>
            </div>
            <div className="text-xs text-slate-400">{displaySubject(m) || (displayName(m, doc.controlNumber) !== doc.controlNumber ? doc.controlNumber : '')}</div>
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
            <div className="flex items-center gap-2">
              {/* #4 Native download — original file, original filename, declared type */}
              {doc.hasNative && doc.nativeDownloadUrl && (
                <a href={doc.nativeDownloadUrl} className="btn-outline py-1.5" download
                  title={`Download native${doc.nativeFilename ? `: ${doc.nativeFilename}` : ''}${doc.nativeMime ? ` (${doc.nativeMime})` : ''}`}>
                  <Download size={15} /> Download native
                  {doc.nativeMime && <span className="text-xs text-slate-400 ml-1">{doc.nativeMime}</span>}
                </a>
              )}
              <div className="flex items-center gap-1 border-l border-slate-200 pl-2">
                <button className="btn-ghost" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.2).toFixed(2)))}><ZoomOut size={16} /></button>
                <span className="text-sm text-slate-500 w-12 text-center">{Math.round(zoom * 100)}%</span>
                <button className="btn-ghost" onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)))}><ZoomIn size={16} /></button>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-auto bg-slate-200/60 p-5">
            {isPdf ? (
              <PdfView url={doc.nativeUrl!} pageNo={page} zoom={zoom} onPages={() => {}} />
            ) : doc.pages.length > 0 ? (
              <img src={doc.pages[Math.min(page, doc.pages.length) - 1]?.url} alt={`Page ${page}`}
                className="mx-auto shadow-panel rounded bg-white" style={{ width: `${zoom * 70}%`, maxWidth: 'none' }} />
            ) : doc.nativeUrl ? (
              <div className="grid place-items-center h-full text-center">
                <div>
                  <FileText size={40} className="mx-auto mb-3 text-slate-300" />
                  <p className="text-slate-500">No rendered pages — this is a native file.</p>
                  <p className="text-xs text-slate-400 mt-0.5">View the extracted content under the <strong>Text</strong> tab, or open the original native file.</p>
                  <a href={doc.nativeUrl} target="_blank" rel="noreferrer" className="btn-outline mt-4 inline-flex"><Download size={15} /> Open native file</a>
                </div>
              </div>
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

            {/* #10 Delete this document (case manager / admin) */}
            {canManage && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <button onClick={() => setConfirmDelete(true)} className="btn-outline w-full border-rose-200 text-rose-600 hover:bg-rose-50">
                  <Trash2 size={15} /> Delete document
                </button>
              </div>
            )}
          </div>

          {/* conversation thread panel — only for emails in a multi-message thread */}
          {thread.length > 1 && (
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <MessagesSquare size={16} className="text-accent-dark" />
                <h2 className="text-sm font-semibold text-navy-900">Conversation</h2>
                <span className="badge bg-accent/10 text-accent-dark">{thread.length} messages</span>
              </div>
              {doc.threadSubject && (
                <p className="text-xs text-slate-400 mb-2 truncate" title={doc.threadSubject}>{doc.threadSubject}</p>
              )}
              <ol className="space-y-0.5 max-h-[32vh] overflow-auto -mx-1">
                {thread.map((msg, i) => {
                  const trm = reviewMeta(msg.reviewStatus);
                  return (
                    <li key={msg.id}>
                      <Link
                        to={withList(`/cases/${caseId}/documents/${msg.id}`)}
                        className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition ${msg.current ? 'bg-accent/[0.08] ring-1 ring-accent/30' : 'hover:bg-slate-50'}`}
                        title={msg.current ? 'Current message' : `Open ${msg.controlNumber}`}
                      >
                        <span className="mt-0.5 text-slate-300 shrink-0">
                          {i === 0 ? <MessageSquare size={13} /> : <CornerDownRight size={13} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className={`truncate ${msg.current ? 'font-semibold text-navy-900' : 'text-slate-700'}`}>{msg.from || msg.controlNumber}</span>
                            <span className="text-xs text-slate-400 whitespace-nowrap">{fmtDateTime(msg.date) || '—'}</span>
                          </span>
                          <span className="flex items-center gap-1.5 mt-0.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${trm.cls}`} title={trm.label} />
                            <span className="text-xs text-slate-400 truncate">{msg.controlNumber}</span>
                            {msg.current && <span className="text-[10px] uppercase tracking-wide text-accent-dark font-semibold">· viewing</span>}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
              <p className="text-[11px] text-slate-400 mt-2">Ordered by position in the thread.</p>
            </div>
          )}

          {/* #3 Family — parent email + its attachments, with unfound-parent flag */}
          {family && family.isFamily && (
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <Paperclip size={16} className="text-accent-dark" />
                <h2 className="text-sm font-semibold text-navy-900">Family</h2>
                {family.attachments.length > 0 && (
                  <span className="badge bg-accent/10 text-accent-dark">{family.attachments.length} attachment{family.attachments.length === 1 ? '' : 's'}</span>
                )}
              </div>
              {family.parentNotFound && (
                <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-50 border border-amber-200 px-2 py-1.5 text-xs text-amber-700">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>This item references a parent ({family.parentControlNumber}) that was not found in this case.</span>
                </div>
              )}
              {family.parent && (
                <Link to={withList(`/cases/${caseId}/documents/${family.parent.id}`)}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${family.parent.controlNumber === family.controlNumber ? 'bg-accent/[0.08] ring-1 ring-accent/30' : 'hover:bg-slate-50'}`}>
                  <MessageSquare size={13} className="text-slate-400" />
                  <span className="min-w-0 flex-1 truncate">Parent · {family.parent.controlNumber}</span>
                  <span className="badge bg-slate-100 text-slate-500">{family.parent.nativeType || '—'}</span>
                </Link>
              )}
              <ol className="space-y-0.5 mt-0.5 max-h-[28vh] overflow-auto">
                {family.attachments.map((a) => (
                  <li key={a.id}>
                    <Link to={withList(`/cases/${caseId}/documents/${a.id}`)}
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${a.current ? 'bg-accent/[0.08] ring-1 ring-accent/30' : 'hover:bg-slate-50'}`}>
                      <CornerDownRight size={13} className="text-slate-300" />
                      <span className="min-w-0 flex-1 truncate">{a.nativeFilename || a.controlNumber}</span>
                      {a.current && <span className="text-[10px] uppercase tracking-wide text-accent-dark font-semibold">viewing</span>}
                      <span className="badge bg-slate-100 text-slate-500">{a.nativeType || '—'}</span>
                    </Link>
                  </li>
                ))}
                {family.attachments.length === 0 && !family.parent && (
                  <li className="text-xs text-slate-400 px-2">No related items found.</li>
                )}
              </ol>
            </div>
          )}

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
                versions.length > 0 ? (
                  <div>
                    {/* #1 Translation / version switcher — ORIGINAL selected by default */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <Languages size={15} className="text-accent-dark" />
                      {versions.length > 1 ? (
                        <select
                          className="input py-1.5 text-sm max-w-full"
                          value={selVersion ?? ''}
                          onChange={(e) => setSelVersion(Number(e.target.value))}
                        >
                          {versions.map((v) => (
                            <option key={v.id} value={v.id}>{langLabel(v)}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="badge bg-slate-100 text-slate-600">{langLabel(versions[0])}</span>
                      )}
                      {activeVersion && !activeVersion.isOriginal && (
                        <span className="badge bg-amber-100 text-amber-700" title="This is a translation, not the original text">Translation</span>
                      )}
                    </div>
                    {activeVersion?.content
                      ? <pre className="whitespace-pre-wrap text-sm text-slate-700 font-sans">{activeVersion.content}</pre>
                      : <p className="text-sm text-slate-400">This version has no stored text content.</p>}
                  </div>
                ) : doc.hasText && doc.extractedText ? (
                  <pre className="whitespace-pre-wrap text-sm text-slate-700 font-sans">{doc.extractedText}</pre>
                ) : (
                  <p className="text-sm text-slate-400">No extracted text. Run import with OCR enabled to populate searchable text for image-only documents.</p>
                )
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

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal-950/60 p-4" onClick={() => setConfirmDelete(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md card p-6">
            <h3 className="text-lg font-bold text-rose-700 flex items-center gap-2"><AlertTriangle size={18} /> Delete this document?</h3>
            <p className="text-sm text-slate-600 mt-2">
              Document <strong>{doc.controlNumber}</strong> will be soft-deleted and hidden from review. It can be restored within the 7-day retention window, after which it is permanently removed.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className="btn-ghost" disabled={busy}>Cancel</button>
              <button onClick={deleteDoc} className="btn-primary bg-rose-600 hover:bg-rose-700" disabled={busy}>{busy ? 'Deleting…' : 'Delete document'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
