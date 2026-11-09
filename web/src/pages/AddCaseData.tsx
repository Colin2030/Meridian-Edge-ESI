import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import {
  ChevronLeft, UploadCloud, FileText, FileSpreadsheet, FileType2, FileArchive,
  X, CheckCircle2, AlertTriangle, Loader2, Info, History, ArrowRight,
  Network, Server, RefreshCw, RotateCcw,
} from 'lucide-react';

interface CaseInfo { id: number; name: string; case_number: string; role: string; }
interface ImportRow {
  id: number; name: string; dat_filename: string | null; opt_filename: string | null; xml_filename?: string | null;
  status: string; phase: string | null; doc_count: number; page_count: number;
  docs_total?: number; docs_done?: number; pages_done?: number;
  enqueued_at?: string | null; attempts?: number; queue_position?: number | null;
  error: string | null; source_kind: string | null; imported_at: string; imported_by_name: string | null;
}

function fileKind(name: string): { label: string; icon: JSX.Element; key: string } {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'dat') return { label: 'DAT · metadata', key: 'dat', icon: <FileSpreadsheet size={16} className="text-accent" /> };
  if (ext === 'opt') return { label: 'OPT · image references', key: 'opt', icon: <FileText size={16} className="text-accent" /> };
  if (ext === 'xml') return { label: 'EDRM XML · loadfile', key: 'xml', icon: <FileSpreadsheet size={16} className="text-accent" /> };
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

// Badge label keyed on the import STATUS (queued -> processing -> completed/failed).
const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued', processing: 'Processing', pending: 'Queued',
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
  // Network / folder location source
  const [sourceTab, setSourceTab] = useState<'upload' | 'path'>('upload');
  const [pathValue, setPathValue] = useState('');
  const [pathName, setPathName] = useState('');
  const [pathOcr, setPathOcr] = useState(false);
  const [pathSubmitting, setPathSubmitting] = useState(false);

  useEffect(() => {
    api.get<CaseInfo>(`/api/cases/${caseId}`).then(setInfo).catch(() => {});
  }, [caseId]);

  const loadHistory = useCallback(() => {
    api.get<ImportRow[]>(`/api/cases/${caseId}/imports`)
      .then(setHistory)
      .catch((e) => { if (e.status === 403) setDenied(true); });
  }, [caseId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Keep the queue overview + history live while anything is queued or processing,
  // so the active item's progress and the queue order update without a reload.
  useEffect(() => {
    const hasActive = history.some((h) => h.status === 'queued' || h.status === 'processing');
    if (!hasActive) return;
    const t = setInterval(loadHistory, 4000);
    return () => clearInterval(t);
  }, [history, loadHistory]);

  // Self-service retry / reset for stuck imports.
  const [actionBusy, setActionBusy] = useState<number | null>(null);
  const [actionErr, setActionErr] = useState<string>('');

  const retryImport = useCallback(async (id: number) => {
    setActionErr('');
    setActionBusy(id);
    try {
      await api.post(`/api/cases/${caseId}/imports/${id}/retry`, {});
      loadHistory();
      // Poll the history briefly so progress is seen advancing again.
      setTimeout(loadHistory, 2500);
      setTimeout(loadHistory, 6000);
    } catch (e: any) {
      setActionErr(e?.message || 'Could not retry this import.');
    } finally {
      setActionBusy(null);
    }
  }, [caseId, loadHistory]);

  const resetImport = useCallback(async (id: number) => {
    setActionErr('');
    setActionBusy(id);
    try {
      await api.post(`/api/cases/${caseId}/imports/${id}/reset`, {});
      loadHistory();
    } catch (e: any) {
      setActionErr(e?.message || 'Could not reset this import.');
    } finally {
      setActionBusy(null);
    }
  }, [caseId, loadHistory]);

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
    xml: files.find((f) => f.name.toLowerCase().endsWith('.xml')),
    zip: files.find((f) => f.name.toLowerCase().endsWith('.zip')),
    images: files.filter((f) => /\.(tif|tiff|pdf)$/i.test(f.name)),
  };
  const hasZip = !!detected.zip;
  const hasEdrm = !!detected.xml;
  const readyToSubmit = files.length > 0 && (hasZip || !!detected.dat || hasEdrm);

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
        setJob({ id: r.importId, name: '', dat_filename: r.datFile || r.xmlFile || null, opt_filename: r.optFile || null, xml_filename: r.xmlFile || null, status: 'queued', phase: 'parsing', doc_count: 0, page_count: 0, error: null, source_kind: r.format === 'edrm' ? 'edrm' : null, imported_at: new Date().toISOString(), imported_by_name: user?.displayName || null });
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

  // Ingest from a server-reachable network / folder location (no browser upload).
  const submitPath = async () => {
    const p = pathValue.trim();
    if (!p || pathSubmitting) return;
    setErr(''); setJob(null); setPathSubmitting(true);
    try {
      const r = await api.post<{ importId: number; datFile?: string; optFile?: string | null; xmlFile?: string; format?: string }>(
        `/api/cases/${caseId}/imports/path`,
        { path: p, name: pathName.trim() || undefined, ocr: pathOcr },
      );
      setPathValue(''); setPathName(''); setPathOcr(false);
      setJob({ id: r.importId, name: '', dat_filename: r.datFile || r.xmlFile || null, opt_filename: r.optFile || null, xml_filename: r.xmlFile || null, status: 'queued', phase: 'parsing', doc_count: 0, page_count: 0, error: null, source_kind: r.format === 'edrm' ? 'edrm' : 'path', imported_at: new Date().toISOString(), imported_by_name: user?.displayName || null });
      pollStatus(r.importId);
    } catch (e: any) {
      setErr(e?.message || 'The location could not be read by the server.');
    } finally {
      setPathSubmitting(false);
    }
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
              Accepted formats: a Concordance <strong>.DAT</strong> (metadata) with an optional <strong>.OPT</strong> (image
              cross-reference) and <strong>TIFF / PDF</strong> page images; or an <strong>EDRM XML 1.2</strong> loadfile
              (<strong>edrm.xml</strong>) with its <strong>natives/</strong> folder. Supply the files individually or bundled
              inside a single <strong>.zip</strong> — the format is detected automatically.
            </p>
          </div>
        </div>
      </div>

      {/* Source selector */}
      {!job && (
        <>
        <div className="mt-4 flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1 w-fit">
          <button
            type="button"
            onClick={() => { setSourceTab('upload'); setErr(''); }}
            className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition ${sourceTab === 'upload' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <UploadCloud size={15} /> Upload files
          </button>
          <button
            type="button"
            onClick={() => { setSourceTab('path'); setErr(''); }}
            className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition ${sourceTab === 'path' ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <Network size={15} /> Network / folder location
          </button>
        </div>
        </>
      )}

      {/* Uploader */}
      {!job && sourceTab === 'upload' && (
        <div className="card p-5 mt-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files); }}
            className={`rounded-xl border-2 border-dashed p-8 text-center transition ${dragOver ? 'border-accent bg-accent/5' : 'border-slate-300 bg-slate-50'}`}
          >
            <UploadCloud size={36} className={`mx-auto mb-2 ${dragOver ? 'text-accent' : 'text-slate-400'}`} />
            <p className="font-medium text-navy-900">Drag &amp; drop your loadfile folder as a <span className="text-accent-dark">.zip</span></p>
            <p className="text-sm text-slate-500 mt-0.5">or select the .DAT, .OPT and TIFF/PDF files — or an EDRM XML loadfile — individually</p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button className="btn-primary" onClick={() => fileInput.current?.click()}>Select files</button>
            </div>
            <input ref={fileInput} type="file" multiple hidden
              accept=".dat,.opt,.xml,.zip,.tif,.tiff,.pdf"
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
                ) : hasEdrm ? (
                  <span className="badge bg-emerald-50 text-emerald-700"><CheckCircle2 size={13} /> EDRM XML loadfile detected — its natives/ folder will be read on the server</span>
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

      {/* Network / folder location panel */}
      {!job && sourceTab === 'path' && (
        <div className="card p-5 mt-3">
          <div className="flex gap-3">
            <Server size={20} className="text-accent shrink-0 mt-0.5" />
            <div className="text-sm text-slate-600 leading-relaxed">
              <p className="font-semibold text-navy-900">Read a loadfile from a server location</p>
              <p className="mt-1">
                Point Meridian Edge at a folder the <strong>server</strong> can reach — a mounted network share
                (NFS / SMB), or BLOB storage mounted as a path. The server reads the Concordance <strong>.DAT</strong> /
                <strong> .OPT</strong> and page images — or an <strong>EDRM XML</strong> loadfile with its <strong>natives/</strong>
                folder — directly from that location; nothing is uploaded through the browser. Suitable for corporate
                deployments where processed data is placed on a share rather than uploaded.
              </p>
            </div>
          </div>

          <div className="mt-4">
            <label className="label" htmlFor="ingest-path">Server path</label>
            <input
              id="ingest-path"
              className="input font-mono text-sm"
              placeholder="/mnt/esi-shares/operation-kingfisher"
              value={pathValue}
              onChange={(e) => { setPathValue(e.target.value); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitPath(); }}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="mt-1.5 text-xs text-slate-500">
              An absolute path on the Meridian Edge server, for example
              <span className="font-mono"> /mnt/esi-shares/operation-kingfisher</span> or
              <span className="font-mono"> \\fileserver\esi\OperationKingfisher</span> once mounted. You may point to the
              folder containing the <strong>.DAT</strong> (or <strong>edrm.xml</strong>), or directly to the <strong>.DAT</strong> file.
            </p>
          </div>

          <div className="mt-4">
            <label className="label" htmlFor="ingest-name">Set name <span className="font-normal text-slate-400">(optional)</span></label>
            <input
              id="ingest-name"
              className="input"
              placeholder="e.g. Operation Kingfisher — first production"
              value={pathName}
              onChange={(e) => setPathName(e.target.value)}
              autoComplete="off"
            />
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm text-slate-600 select-none cursor-pointer">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-accent focus:ring-accent" checked={pathOcr} onChange={(e) => setPathOcr(e.target.checked)} />
            Run OCR on page images without extracted text
          </label>

          {err && <div className="mt-4 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700 flex items-center gap-2"><AlertTriangle size={16} /> {err}</div>}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button className="btn-primary" disabled={!pathValue.trim() || pathSubmitting} onClick={submitPath}>
              {pathSubmitting ? <><Loader2 size={16} className="animate-spin" /> Reading…</> : <><Network size={16} /> Import from location</>}
            </button>
          </div>
        </div>
      )}

      {/* Live import progress */}
      {job && (
        <div className="card p-6 mt-4">
          {job.status !== 'completed' && job.status !== 'failed' && (
            <div>
              <div className="flex items-center gap-2 text-navy-900 font-semibold">
                <Loader2 size={18} className="animate-spin text-accent" /> {job.status === 'queued' ? 'Queued for import…' : 'Importing…'}
              </div>
              <p className="text-sm text-slate-500 mt-1">
                {job.status === 'queued'
                  ? 'Waiting for the import worker. Large sets are processed one at a time and survive a server restart, so this part will start — or resume — automatically.'
                  : `${PHASE_LABEL[job.phase || 'pending'] || 'Working'}${job.docs_total ? ` — document ${job.docs_done || 0} of ${job.docs_total} (${job.pages_done || 0} pages)` : ''}`}
              </p>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden mt-3">
                <div
                  className={`h-full transition-all ${job.status === 'queued' ? 'bg-accent/40 animate-pulse' : 'bg-accent'}`}
                  style={{ width: job.status === 'queued' ? '100%' : `${Math.max(pct, 6)}%` }}
                />
              </div>
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

      {/* Import queue overview — which part is processing now, and what is waiting */}
      {(() => {
        const processing = history.filter((h) => h.status === 'processing');
        const queued = history
          .filter((h) => h.status === 'queued')
          .sort((a, b) => (a.queue_position || 0) - (b.queue_position || 0));
        if (processing.length === 0 && queued.length === 0) return null;
        const labelOf = (h: ImportRow) => h.name || h.dat_filename || h.xml_filename || `Import ${h.id}`;
        return (
          <div className="mt-6 card p-4 border-l-4 border-l-accent">
            <div className="flex items-center gap-2 text-sm font-semibold text-navy-900">
              <Loader2 size={15} className="animate-spin text-accent" /> Import queue
              <span className="font-normal text-slate-400">· processed one at a time, restart-safe</span>
            </div>
            <div className="mt-2 space-y-1.5 text-sm text-slate-600">
              {processing.map((h) => (
                <div key={h.id} className="flex items-center gap-2 flex-wrap">
                  <span className="badge bg-amber-50 text-amber-700">Processing</span>
                  <span className="font-medium text-navy-900">{labelOf(h)}</span>
                  <span className="text-slate-500">{h.docs_total ? `— ${h.docs_done || 0}/${h.docs_total} documents` : '— starting…'}</span>
                </div>
              ))}
              {queued.length > 0 && (
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="badge bg-accent/10 text-accent-dark whitespace-nowrap">Queued · {queued.length}</span>
                  <span className="text-slate-600">
                    {queued.map((h, i) => (
                      <span key={h.id}>{i > 0 ? ', ' : ''}<span className="font-medium text-navy-900">{labelOf(h)}</span></span>
                    ))}
                  </span>
                </div>
              )}
              {processing.length === 0 && queued.length > 0 && (
                <div className="text-xs text-slate-400">The worker will start the first queued item within a few seconds.</div>
              )}
            </div>
          </div>
        );
      })()}

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
                <th className="px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.length === 0 ? (
                <tr><td colSpan={7} className="py-10 text-center text-slate-400">No imports yet for this case.</td></tr>
              ) : history.map((h) => {
                const st = h.status;
                const cls = st === 'completed' ? 'bg-emerald-50 text-emerald-700'
                  : st === 'failed' ? 'bg-rose-50 text-rose-700'
                  : st === 'queued' ? 'bg-accent/10 text-accent-dark'
                  : 'bg-amber-50 text-amber-700';
                const canRetry = st === 'processing' || st === 'failed';
                const canReset = st === 'queued' || st === 'processing' || st === 'failed';
                return (
                  <tr key={h.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDateTime(h.imported_at)}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-navy-900">{h.name}</div>
                      <div className="text-xs text-slate-400">{h.source_kind === 'edrm' ? (h.xml_filename || 'EDRM XML') : `${h.dat_filename || ''}${h.opt_filename ? ` + ${h.opt_filename}` : ''}`}{h.source_kind === 'edrm' ? ' · EDRM XML' : ''}{h.source_kind === 'zip' ? ' · from .zip' : ''}{h.source_kind === 'path' ? ' · from server location' : ''}</div>
                      {h.error && st !== 'failed' && <div className="text-xs text-amber-600 mt-0.5">{h.error}</div>}
                      {h.error && st === 'failed' && <div className="text-xs text-rose-600 mt-0.5">{h.error}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{h.imported_by_name || '—'}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{h.doc_count}</td>
                    <td className="px-3 py-2.5 text-right text-slate-600">{h.page_count}</td>
                    <td className="px-3 py-2.5">
                      <span className={`badge ${cls}`}>{STATUS_LABEL[st] || PHASE_LABEL[st] || st}</span>
                      {st === 'queued' && h.queue_position ? (
                        <div className="text-xs text-slate-400 mt-0.5">Position {h.queue_position} in queue</div>
                      ) : null}
                      {st === 'processing' && h.docs_total ? (
                        <div className="text-xs text-slate-400 mt-0.5">{h.docs_done || 0}/{h.docs_total} docs</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {canRetry && (
                          <button
                            onClick={() => retryImport(h.id)}
                            disabled={actionBusy === h.id}
                            className="btn-outline inline-flex items-center gap-1 px-2 py-1 text-xs"
                            title="Re-run this import from its staged source"
                          >
                            {actionBusy === h.id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Retry
                          </button>
                        )}
                        {canReset && (
                          <button
                            onClick={() => resetImport(h.id)}
                            disabled={actionBusy === h.id}
                            className="btn-outline inline-flex items-center gap-1 px-2 py-1 text-xs"
                            title="Mark this interrupted import as failed (keeps it for audit)"
                          >
                            <RotateCcw size={13} /> Reset
                          </button>
                        )}
                        {!canRetry && !canReset && <span className="text-xs text-slate-300">—</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {actionErr && (
          <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2 inline-flex items-center gap-1">
            <AlertTriangle size={13} /> {actionErr}
          </div>
        )}
      </div>
    </div>
  );
}
