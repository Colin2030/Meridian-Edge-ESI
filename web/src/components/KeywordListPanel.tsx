import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { UploadCloud, X, Download, ListChecks, AlertTriangle, FileText, Loader2 } from 'lucide-react';

export interface KwOptions { literal: boolean; caseSensitive: boolean; wholeWord: boolean; }

interface TermReport { term: string; invalid: string | null; hitCount: number; documents: { docId: number; controlNumber: string }[]; truncated: boolean; }
interface DocReport { docId: number; controlNumber: string; terms: string[]; }
interface Report {
  filename: string; termCount: number; options: KwOptions;
  terms: TermReport[]; documents: DocReport[]; zeroHitTerms: string[];
  invalidTerms: { term: string; reason: string }[]; matchedDocumentCount: number;
}

// Build a CSV string and trigger a client-side download (air-gapped; no network).
function downloadCsv(filename: string, rows: string[][]) {
  const esc = (v: string) => {
    const s = (v ?? '').toString();
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

export function KeywordListPanel({ caseId, onClose, onSelectTerm }: {
  caseId: string | number;
  onClose: () => void;
  onSelectTerm: (term: string, opts: KwOptions) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [literal, setLiteral] = useState(true);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    if (!file) { setError('Please choose a .txt file containing your search terms.'); return; }
    setRunning(true); setError(''); setReport(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('literal', String(literal));
      fd.append('caseSensitive', String(caseSensitive));
      fd.append('wholeWord', String(wholeWord));
      const res = await fetch(`/api/case/${caseId}/search/keyword-list`, { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) {
        let msg = res.statusText;
        try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
        throw new ApiError(res.status, msg);
      }
      setReport(await res.json());
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'The keyword list could not be processed. Please try again.');
    } finally {
      setRunning(false);
    }
  };

  const exportTerms = () => {
    if (!report) return;
    const rows: string[][] = [['Term', 'Hit count', 'Status']];
    for (const t of report.terms) rows.push([t.term, String(t.hitCount), t.invalid ? `Invalid: ${t.invalid}` : (t.hitCount === 0 ? 'No hits' : 'OK')]);
    downloadCsv(`keyword-hits-${report.filename.replace(/\.[^.]+$/, '')}.csv`, rows);
  };
  const exportDocs = () => {
    if (!report) return;
    const rows: string[][] = [['Control number', 'Matched terms', 'Term count']];
    for (const d of report.documents) rows.push([d.controlNumber, d.terms.join('; '), String(d.terms.length)]);
    downloadCsv(`keyword-documents-${report.filename.replace(/\.[^.]+$/, '')}.csv`, rows);
  };

  const curOpts: KwOptions = { literal, caseSensitive, wholeWord };

  return (
    <div className="card p-4 mb-4 border-accent/30">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-navy-900 flex items-center gap-2"><ListChecks size={18} className="text-accent-dark" /> Keyword list search</h3>
          <p className="text-sm text-slate-500 mt-0.5">Upload a plain-text file with one search term per line. Blank lines and lines starting with <code className="text-xs bg-slate-100 px-1 rounded">#</code> are ignored. Every term is searched across this case and you get a hit-count report.</p>
        </div>
        <button onClick={onClose} className="btn-ghost text-slate-500" title="Close"><X size={16} /></button>
      </div>

      <div className="flex flex-col lg:flex-row gap-3 lg:items-end">
        <div className="flex-1">
          <label className="label">Keyword file (.txt)</label>
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setReport(null); setError(''); }} />
            <button className="btn-outline" onClick={() => fileRef.current?.click()}><UploadCloud size={15} /> Choose file</button>
            <span className="text-sm text-slate-500 truncate">{file ? file.name : 'No file chosen'}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
        <OptionToggle label="Regular expression" help="Treat terms as regex patterns (off = plain text)" checked={!literal} onChange={(v) => setLiteral(!v)} />
        <OptionToggle label="Case sensitive" help="Match upper/lower case exactly" checked={caseSensitive} onChange={setCaseSensitive} />
        <OptionToggle label="Whole word only" help="Match complete words, not fragments" checked={wholeWord} onChange={setWholeWord} />
        <div className="flex-1" />
        <button className="btn-accent" disabled={running || !file} onClick={run}>
          {running ? <><Loader2 size={15} className="animate-spin" /> Searching…</> : <><ListChecks size={15} /> Run keyword search</>}
        </button>
      </div>

      {error && <div className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2 flex items-center gap-2"><AlertTriangle size={15} /> {error}</div>}

      {report && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <p className="text-sm text-slate-600">
              <span className="font-medium text-navy-900">{report.termCount}</span> term{report.termCount === 1 ? '' : 's'} searched ·
              <span className="font-medium text-navy-900"> {report.matchedDocumentCount}</span> document{report.matchedDocumentCount === 1 ? '' : 's'} matched
              {report.zeroHitTerms.length > 0 && <> · <span className="text-slate-500">{report.zeroHitTerms.length} with no hits</span></>}
            </p>
            <div className="flex gap-2">
              <button className="btn-outline" onClick={exportTerms}><Download size={14} /> Export term hits (CSV)</button>
              <button className="btn-outline" onClick={exportDocs}><Download size={14} /> Export documents (CSV)</button>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* Per-term hit counts */}
            <div>
              <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Terms &amp; hit counts</h4>
              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2">Term</th>
                      <th className="px-3 py-2 w-20 text-right">Hits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.terms.map((t, i) => (
                      <tr key={i} className="hover:bg-accent/[0.03]">
                        <td className="px-3 py-2">
                          {t.invalid ? (
                            <span className="text-rose-600 inline-flex items-center gap-1" title={t.invalid}><AlertTriangle size={13} /> {t.term}</span>
                          ) : t.hitCount > 0 ? (
                            <button className="text-navy-900 hover:text-accent-dark font-medium text-left"
                              title="Show these documents in the list" onClick={() => onSelectTerm(t.term, curOpts)}>{t.term}</button>
                          ) : (
                            <span className="text-slate-400">{t.term}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {t.invalid ? <span className="text-rose-500 text-xs">invalid</span>
                            : <span className={t.hitCount > 0 ? 'font-semibold text-navy-900' : 'text-slate-400'}>{t.hitCount}{t.truncated ? '+' : ''}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.zeroHitTerms.length > 0 && (
                <p className="text-xs text-slate-500 mt-2"><span className="font-medium">No hits:</span> {report.zeroHitTerms.join(', ')}</p>
              )}
              {report.invalidTerms.length > 0 && (
                <p className="text-xs text-rose-600 mt-1 flex items-start gap-1"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span><span className="font-medium">Skipped (invalid pattern):</span> {report.invalidTerms.map((t) => t.term).join(', ')}</span></p>
              )}
            </div>

            {/* Aggregated matching documents */}
            <div>
              <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Matching documents</h4>
              <div className="card overflow-hidden max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0">
                    <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2">Control #</th>
                      <th className="px-3 py-2">Matched terms</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.documents.length === 0 ? (
                      <tr><td colSpan={2} className="px-3 py-6 text-center text-slate-400">No documents matched any term.</td></tr>
                    ) : report.documents.map((d) => (
                      <tr key={d.docId} className="hover:bg-accent/[0.03]">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Link to={`/cases/${caseId}/documents/${d.docId}`} className="font-medium text-navy-900 hover:text-accent-dark inline-flex items-center gap-1">
                            <FileText size={13} className="text-slate-400" /> {d.controlNumber}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {d.terms.map((tm, j) => <span key={j} className="badge bg-accent/10 text-accent-dark">{tm}</span>)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionToggle({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void }) {
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
