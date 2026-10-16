export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}
export const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
export const inDays = (days: number | string) => new Date(Date.now() + Number(days) * 86_400_000).toISOString();
export const splitList = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
