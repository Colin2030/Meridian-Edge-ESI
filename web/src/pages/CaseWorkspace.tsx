import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate, reviewMeta, REVIEW_STATES } from '../lib/format';
import { Search, Bookmark, Filter, X, FileText, FileType2, Tag as TagIcon, ChevronLeft, ChevronRight, Settings2, UploadCloud, ListChecks } from 'lucide-react';
import { CaseAdminPanel } from '../components/CaseAdminPanel';
import { KeywordListPanel, KwOptions } from '../components/KeywordListPanel';

interface Tag { id: number; name: string; colour: string; }
interface CaseInfo { id: number; name: string; case_number: string; description: string; role: string; tags: Tag[]; statusCounts: { status: string; n: number }[]; }
interface Snippet { before: string; match: string; after: string; }
interface DocRow {
  id: number; control_number: string; native_type: string; page_count: number; has_text: boolean;
  metadata: Record<string, string>; review_status: string; bookmarked: boolean; tags: Tag[];
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
  const [sort, setSort] = useState('control_number');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const limit = 25;

  useEffect(() => { api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo); }, [caseId]);

  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (tagId) p.set('tagId', tagId);
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo) p.set('dateTo', dateTo);
    if (bookmarked) p.set('bookmarked', 'true');
    if (mode === 'pattern') {
      p.set('mode', 'pattern');
      p.set('literal', String(literal));
      p.set('caseSensitive', String(caseSensitive));
      p.set('wholeWord', String(wholeWord));
    }
    // 'rank' sorting only applies to full-text search.
    p.set('sort', mode === 'fulltext' && q && sort === 'control_number' ? 'rank' : sort);
    p.set('dir', dir);
    p.set('limit', String(limit));
    p.set('offset', String(page * limit));
    api.get<{ total: number; documents: DocRow[] }>(`/api/case/${caseId}/documents?${p.toString()}`)
      .then((r) => { setDocs(r.documents); setTotal(r.total); setSearchError(''); })
      .catch((e) => { setDocs([]); setTotal(0); setSearchError(e?.message || 'Search failed.'); })
      .finally(() => setLoading(false));
  }, [caseId, q, status, tagId, dateFrom, dateTo, bookmarked, sort, dir, page, mode, literal, caseSensitive, wholeWord]);

  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  const resetFilters = () => { setQ(''); setStatus(''); setTagId(''); setDateFrom(''); setDateTo(''); setBookmarked(false); setPage(0); };
  const activeFilters = [status, tagId, dateFrom, dateTo].filter(Boolean).length + (bookmarked ? 1 : 0);
  const canManage = info?.role === 'system_admin' || info?.role === 'case_manager';

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
        {canManage && (
          <div className="flex items-center gap-2">
            <Link to={`/cases/${caseId}/import`} className="btn-primary"><UploadCloud size={16} /> Add case data</Link>
            <button onClick={() => setShowAdmin((s) => !s)} className="btn-outline"><Settings2 size={16} /> Case settings</button>
          </div>
        )}
      </div>

      {showAdmin && canManage && info && (
        <CaseAdminPanel caseId={info.id} tags={info.tags} onClose={() => setShowAdmin(false)} onChange={() => api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo)} />
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

      {/* grid */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
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
              <tr><td colSpan={9} className="py-16 text-center text-slate-400">Searching…</td></tr>
            ) : docs.length === 0 ? (
              <tr><td colSpan={9} className="py-16 text-center text-slate-400"><Filter className="mx-auto mb-2 text-slate-300" size={28} />No documents match your filters.</td></tr>
            ) : docs.map((d) => {
              const m = d.metadata || {};
              const rm = reviewMeta(d.review_status);
              const snip = mode === 'pattern' ? d.snippet : null;
              return (
              <Fragment key={d.id}>
                <tr className={`hover:bg-accent/[0.03] transition ${snip ? 'border-b-0' : ''}`}>
                  <td className="px-3 py-2.5">
                    <button onClick={(e) => toggleBookmark(d, e)} title="Bookmark">
                      <Bookmark size={16} className={d.bookmarked ? 'fill-accent text-accent' : 'text-slate-300 hover:text-slate-400'} />
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link to={`/cases/${caseId}/documents/${d.id}`} className="font-medium text-navy-900 hover:text-accent-dark">{d.control_number}</Link>
                  </td>
                  <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDate(m.DATE)}</td>
                  <td className="px-3 py-2.5 text-slate-600 max-w-[200px] truncate" title={`${m.FROM || ''} → ${m.TO || ''}`}>
                    <div className="truncate">{m.FROM || '—'}</div>
                    <div className="truncate text-xs text-slate-400">{m.TO || ''}</div>
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 max-w-[260px] truncate" title={m.SUBJECT}>{m.SUBJECT || m.FILENAME || '—'}</td>
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
