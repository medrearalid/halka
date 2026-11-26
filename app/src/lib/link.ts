import type { MemberView } from "@/ipc";

const tone = (ms: number | null) => (ms === null ? "bg-ink-3" : ms < 80 ? "bg-live" : ms < 180 ? "bg-warn" : "bg-danger");

/** A member's own ping (their link report), or our link to them from clients that don't report one. */
export function linkLabel(m: MemberView, meHidden: boolean): { text: string; tone: string; detail: string[] } | null {
  if (m.conn === "none") return { text: "bağlantı yok", tone: "bg-ink-3", detail: ["Şu an ulaşılamıyor"] };
  const toYou =
    m.conn === "self" ? null
    : `Sana: ${m.conn === "direct" ? "doğrudan" : "relay"}${m.rtt_ms !== null ? ` · ${m.rtt_ms} ms` : ""}` +
      (m.conn !== "relay" ? "" : m.link?.hidden_ip ? " (IP’sini gizliyor)" : meHidden ? " (IP’ni gizliyorsun)" : " (doğrudan bağlantı kurulamadı: NAT/güvenlik duvarı)");
  const l = m.link;
  if (!l) {
    if (m.conn === "self") return null;
    return { text: `${m.conn === "direct" ? "doğrudan" : "relay"}${m.rtt_ms !== null ? ` · ${m.rtt_ms} ms` : ""}`, tone: tone(m.rtt_ms), detail: [toYou!] };
  }
  if (l.direct + l.relay === 0) return null; // nobody to measure against yet
  const kind = l.hidden_ip ? "IP gizli" : l.relay === 0 ? "doğrudan" : l.direct === 0 ? "relay" : `${l.relay}/${l.direct + l.relay} relay`;
  const own = l.hidden_ip ? "Kendi pingi · tüm bağlantıları relay, IP gizli" : `Kendi pingi · ${l.direct} doğrudan, ${l.relay} relay`;
  return { text: `${l.ms !== null ? `${l.ms} ms · ` : ""}${kind}`, tone: tone(l.ms), detail: toYou ? [own, toYou] : [own] };
}
