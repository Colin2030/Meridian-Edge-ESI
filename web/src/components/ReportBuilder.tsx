import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { X, FileSpreadsheet, FileText, Loader2, ClipboardList, Info } from 'lucide-react';

interface ReportTag { id: number; name: string; colour: string; parent_id: number | null; doc_count: number; }

/**
 * Report builder — produces a production-request document list filtered by the
 * tags the reviewer has applied, for the forensics / eDiscovery team to pull the
 * native files. Exports as CSV or Excel (.xlsx).
 */
export function ReportBuilder({ caseId, caseName, onClose }: { caseId: number | string; caseName?: string; onClose: () => void }) {
  const [tags, setTags] = useState<ReportTag[]>([]);
  const [totalDocuments, setTotalDocuments] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [match, setMatch] = useState<'any' | 'all'>('any');
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    api.get<{ tags: ReportTag[]; totalDocuments: number }>(`/api/cases/${caseId}/reports/tags`)
      .then((r) => { setTags(r.tags); setTotalDocuments(r.totalDocuments); })
      .catch((e) => setLoadErr(e?.message || 'Could not load tags.'));
  }, [caseId]);

  const selectedIds = Array.from(selected);
  const tagsQuery = selectedIds.join(',');

  // Live preview of how many documents the current filter will include.
  const refreshCount = useCallback(() => {
    setCounting(true);
    const qs = new URLSearchParams({ format: 'json', match });
    if (tagsQuery) qs.set('tags', tagsQuery);
    api.get<{ count: number }>(`/api/cases/${caseId}/reports/documents?${qs.toString()}`)
      .then((r) => setCount(r.count))
      .catch(() => setCount(null))
      .finally(() => setCounting(false));
  }, [caseId, tagsQuery, match]);

  useEffect(() => { refreshCount(); }, [refreshCount]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exportUrl = (format: 'csv' | 'xlsx') => {
    const qs = new URLSearchParams({ format, match });
    if (tagsQuery) qs.set('tags', tagsQuery);
    return `/api/cases/${caseId}/reports/documents?${qs.toString()}`;
  };

  // Downloads are authenticated via the same-origin session cookie; a temporary
  // anchor click triggers the browser download of the attachment response.
  const download = (format: 'csv' | 'xlsx') => {
    const a = document.createElement('a');
    a.href = exportUrl(format);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4 sm:p-8" onMouseDown={onClose}>
      <div className="card w-full max-w-2xl p-6 mt-4" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <ClipboardList size={22} className="text-accent shrink-0 mt-0.5" />
            <div>
              <h2 className="text-lg font-bold text-navy-900">Report builder — document list</h2>
              <p className="text-sm text-slate-500">{caseName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" title="Close"><X size={20} /></button>
        </div>

        <div className="mt-3 rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 flex gap-2">
          <Info size={15} className="text-accent shrink-0 mt-0.5" />
          <span>
            Produces a document list — <strong>Doc Name, Doc ID, DOCTYPE, Custodian, Comments, Tags</strong> — to send to the
            forensics / eDiscovery team so they can locate and produce the native files.
          </span>
        </div>

        {loadErr && <div className="mt-4 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{loadErr}</div>}

        {/* Tag checklist */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="label !mb-0">Filter by applied tags</span>
            {selected.size > 0 && (
              <button className="btn-ghost text-xs text-slate-500" onClick={() => setSelected(new Set())}>Clear selection</button>
            )}
          </div>
          {tags.length === 0 ? (
            <p className="text-sm text-slate-400 py-3">No tags have been created in this case yet. You can still export the full document list below.</p>
          ) : (
            <div className="max-h-60 overflow-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
              {tags.map((t) => (
                <label key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50 select-none">
                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent"
                    checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: t.colour }} />
                  <span className="font-medium text-navy-900 flex-1">{t.name}</span>
                  <span className="text-xs text-slate-400">{t.doc_count} doc{t.doc_count === 1 ? '' : 's'}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Match toggle */}
        <div className="mt-4">
          <span className="label">When multiple tags are selected, include documents with</span>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 w-fit">
            <button onClick={() => setMatch('any')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${match === 'any' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              Any selected tag
            </button>
            <button onClick={() => setMatch('all')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${match === 'all' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              All selected tags
            </button>
          </div>
        </div>

        {/* Preview count */}
        <div className="mt-4 rounded-md bg-accent/5 border border-accent/20 px-3 py-2.5 text-sm text-navy-900 flex items-center gap-2">
          {counting ? <Loader2 size={16} className="animate-spin text-accent" /> : <FileText size={16} className="text-accent" />}
          {selected.size === 0 ? (
            <span><strong>{count ?? totalDocuments}</strong> document(s) — the full case list (no tag filter)</span>
          ) : (
            <span><strong>{count ?? '…'}</strong> document(s) match the selected tag{selected.size > 1 ? `s (${match === 'all' ? 'all' : 'any'})` : ''}</span>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-slate-500">Cancel</button>
          <button onClick={() => download('csv')} disabled={count === 0} className="btn-outline">
            <FileText size={16} /> Export CSV
          </button>
          <button onClick={() => download('xlsx')} disabled={count === 0} className="btn-primary">
            <FileSpreadsheet size={16} /> Export Excel (.xlsx)
          </button>
        </div>
      </div>
    </div>
  );
}
