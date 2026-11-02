import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import {
  ChevronLeft, UploadCloud, FileText, FileSpreadsheet, FileType2, FileArchive,
  X, CheckCircle2, AlertTriangle, Loader2, Info, History, ArrowRight,
} from 'lucide-react';

interface CaseInfo { id: number; name: string; case_number: string; role: string; }
interface ImportRow {
  id: number; name: string; dat_filename: string; opt_filename: string | null;
  status: string; phase: string | null; doc_count: number; page_count: number;
  docs_total?: number; docs_done?: number; pages_done?: number;
  error: string | null; source_kind: string | null; imported_at: string; imported_by_name: string | null;
}

function fileKind(name: string): { label: string; icon: JSX.Element; key: string } {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'dat') return { label: 'DAT · metadata', key: 'dat', icon: <FileSpreadsheet size={16} className="text-accent" /> };
  if (ext === 'opt') return { label: 'OPT · image references', key: 'opt', icon: <FileText size={16} className="text-accent" /> };
  if (ext === 'zip') return { label: 'ZIP · archive', key: 'zip', icon: <FileArchive size={16} className="text-accent" /> };
  if (ext === 'pdf') return { label: 'PDF · image', key: 'img', icon: <FileType2 size={16} className="text-rose-500" /> };
  if (ext === 'tif' || ext === 'tiff') return { label: 'TIFF · image', key: 'img', icon: <FileText size={16} className="text-sky-600" /> };
  return { label: ext.toUpperCase() || 'file', key: 'other', icon: <FileText size={16} className="text-slate-400" /> };
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const PHASE_LABEL: Record<string, string> = {
  pending: 'Queued', parsing: 'Reading loadfile', rendering: 'Rendering pages',
  completed: 'Complete', failed: 'Failed',
};

export default function AddCaseData() {
  const { caseId } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const [info, setInfo] = useState<CaseInfo | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [job, setJob] = useState<ImportRow | null>(null);
  const [err, setErr] = useState('');
  const [history, setHistory] = useState<ImportRow[]>([]);
  const [denied, setDenied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo).catch(() => {});
  }, [caseId]);

  const loadHistory = useCallback(() => {
    api.get<ImportRow[]>(`/api/cases/${caseId}/imports`)
      .then(setHistory)
      .catch((e) => { if (e.status === 403) setDenied(true); });
  }, [caseId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Guard: only managers/admins. (API also enforces; this is UX only.)
  const canManage = info?.role === 'system_admin' || info?.role === 'case_manager';
  useEffect(() => {
    if (info && !canManage) setDenied(true);
  }, [info, canManage]);

  const addFiles = (list: FileList | File[]) => {
    const incoming = Array.from(list);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...incoming.filter((f) => !seen.has(f.name + f.size))];
    });
    setErr('');
  };

  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const detected = {
    dat: files.find((f) => f.name.toLowerCase().endsWith('.dat')),
    opt: files.find((f) => f.name.toLowerCase().endsWith('.opt')),
    zip: files.find((f) => f.name.toLowerCase().endsWith('.zip')),
    images: files.filter((f) => /\.(tif|tiff|pdf)$/i.test(f.name)),
  };
  const hasZip = !!detected.zip;
  const readyToSubmit = files.length > 0 && (hasZip || !!detected.dat);

  const pollStatus = useCallback((importId: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.get<ImportRow>(`/api/cases/${caseId}/imports/${importId}`);
        setJob(s);
        if (s.status === 'completed' || s.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          loadHistory();
        }
      } catch {
        /* keep polling a couple of times on transient errors */
      }
    }, 900);
  }, [caseId, loadHistory]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const submit = () => {
    if (!readyToSubmit) return;
    setErr(''); setJob(null); setUploadPct(0);
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/cases/${caseId}/imports`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploadPct(null);
      if (xhr.status === 202) {
        const r = JSON.parse(xhr.responseText);
        setFiles([]);
        setJob({ id: r.importId, name: '', dat_filename: r.datFile, opt_filename: r.optFile, status: 'pending', phase: 'parsing', doc_count: 0, page_count: 0, error: null, source_kind: null, imported_at: new Date().toISOString(), imported_by_name: user?.displayName || null });
        pollStatus(r.importId);
      } else {
        let msg = 'Upload failed.';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
        setErr(msg);
      }
    };
    xhr.onerror = () => { setUploadPct(null); setErr('Network error during upload.'); };
    xhr.send(fd);
  };

  if (denied) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 text-center">
        <AlertTriangle className="mx-auto mb-3 text-amber-500" size={34} />
        <h1 className="text-xl font-bold text-navy-900">Not available</h1>
        <p className="mt-2 text-slate-500">Importing case data requires the <strong>Case manager</strong> role (or system administrator).</p>
        <Link to={`/cases/${caseId}`} className="btn-outline mt-5 inline-flex"><ChevronLeft size={16} /> Back to case</Link>
      </div>
    );
  }

  const busy = uploadPct !== null || !!(job && job.status !== 'completed' && job.status !== 'failed');
  const pct = job?.docs_total ? Math.round(((job.docs_done || 0) / job.docs_total) * 100) : 0;

  return (
    <div className="mx-auto max-w-4xl px-5 py-6">
      <Link to={`/cases/${caseId}`} className="text-sm text-slate-400 hover:text-slate-600 flex items-center gap-1"><ChevronLeft size={14} /> Back to case</Link>
      <h1 className="text-2xl font-bold text-navy-900 mt-1">Add case data</h1>
      <p className="text-sm text-slate-500">{info?.name} · {info?.case_number}</p>

      {/* Explainer */}
      <div className="card p-5 mt-5 border-l-4 border-l-accent">
        <div className="flex gap-3">
          <Info size={20} className="text-accent shrink-0 mt-0.5" />
          <div className="text-sm text-slate-600 leading-relaxed">
            <p className="font-semibold text-navy-900">Import an already-processed evidence deliverable</p>
            <p className="mt-1">
              Meridian Edge loads data that has already been processed into a standard <strong>loadfile</strong> by your
              processing tool — it does not process raw evidence itself. Upload the loadfile set and the platform will
              index the documents and make the pages viewable and searchable.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Expected: a <strong>.DAT</strong> (metadata), an optional <strong>.OPT</strong> (image cross-reference), and the
              <strong> TIFF / PDF</strong> page images — either as individual files or bundled inside a single <strong>.zip</strong>.
            </p>
          </div>
        </div>
      </div>

      {/* Uploader */}
      {!job && (
        <div className="card p-5 mt-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
            className={`rounded-xl border-2 border-dashed p-8 text-center transition ${dragOver ? 'border-accent bg-accent/5' : 'border-slate-300 bg-slate-50'}`}
          >
            <UploadCloud size={36} className={`mx-auto mb-2 ${dragOver ? 'text-accent' : 'text-slate-400'}`} />
            <p className="font-medium text-navy-900">Drag &amp; drop your loadfile folder as a <span className="text-accent-dark">.zip</span></p>
            <p className="text-sm text-slate-500 mt-0.5">or select the .DAT, .OPT and TIFF/PDF files individually</p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button className="btn-primary" onClick={() => fileInput.current?.click()}>Select files</button>
            </div>
            <input ref={fileInput} type="file" multiple hidden
              accept=".dat,.opt,.zip,.tif,.tiff,.pdf"
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          </div>

          {/* Selected files */}
          {files.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <span className="label !mb-0">Selected ({files.length})</span>
                <button className="btn-ghost text-xs text-slate-500" onClick={() => setFiles([])}>Clear all</button>
              </div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {files.map((f, i) => {
                  const k = fileKind(f.name);
                  return (
                    <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                      {k.icon}
                      <span className="font-medium text-navy-900 truncate flex-1" title={f.name}>{f.name}</span>
                      <span className="text-xs text-slate-400 whitespace-nowrap">{k.label}</span>
                      <span className="text-xs text-slate-400 w-20 text-right">{humanSize(f.size)}</span>
                      <button onClick={() => removeFile(i)} className="text-slate-300 hover:text-rose-500" title="Remove"><X size={15} /></button>
                    </li>
                  );
                })}
              </ul>

              {/* Detection summary */}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {hasZip ? (
                  <span className="badge bg-accent/10 text-accent-dark"><FileArchive size={13} /> ZIP archive — contents will be read on the server</span>
                ) : (
                  <>
                    <span className={`badge ${detected.dat ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      {detected.dat ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} .DAT {detected.dat ? 'detected' : 'required — not found'}
                    </span>
                    <span className={`badge ${detected.opt ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {detected.opt ? <CheckCircle2 size={13} /> : <Info size={13} />} .OPT {detected.opt ? 'detected' : 'optional'}
                    </span>
                    <span className="badge bg-slate-100 text-slate-600">{detected.images.length} image file(s)</span>
                  </>
                )}
              </div>
            </div>
          )}

          {err && <div className="mt-4 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700 flex items-center gap-2"><AlertTriangle size={16} /> {err}</div>}

          {uploadPct !== null && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-slate-500 mb-1"><span>Uploading…</span><span>{uploadPct}%</span></div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${uploadPct}%` }} /></div>
            </div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button className="btn-primary" disabled={!readyToSubmit || busy} onClick={submit}>
              {busy ? <><Loader2 size={16} className="animate-spin" /> Working…</> : <><UploadCloud size={16} /> Import into {info?.name || 'case'}</>}
            </button>
          </div>
          {!readyToSubmit && files.length > 0 && !hasZip && (
            <p className="mt-2 text-right text-xs text-rose-600">A .DAT loadfile is required (or upload a .zip containing one).</p>
          )}
        </div>
      )}

      {/* Live import progress */}
      {job && (
        <div className="card p-6 mt-4">
          {job.status !== 'completed' && job.status !== 'failed' && (
            <div>
              <div className="flex items-center gap-2 text-navy-900 font-semibold"><Loader2 size={18} className="animate-spin text-accent" /> Importing…</div>
              <p className="text-sm text-slate-500 mt-1">{PHASE_LABEL[job.phase || 'pending'] || 'Working'}{job.docs_total ? ` — document ${job.docs_done || 0} of ${job.docs_total} (${job.pages_done || 0} pages)` : ''}</p>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden mt-3"><div className="h-full bg-accent transition-all" style={{ width: `${Math.max(pct, 6)}%` }} /></div>
            </div>
          )}
          {job.status === 'completed' && (
            <div className="text-center py-4">
              <CheckCircle2 size={40} className="mx-auto text-emerald-500" />
              <h2 className="text-lg font-bold text-navy-900 mt-2">Import complete</h2>
              <p className="text-slate-600 mt-1">Imported <strong>{job.doc_count}</strong> document(s) / <strong>{job.page_count}</strong> page(s) into <strong>{info?.name}</strong>.</p>
              {job.error && <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 inline-block"><AlertTriangle size={13} className="inline mr-1" />{job.error}</p>}
              <div className="mt-5 flex items-center justify-center gap-2">
                <button className="btn-primary" onClick={() => nav(`/cases/${caseId}/review`)}>Review documents <ArrowRight size={16} /></button>
                <button className="btn-outline" onClick={() => { setJob(null); setFiles([]); }}>Import another</button>
              </div>
            </div>
          )}
          {job.status === 'failed' && (
            <div className="text-center py-4">
              <AlertTriangle size={40} className="mx-auto text-rose-500" />
              <h2 className="text-lg font-bold text-navy-900 mt-2">Import failed</h2>
              <p className="text-rose-700 mt-1 text-sm max-w-lg mx-auto">{job.error || 'The import could not be completed.'}</p>
              <button className="btn-outline mt-5" onClick={() => { setJob(null); }}>Try again</button>
            </div>
          )}
        </div>
      )}

      {/* Import history */}
      <div className="mt-8">
        <div className="flex items-center gap-2 mb-3 text-navy-900"><History size={18} /><h2 className="font-semibold">Import history</h2></div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5">Date</th>
                <th className="px-3 py-2.5">Name / files</th>
                <th className="px-3 py-2.5">By</th>
                <th className="px-3 py-2.5 text-right">Docs</th>
                <th className="px-3 py-2.5 text-right">Pages</th>
                <th className="px-3 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.length === 0 ? (
                <tr><td colSpan={6} className="py-10 text-center text-slate-400">No imports yet for this case.</td></tr>
              ) : history.map((h) => {
                const st = h.status;
                const cls = st === 'completed' ? 'bg-emerald-50 text-emerald-700' : st === 'failed' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700';
                return (
                  <tr key={h.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDateTime(h.imported_at)}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-navy-900">{h.name}</div>
                      <div className="text-xs text-slate-400">{h.dat_filename}{h.opt_filename ? ` + ${h.opt_filename}` : ''}{h.source_kind === 'zip' ? ' · from .zip' : ''}</div>
                      {h.error && st !== 'failed' && <div className="text-xs text-amber-600 mt-0.5">{h.error}</div>}
                      {h.error && st === 'failed' && <div className="text-xs text-rose-600 mt-0.5">{h.error}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{h.imported_by_name || '—'}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{h.doc_count}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{h.page_count}</td>
                    <td className="px-3 py-2.5"><span className={`badge ${cls}`}>{PHASE_LABEL[st] || st}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
