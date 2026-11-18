// "Neler değişti": CHANGELOG.md is bundled at build time (the CSP keeps the webview off the network).

export interface Release {
  version: string;
  items: string[];
}

export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)\s*$/.exec(line);
    if (h) out.push({ version: h[1], items: [] });
    else if (out.length && /^[-*]\s+/.test(line)) out[out.length - 1].items.push(line.replace(/^[-*]\s+/, "").trim());
  }
  return out;
}

/** Numeric x.y.z compare; anything after the core (e.g. -test) is ignored. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Releases newer than `seen` up to and including `current`, newest first. No `seen`: just `current`. */
export function unseenReleases(md: string, seen: string | null, current: string): Release[] {
  return parseChangelog(md)
    .filter((r) => cmpVersion(r.version, current) <= 0 && (seen ? cmpVersion(r.version, seen) > 0 : cmpVersion(r.version, current) === 0))
    .filter((r) => r.items.length > 0)
    .sort((a, b) => cmpVersion(b.version, a.version));
}
