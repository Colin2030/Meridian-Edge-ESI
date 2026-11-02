export function fmtDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const REVIEW_STATES: { value: string; label: string; cls: string }[] = [
  { value: 'unreviewed', label: 'Unreviewed', cls: 'bg-slate-100 text-slate-600' },
  { value: 'in_review', label: 'In review', cls: 'bg-sky-100 text-sky-700' },
  { value: 'responsive', label: 'Responsive', cls: 'bg-emerald-100 text-emerald-700' },
  { value: 'non_responsive', label: 'Non-responsive', cls: 'bg-slate-200 text-slate-700' },
  { value: 'privileged', label: 'Privileged', cls: 'bg-rose-100 text-rose-700' },
  { value: 'further_review', label: 'Further review', cls: 'bg-amber-100 text-amber-700' },
];
export const reviewMeta = (v?: string) => REVIEW_STATES.find((r) => r.value === v) || REVIEW_STATES[0];
