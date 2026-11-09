import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate, reviewMeta, REVIEW_STATES } from '../lib/format';
import { Search, Bookmark, Filter, X, FileText, FileType2, Tag as TagIcon, ChevronLeft, ChevronRight, Settings2, UploadCloud, ListChecks, ClipboardList, BookMarked, FolderPlus, CheckCircle2, MessagesSquare } from 'lucide-react';
import { CaseAdminPanel } from '../components/CaseAdminPanel';
import { KeywordListPanel, KwOptions } from '../components/KeywordListPanel';
import { ReportBuilder } from '../components/ReportBuilder';
import { AddToBinder } from '../components/AddToBinder';

interface Tag { id: number; name: string; colour: string; }
interface CaseInfo { id: number; name: string; case_number: string; description: string; role: string; tags: Tag[]; statusCounts: { status: string; n: number }[]; }
interface Snippet { before: string; match: string; after: string; }
interface DocRow {
  id: number; control_number: string; native_type: string; page_count: number; has_text: boolean;
  metadata: Record<string, string>; review_status: string; bookmarked: boolean; tags: Tag[];
  thread_id: string | null; thread_subject: string | null; thread_count: number;
  snippet?: Snippet | null;
}

export default function CaseWorkspace() {
  const { caseId } = useParams();
  const [info, setInfo] = useState<CaseInfo | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const [showAdmin, setShowAdmin] = useState(searchParams.get('settings') === '1');
  const [showReport, setShowReport] = useState(false);

  // search mode: 'fulltext' (default, tsvector) or 'pattern' (GREP/regex)
  const [mode, setMode] = useState<'fulltext' | 'pattern'>('fulltext');
  const [literal, setLiteral] = useState(true);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showKeywords, setShowKeywords] = useState(false);
  const [searchError, setSearchError] = useState('');

  // filters — initialise status/tag from the URL so ECA home links can
  // pre-filter the review list (e.g. /cases/1/review?status=responsive).
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [tagId, setTagId] = useState(searchParams.get('tagId') || '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [bookmarked, setBookmarked] = useState(false);
  // file-type filter: the selected set of extensions, plus the list of types
  // present in the case (with counts) sourced from the existing ECA endpoint.
  const [fileTypes, setFileTypes] = useState<Set<string>>(new Set());
  const [fileTypeOptions, setFileTypeOptions] = useState<{ file_type: string; count: number }[]>([]);
  const [ftOpen, setFtOpen] = useState(false);
  const ftRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState('control_number');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const limit = 25;

  // selection + binders
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [showAddBinder, setShowAddBinder] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => { api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo); }, [caseId]);

  // File types present in the case (with counts), ordered most-occurring first,
  // reused from the ECA endpoint to populate the file-type filter tick boxes.
  useEffect(() => {
    api.get<{ file_types: { file_type: string; count: number }[] }>(`/api/cases/${caseId}/eca`)
      .then((r) => setFileTypeOptions(r.file_types || []))
      .catch(() => setFileTypeOptions([]));
  }, [caseId]);

  // Close the file-type popover on outside click or Escape (keyboard-accessible).
  useEffect(() => {
    if (!ftOpen) return;
    const onDown = (e: MouseEvent) => { if (ftRef.current && !ftRef.current.contains(e.target as Node)) setFtOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFtOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [ftOpen]);

  // Build the document-list query params for the active search/filter state.
  // `extra` lets callers override limit/offset (e.g. to resolve all matching ids).
  const buildParams = useCallback((extra?: Record<string, string>) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (tagId) p.set('tagId', tagId);
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo) p.set('dateTo', dateTo);
    if (bookmarked) p.set('bookmarked', 'true');
    if (fileTypes.size) p.set('fileTypes', Array.from(fileTypes).join(','));
    if (mode === 'pattern') {
      p.set('mode', 'pattern');
      p.set('literal', String(literal));
      p.set('caseSensitive', String(caseSensitive));
      p.set('wholeWord', String(wholeWord));
    }
    p.set('sort', mode === 'fulltext' && q && sort === 'control_number' ? 'rank' : sort);
    p.set('dir', dir);
    p.set('limit', String(limit));
    p.set('offset', String(page * limit));
    if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }, [q, status, tagId, dateFrom, dateTo, bookmarked, fileTypes, sort, dir, page, mode, literal, caseSensitive, wholeWord]);

  const load = useCallback(() => {
    setLoading(true);
    api.get<{ total: number; documents: DocRow[] }>(`/api/case/${caseId}/documents?${buildParams().toString()}`)
      .then((r) => { setDocs(r.documents); setTotal(r.total); setSearchError(''); })
      .catch((e) => { setDocs([]); setTotal(0); setSearchError(e?.message || 'Search failed.'); })
      .finally(() => setLoading(false));
  }, [caseId, buildParams]);

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  // Clear any selection whenever the result set changes (new filter/search).
  useEffect(() => { setSelected(new Set()); setSelectAllMatching(false); }, [q, status, tagId, dateFrom, dateTo, bookmarked, fileTypes, mode, literal, caseSensitive, wholeWord]);

  // Resolve the ids to add to a binder: the whole matching set when "select all
  // matching" is active (paged fetch, 200 at a time), otherwise the ticked rows.
  const resolveSelectedIds = useCallback(async (): Promise<number[]> => {
    if (!selectAllMatching) return Array.from(selected);
    const ids: number[] = [];
    const pageSize = 200;
    for (let off = 0; off < total; off += pageSize) {
      const p = buildParams({ limit: String(pageSize), offset: String(off) });
      const r = await api.get<{ documents: { id: number }[] }>(`/api/case/${caseId}/documents?${p.toString()}`);
      ids.push(...r.documents.map((d) => d.id));
      if (r.documents.length < pageSize) break;
    }
    return ids;
  }, [selectAllMatching, selected, total, buildParams, caseId]);

  const resetFilters = () => { setQ(''); setStatus(''); setTagId(''); setDateFrom(''); setDateTo(''); setBookmarked(false); setFileTypes(new Set()); setPage(0); };
  const activeFilters = [status, tagId, dateFrom, dateTo].filter(Boolean).length + (bookmarked ? 1 : 0) + fileTypes.size;
  const toggleFileType = (ft: string) => {
    setPage(0);
    setFileTypes((prev) => { const n = new Set(prev); if (n.has(ft)) n.delete(ft); else n.add(ft); return n; });
  };
  const canManage = info?.role === 'system_admin' || info?.role === 'case_manager';
  const canReport = canManage || info?.role === 'reviewer';
  const canBinder = canReport; // reviewer+ may group documents into binders

  // selection helpers
  const selectionCount = selectAllMatching ? total : selected.size;
  const pageIds = docs.map((d) => d.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleRow = (id: number) => {
    setSelectAllMatching(false);
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const togglePage = () => {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const n = new Set(prev);
      if (allOnPageSelected) pageIds.forEach((id) => n.delete(id));
      else pageIds.forEach((id) => n.add(id));
      return n;
    });
  };
  const clearSelection = () => { setSelected(new Set()); setSelectAllMatching(false); };
  const isRowSelected = (id: number) => selectAllMatching || selected.has(id);

  // Jump from the keyword-list report to a filtered document list for one term.
  const selectKeywordTerm = (term: string, opts: KwOptions) => {
    setMode('pattern');
    setLiteral(opts.literal); setCaseSensitive(opts.caseSensitive); setWholeWord(opts.wholeWord);
    setQ(term); setPage(0); setShowKeywords(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleBookmark = async (d: DocRow, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const r = await api.post<{ bookmarked: boolean }>(`/api/documents/${d.id}/bookmark`);
    setDocs((prev) => prev.map((x) => x.id === d.id ? { ...x, bookmarked: r.bookmarked } : x));
  };

  const pages = Math.ceil(total / limit);

  return (
    <div className="mx-auto max-w-[1600px] px-5 py-6">
      {/* header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <Link to={`/cases/${caseId}`} className="text-sm text-slate-400 hover:text-slate-600 flex items-center gap-1"><ChevronLeft size={14} /> Case overview</Link>
          <h1 className="text-2xl font-bold text-navy-900 mt-1">{info?.name || 'Loading…'}</h1>
          <p className="text-sm text-slate-500">{info?.case_number} · {total} documents · your role: <span className="font-medium text-slate-700">{(info?.role || '').replace('_', ' ')}</span></p>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/cases/${caseId}/binders`} className="btn-outline"><BookMarked size={16} /> Binders</Link>
          {canReport && (
            <button onClick={() => setShowReport(true)} className="btn-outline"><ClipboardList size={16} /> Build report</button>
          )}
          {canManage && (
            <>
              <Link to={`/cases/${caseId}/import`} className="btn-primary"><UploadCloud size={16} /> Add case data</Link>
              <button onClick={() => setShowAdmin((s) => !s)} className="btn-outline"><Settings2 size={16} /> Case settings</button>
            </>
          )}
        </div>
      </div>

      {showAdmin && canManage && info && (
        <CaseAdminPanel caseId={info.id} tags={info.tags} onClose={() => setShowAdmin(false)} onChange={() => api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo)} />
      )}

      {showReport && info && (
        <ReportBuilder caseId={info.id} caseName={`${info.name} · ${info.case_number}`} onClose={() => setShowReport(false)} />
      )}

      {showAddBinder && info && (
        <AddToBinder
          caseId={info.id}
          count={selectionCount}
          resolveIds={resolveSelectedIds}
          onClose={() => setShowAddBinder(false)}
          onAdded={({ added, skipped, binderName }) => {
            setShowAddBinder(false);
            clearSelection();
            setToast(`${added} document${added === 1 ? '' : 's'} added to '${binderName}'${skipped ? ` · ${skipped} already present` : ''}`);
            setTimeout(() => setToast(''), 5000);
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-navy-900 text-white px-4 py-3 shadow-lg text-sm">
          <CheckCircle2 size={18} className="text-emerald-400" /> {toast}
        </div>
      )}

      {/* status summary chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {REVIEW_STATES.map((r) => {
          const n = info?.statusCounts.find((s) => s.status === r.value)?.n || 0;
          const active = status === r.value;
          return (
            <button key={r.value} onClick={() => { setStatus(active ? '' : r.value); setPage(0); }}
              className={`badge border ${active ? 'ring-2 ring-accent/40 ' : ''}${r.cls} ${n === 0 ? 'opacity-50' : ''} border-transparent`}>
              {r.label}<span className="font-bold">{n}</span>
            </button>
          );
        })}
      </div>

      {/* search + filters */}
      <div className="card p-4 mb-4">
        {/* mode selector */}
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-sm">
            <button onClick={() => { setMode('fulltext'); setPage(0); }}
              className={`px-3 py-1.5 ${mode === 'fulltext' ? 'bg-accent text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>Full text</button>
            <button onClick={() => { setMode('pattern'); setPage(0); }}
              className={`px-3 py-1.5 border-l border-slate-200 ${mode === 'pattern' ? 'bg-accent text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>Pattern (GREP)</button>
          </div>
          <span className="text-xs text-slate-400">
            {mode === 'fulltext' ? 'Natural-language search across indexed text.' : 'Match exact text or patterns in the extracted text.'}
          </span>
          <div className="flex-1" />
          <button onClick={() => setShowKeywords((s) => !s)} className={`btn-outline ${showKeywords ? 'border-accent text-accent-dark bg-accent/5' : ''}`}>
            <ListChecks size={15} /> Keyword list
          </button>
        </div>

        <div className="flex flex-col lg:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9" placeholder={mode === 'pattern'
              ? 'Find exact text or a pattern in the extracted text…'
              : 'Search full text across metadata and extracted/OCR text…'}
              value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <select className="input w-auto" value={tagId} onChange={(e) => { setTagId(e.target.value); setPage(0); }}>
              <option value="">All tags</option>
              {info?.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input type="date" className="input w-auto" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} title="Date from" />
            <input type="date" className="input w-auto" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} title="Date to" />
            <button onClick={() => { setBookmarked((b) => !b); setPage(0); }} className={`btn-outline ${bookmarked ? 'border-accent text-accent-dark bg-accent/5' : ''}`}>
              <Bookmark size={15} className={bookmarked ? 'fill-accent text-accent' : ''} /> Bookmarked
            </button>
            {/* file-type filter popover */}
            <div className="relative" ref={ftRef}>
              <button type="button" onClick={() => setFtOpen((o) => !o)}
                aria-haspopup="true" aria-expanded={ftOpen}
                className={`btn-outline ${fileTypes.size ? 'border-accent text-accent-dark bg-accent/5' : ''}`}>
                <FileType2 size={15} /> File type
                {fileTypes.size > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-xs font-semibold text-white">{fileTypes.size}</span>}
              </button>
              {ftOpen && (
                <div role="menu" className="absolute right-0 z-40 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">File type</span>
                    {fileTypes.size > 0 && (
                      <button onClick={() => { setFileTypes(new Set()); setPage(0); }} className="text-xs text-accent-dark hover:underline">Clear</button>
                    )}
                  </div>
                  <div className="max-h-64 overflow-auto">
                    {fileTypeOptions.length === 0 ? (
                      <p className="px-2 py-2 text-xs text-slate-400">No file types in this case.</p>
                    ) : fileTypeOptions.map((ft) => (
                      <label key={ft.file_type} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
                        <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent"
                          checked={fileTypes.has(ft.file_type)} onChange={() => toggleFileType(ft.file_type)} />
                        <span className="flex-1 text-slate-700">{ft.file_type}</span>
                        <span className="text-xs text-slate-400">{ft.count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {(activeFilters > 0 || q) && <button onClick={resetFilters} className="btn-ghost text-slate-500"><X size={15} /> Clear</button>}
          </div>
        </div>

        {/* pattern options */}
        {mode === 'pattern' && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3 pt-3 border-t border-slate-100">
            <PatternOption label="Regular expression" help="Treat the search as a regex pattern (off = plain text)" checked={!literal} onChange={(v) => { setLiteral(!v); setPage(0); }} />
            <PatternOption label="Case sensitive" help="Match upper/lower case exactly" checked={caseSensitive} onChange={(v) => { setCaseSensitive(v); setPage(0); }} />
            <PatternOption label="Whole word only" help="Match complete words, not fragments" checked={wholeWord} onChange={(v) => { setWholeWord(v); setPage(0); }} />
          </div>
        )}

        {searchError && (
          <div className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{searchError}</div>
        )}
      </div>

      {showKeywords && <KeywordListPanel caseId={caseId!} onClose={() => setShowKeywords(false)} onSelectTerm={selectKeywordTerm} />}

      {/* bulk selection action bar */}
      {canBinder && selectionCount > 0 && (
        <div className="sticky top-2 z-30 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm">
          <span className="font-semibold text-navy-900">{selectionCount} document{selectionCount === 1 ? '' : 's'} selected</span>
          {/* Offer selecting the entire matching set, not just the current page. */}
          {!selectAllMatching && allOnPageSelected && total > selected.size && (
            <button onClick={() => setSelectAllMatching(true)} className="text-accent-dark underline underline-offset-2 hover:text-accent">
              Select all {total} matching
            </button>
          )}
          {selectAllMatching && (
            <span className="text-slate-500">All documents matching the current filter are selected.</span>
          )}
          <div className="flex-1" />
          <button onClick={() => setShowAddBinder(true)} className="btn-primary"><FolderPlus size={15} /> Add to binder</button>
          <button onClick={clearSelection} className="btn-ghost text-slate-500"><X size={15} /> Clear</button>
        </div>
      )}

      {/* grid */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              {canBinder && (
                <th className="px-3 py-2.5 w-8">
                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent align-middle"
                    checked={allOnPageSelected || selectAllMatching} onChange={togglePage} title="Select all on this page" />
                </th>
              )}
              <th className="px-3 py-2.5 w-8"></th>
              <Th label="Control #" col="control_number" sort={sort} dir={dir} onSort={(c, d) => { setSort(c); setDir(d); }} />
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">From / To</th>
              <th className="px-3 py-2.5">Subject</th>
              <th className="px-3 py-2.5">Type</th>
              <Th label="Pages" col="page_count" sort={sort} dir={dir} onSort={(c, d) => { setSort(c); setDir(d); }} />
              <th className="px-3 py-2.5">Tags</th>
              <th className="px-3 py-2.5">Review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={canBinder ? 10 : 9} className="py-16 text-center text-slate-400">Searching…</td></tr>
            ) : docs.length === 0 ? (
              <tr><td colSpan={canBinder ? 10 : 9} className="py-16 text-center text-slate-400"><Filter className="mx-auto mb-2 text-slate-300" size={28} />No documents match your filters.</td></tr>
            ) : docs.map((d) => {
              const m = d.metadata || {};
              // Resolve list columns from Concordance (.DAT) field names first, then fall
              // back to EDRM XML field labels so XML-imported docs populate too.
              const dateVal = m.DATE || m['Date Sent'];
              const fromVal = m.FROM || m['Email From'];
              const toVal = m.TO || m['Email To'];
              const subjVal = m.SUBJECT || m['Email Subject'] || m.FILENAME || m['File Name'];
              const rm = reviewMeta(d.review_status);
              const snip = mode === 'pattern' ? d.snippet : null;
              return (
              <Fragment key={d.id}>
                <tr className={`hover:bg-accent/[0.03] transition ${isRowSelected(d.id) ? 'bg-accent/[0.04]' : ''} ${snip ? 'border-b-0' : ''}`}>
                  {canBinder && (
                    <td className="px-3 py-2.5">
                      <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent align-middle"
                        checked={isRowSelected(d.id)} onChange={() => toggleRow(d.id)} />
                    </td>
                  )}
                  <td className="px-3 py-2.5">
                    <button onClick={(e) => toggleBookmark(d, e)} title="Bookmark">
                      <Bookmark size={16} className={d.bookmarked ? 'fill-accent text-accent' : 'text-slate-300 hover:text-slate-400'} />
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link to={`/cases/${caseId}/documents/${d.id}`} className="font-medium text-navy-900 hover:text-accent-dark">{m['File Name'] || d.control_number}</Link>
                    {m['File Name'] && <div className="text-xs text-slate-400 truncate max-w-[220px]" title={d.control_number}>{d.control_number}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDate(dateVal)}</td>
                  <td className="px-3 py-2.5 text-slate-600 max-w-[200px] truncate" title={`${fromVal || ''} → ${toVal || ''}`}>
                    <div className="truncate">{fromVal || '—'}</div>
                    <div className="truncate text-xs text-slate-400">{toVal || ''}</div>
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 max-w-[260px]">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate" title={subjVal}>{subjVal || '—'}</span>
                      {d.thread_id && d.thread_count > 1 && (
                        <span className="inline-flex items-center gap-0.5 shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent-dark"
                          title={`Part of a conversation of ${d.thread_count} messages`}>
                          <MessagesSquare size={11} />{d.thread_count}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1 text-slate-500">
                      {d.native_type === 'pdf' ? <FileType2 size={14} className="text-rose-500" /> : <FileText size={14} className="text-sky-600" />}
                      {(m.DOCTYPE || d.native_type || '').toString()}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-slate-500">{d.page_count}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {d.tags.map((t) => <span key={t.id} className="badge text-white" style={{ backgroundColor: t.colour }}>{t.name}</span>)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5"><span className={`badge ${rm.cls}`}>{rm.label}</span></td>
                </tr>
                {snip && (
                  <tr className="bg-slate-50/60">
                    {canBinder && <td></td>}
                    <td></td>
                    <td colSpan={8} className="px-3 pb-2.5 pt-0 text-xs text-slate-500">
                      <Link to={`/cases/${caseId}/documents/${d.id}`} className="hover:text-accent-dark">
                        <span className="font-mono">{snip.before}</span>
                        {snip.match && <mark className="bg-amber-200 text-navy-900 rounded px-0.5 font-mono">{snip.match}</mark>}
                        <span className="font-mono">{snip.after}</span>
                      </Link>
                    </td>
                  </tr>
                )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* pagination */}
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

function PatternOption({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-start gap-2 cursor-pointer select-none" title={help}>
      <input type="checkbox" className="mt-0.5 accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-sm">
        <span className="text-slate-700">{label}</span>
        <span className="block text-xs text-slate-400 leading-tight">{help}</span>
      </span>
    </label>
  );
}

function Th({ label, col, sort, dir, onSort }: { label: string; col: string; sort: string; dir: string; onSort: (c: string, d: 'asc' | 'desc') => void }) {
  const active = sort === col;
  return (
    <th className="px-3 py-2.5 cursor-pointer select-none hover:text-slate-700" onClick={() => onSort(col, active && dir === 'asc' ? 'desc' : 'asc')}>
      {label}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}
