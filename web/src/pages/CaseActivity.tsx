import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import {
  ChevronLeft, History, Server, UploadCloud, FileDown, Archive, ArchiveRestore,
  Trash2, AlertTriangle, CheckCircle2, Loader2, XCircle, Activity,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Case Activity — combined case history (#5/#8), batch verification & progress
// (#6/#9/#11) and the case-manager archive/delete controls (#10). All data
// comes from the session-authed /api/cases/:caseId/* endpoints added for the
// SPA; business rules live in the backend (retention.ts / batchRunner).
// ---------------------------------------------------------------------------

interface Attachment { id: string; filename: string; mime: string | null; size: number | null; }
interface HistoryEvent {
  kind: 'platform' | 'integrator';
  id: string; entryId?: string; at: string; action: string; title: string;
  detail?: string | null; target?: string | null; actor?: string | null;
  source?: { system?: string | null; version?: string | null; runId?: string | null };
  importId?: number | null; batchId?: string | null; postedBy?: string | null;
  attachments?: Attachment[];
}
interface Phase { phase: string; done: number; total: number; state: string; }
interface BatchStatus {
  batchId: string; caseId: number; status: string;
  expected: { items: number; files: number; bytes: number };
  phases: Phase[]; verification: any; endState: string | null; updatedAt: string;
}
interface CaseInfo { id: number; name: string; status: string; role: string; }

const PHASE_LABEL: Record<string, string> = {
  receiving: 'Receiving', storing: 'Storing', indexing_text: 'Indexing text',
  rendering: 'Rendering', linking: 'Linking', finalising: 'Finalising',
};

function fmtBytes(n?: number | null): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export default function CaseActivity() {
  const { caseId } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState<CaseInfo | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canManage = info?.role === 'system_admin' || info?.role === 'case_manager';
  const anyInFlight = batches.some((b) => b.status !== 'completed' && b.status !== 'completed_with_failures' && b.status !== 'failed');

  const loadInfo = useCallback(() => {
    api.get<any>(`/api/cases/${caseId}`).then((c) =>
      setInfo({ id: c.id, name: c.name, status: c.status || 'open', role: c.role })
    ).catch(() => {});
  }, [caseId]);

  const loadActivity = useCallback(() => {
    Promise.all([
      api.get<{ events: HistoryEvent[] }>(`/api/cases/${caseId}/history`),
      api.get<{ batches: BatchStatus[] }>(`/api/cases/${caseId}/batches`),
    ]).then(([h, b]) => { setEvents(h.events || []); setBatches(b.batches || []); })
      .catch((e) => setError(e?.message || 'Case activity could not be loaded.'))
      .finally(() => setLoading(false));
  }, [caseId]);

  useEffect(() => { loadInfo(); loadActivity(); }, [loadInfo, loadActivity]);

  // Poll while a batch is still running so progress updates live.
  useEffect(() => {
    if (!anyInFlight) return;
    const t = setInterval(loadActivity, 2500);
    return () => clearInterval(t);
  }, [anyInFlight, loadActivity]);

  const doArchive = async () => {
    if (!info) return;
    setBusy(true); setError('');
    try {
      const next = info.status === 'archived' ? 'open' : 'archived';
      await api.patch(`/api/cases/${caseId}/status`, { status: next });
      setNotice(next === 'archived' ? 'Case archived. It is hidden from the default case list but fully accessible.' : 'Case un-archived.');
      setConfirmArchive(false); loadInfo(); loadActivity();
    } catch (e: any) { setError(e?.message || 'Could not change the case status.'); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.del<any>(`/api/cases/${caseId}`);
      setConfirmDelete(false);
      const n = r?.documentsDeleted ?? 0;
      nav('/', { state: { flash: `Case deleted (${n} document${n === 1 ? '' : 's'}). It can be restored within ${r?.retentionDays ?? 7} days.` } });
    } catch (e: any) { setError(e?.message || 'Could not delete the case.'); setBusy(false); }
  };

  if (loading) return <div className="min-h-[60vh] grid place-items-center text-slate-400">Loading case activity…</div>;

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <Link to={`/cases/${caseId}`} className="text-sm text-slate-400 hover:text-slate-600 flex items-center gap-1"><ChevronLeft size={14} /> Back to case</Link>
          <div className="flex items-center gap-3 mt-1">
            <h1 className="text-2xl font-bold text-navy-900 flex items-center gap-2"><Activity size={22} className="text-accent-dark" /> Case activity</h1>
            {info?.status === 'archived' && <span className="badge bg-amber-100 text-amber-700">Archived</span>}
          </div>
          <p className="text-sm text-slate-500 mt-0.5">{info?.name} — history, import verification and management.</p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setConfirmArchive(true)} className="btn-outline" disabled={busy}>
              {info?.status === 'archived' ? <><ArchiveRestore size={16} /> Un-archive</> : <><Archive size={16} /> Archive</>}
            </button>
            <button onClick={() => setConfirmDelete(true)} className="btn-outline border-rose-200 text-rose-600 hover:bg-rose-50" disabled={busy}>
              <Trash2 size={16} /> Delete case
            </button>
          </div>
        )}
      </div>

      {notice && <div className="mb-4 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
      {error && <div className="mb-4 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">{error}</div>}

      {/* Verification & progress */}
      <section className="card p-5 mb-5">
        <h2 className="font-semibold text-navy-900 flex items-center gap-2 mb-3"><Server size={17} className="text-accent-dark" /> Import verification &amp; progress</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-slate-400">No item batches have been loaded into this case yet.</p>
        ) : (
          <div className="space-y-4">
            {batches.map((b) => <BatchCard key={b.batchId} b={b} />)}
          </div>
        )}
      </section>

      {/* Case history */}
      <section className="card p-5">
        <h2 className="font-semibold text-navy-900 flex items-center gap-2 mb-3"><History size={17} className="text-accent-dark" /> Case history</h2>
        {events.length === 0 ? (
          <p className="text-sm text-slate-400">No history has been recorded for this case yet.</p>
        ) : (
          <ol className="relative border-l border-slate-200 ml-2 space-y-4">
            {events.map((ev) => (
              <li key={ev.id} className="ml-4">
                <span className={`absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full ring-2 ring-white ${ev.kind === 'integrator' ? 'bg-accent' : 'bg-slate-300'}`} />
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-navy-900">{ev.title}</span>
                  <span className={`badge ${ev.kind === 'integrator' ? 'bg-accent/10 text-accent-dark' : 'bg-slate-100 text-slate-500'}`}>
                    {ev.kind === 'integrator' ? 'Integrator' : 'Platform'}
                  </span>
                  <span className="text-xs text-slate-400">{fmtDateTime(ev.at)}</span>
                </div>
                {ev.detail && <p className="text-sm text-slate-600 mt-0.5">{ev.detail}</p>}
                <div className="text-xs text-slate-400 mt-0.5 flex flex-wrap gap-x-3">
                  {ev.actor && <span>by {ev.actor}</span>}
                  {ev.postedBy && <span>posted by {ev.postedBy}</span>}
                  {ev.source?.system && <span>source: {ev.source.system}{ev.source.version ? ` v${ev.source.version}` : ''}</span>}
                  {ev.source?.runId && <span>run {ev.source.runId}</span>}
                </div>
                {ev.attachments && ev.attachments.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {ev.attachments.map((a) => (
                      <a key={a.id} href={`/api/cases/${caseId}/audit-entries/${ev.entryId}/attachments/${a.id}`}
                        className="btn-outline text-xs py-1" title={`Download ${a.filename}`}>
                        <FileDown size={13} /> {a.filename}{a.size != null ? ` (${fmtBytes(a.size)})` : ''}
                      </a>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Archive confirm */}
      {confirmArchive && (
        <ConfirmModal
          title={info?.status === 'archived' ? 'Un-archive this case?' : 'Archive this case?'}
          body={info?.status === 'archived'
            ? 'The case will return to the default case list.'
            : 'The case will be hidden from the default case list but remains fully accessible and can be un-archived at any time.'}
          confirmLabel={info?.status === 'archived' ? 'Un-archive' : 'Archive'}
          busy={busy} onCancel={() => setConfirmArchive(false)} onConfirm={doArchive}
        />
      )}
      {/* Delete confirm */}
      {confirmDelete && (
        <ConfirmModal danger
          title="Delete this case?"
          body="All documents in this case will be soft-deleted and hidden from review. They can be restored within the 7-day retention window, after which they are permanently removed."
          confirmLabel="Delete case"
          busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={doDelete}
        />
      )}
    </div>
  );
}

function BatchCard({ b }: { b: BatchStatus }) {
  const done = b.status === 'completed' || b.status === 'completed_with_failures' || b.status === 'failed';
  const icon = b.status === 'failed' ? <XCircle size={15} className="text-rose-500" />
    : b.status === 'completed_with_failures' ? <AlertTriangle size={15} className="text-amber-500" />
    : done ? <CheckCircle2 size={15} className="text-emerald-500" />
    : <Loader2 size={15} className="text-accent animate-spin" />;
  const v = b.verification || {};
  const counts: [string, any][] = Object.entries(v).filter(([, val]) => typeof val === 'number' || typeof val === 'string');
  const failures: any[] = Array.isArray(v.failures) ? v.failures : [];

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-sm font-semibold text-navy-900">Batch {b.batchId.slice(0, 8)}</span>
        <span className="badge bg-slate-100 text-slate-600">{b.status.replace(/_/g, ' ')}</span>
        <span className="text-xs text-slate-400 ml-auto">{fmtDateTime(b.updatedAt)}</span>
      </div>
      <div className="text-xs text-slate-500 mb-2 flex flex-wrap gap-x-3">
        <span>expected: {b.expected.items} items</span>
        <span>{b.expected.files} files</span>
        <span>{fmtBytes(b.expected.bytes)}</span>
      </div>
      {/* phases */}
      <div className="space-y-1.5">
        {b.phases.map((p) => {
          const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : (p.state === 'done' ? 100 : 0);
          return (
            <div key={p.phase}>
              <div className="flex items-center justify-between text-xs mb-0.5">
                <span className="text-slate-600">{PHASE_LABEL[p.phase] || p.phase}</span>
                <span className="tabular-nums text-slate-400">{p.done}/{p.total} · {p.state}</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                <div className={`h-full ${p.state === 'done' ? 'bg-emerald-500' : p.state === 'error' ? 'bg-rose-500' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {/* verification counts */}
      {counts.length > 0 && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {counts.map(([k, val]) => (
            <div key={k} className="rounded bg-slate-50 px-2 py-1.5">
              <div className="text-sm font-semibold text-navy-900 tabular-nums">{String(val)}</div>
              <div className="text-[11px] text-slate-400">{k.replace(/_/g, ' ')}</div>
            </div>
          ))}
        </div>
      )}
      {failures.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-rose-600 mb-1">Failures ({failures.length})</div>
          <ul className="space-y-0.5 max-h-40 overflow-auto">
            {failures.map((f, i) => (
              <li key={i} className="text-xs text-slate-600">
                <span className="font-medium">{f.controlNumber || f.control_number || f.id || '—'}</span>
                {f.reason ? ` — ${f.reason}` : f.error ? ` — ${f.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConfirmModal({ title, body, confirmLabel, danger, busy, onCancel, onConfirm }: {
  title: string; body: string; confirmLabel: string; danger?: boolean; busy: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal-950/60 p-4" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md card p-6">
        <h3 className={`text-lg font-bold flex items-center gap-2 ${danger ? 'text-rose-700' : 'text-navy-900'}`}>
          {danger ? <AlertTriangle size={18} /> : <Archive size={18} />} {title}
        </h3>
        <p className="text-sm text-slate-600 mt-2">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="btn-ghost" disabled={busy}>Cancel</button>
          <button onClick={onConfirm} disabled={busy}
            className={danger ? 'btn-primary bg-rose-600 hover:bg-rose-700' : 'btn-primary'}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
