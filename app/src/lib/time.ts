const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", weekday: "long" });
const fullFmt = new Intl.DateTimeFormat("tr-TR", { dateStyle: "long", timeStyle: "short" });

export const hhmm = (ts: number) => timeFmt.format(ts);
export const full = (ts: number) => fullFmt.format(ts);

export function dayLabel(ts: number): string {
  const d = new Date(ts).toDateString();
  const now = new Date();
  if (d === now.toDateString()) return "Bugün";
  now.setDate(now.getDate() - 1);
  if (d === now.toDateString()) return "Dün";
  return dayFmt.format(ts);
}

export function relFuture(ts: number | null): string {
  if (ts === null) return "süresiz";
  const ms = ts - Date.now();
  if (ms <= 0) return "süresi doldu";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} dk kaldı`;
  if (h < 48) return `${Math.round(h)} sa kaldı`;
  return `${Math.round(h / 24)} gün kaldı`;
}
