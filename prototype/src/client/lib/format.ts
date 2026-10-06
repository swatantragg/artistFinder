// Display helpers: dates, counts and short labels.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayLocal(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayDiff(a: string, b: string) { return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 864e5); }

/** "3 Oct 2026" */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
/** "3 Oct" (current year) */
export function fmtShort(v: string | null | undefined): string {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return y === new Date().getFullYear() ? `${d} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} ${y}`;
}
export function fmtTime(v: string | null | undefined): string {
  if (!v || v.length < 16) return '';
  const d = new Date(v);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function fmtDateTime(v: string | null | undefined): string { return v ? `${fmtShort(v)}${fmtTime(v) ? `, ${fmtTime(v)}` : ''}` : '—'; }

/** "Today", "Tomorrow", "In 3 days", "2 days overdue" (due dates) */
export function fmtDue(v: string | null | undefined, today = todayLocal()): { text: string; overdue: boolean; today: boolean } {
  if (!v) return { text: '—', overdue: false, today: false };
  const d = dayDiff(today, v);
  if (d === 0) return { text: 'Today', overdue: false, today: true };
  if (d === 1) return { text: 'Tomorrow', overdue: false, today: false };
  if (d === -1) return { text: '1 day overdue', overdue: true, today: false };
  if (d < 0) return { text: `${-d} days overdue`, overdue: true, today: false };
  if (d < 7) return { text: `In ${d} days`, overdue: false, today: false };
  return { text: fmtShort(v), overdue: false, today: false };
}
/** "just now", "3 h ago", "yesterday", "5 days ago" */
export function fmtAgo(v: string | null | undefined): string {
  if (!v) return '—';
  const ms = Date.now() - Date.parse(v.length <= 10 ? `${v}T12:00:00Z` : v);
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return fmtDate(v);
}
export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-IN');
export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export function initials(name: string): string {
  const p = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(Boolean);
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
export function download(filename: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
