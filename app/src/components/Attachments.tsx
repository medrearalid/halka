import { useEffect, useState } from "react";
import { Check, Download, FileText, FolderOpen, ImageOff, Loader2, Timer, X } from "lucide-react";
import { call, errText, type FileRef, type MessageView, type SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { fail } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export const MAX_ATTACHMENTS = 10;
const CHUNK = 4 * 1024 * 1024;
const MAX_SIDE = 4096;
/** Re-encoded to WebP (strips EXIF/location, and only WebP is ever shown inline). */
const TRANSCODE = /^image\/(png|jpeg|webp|bmp|avif)$/;
const EXEC = /\.(exe|msi|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|lnk|scr|com|pif|reg|hta|jar|cpl|msc|dll)$/i;

export const TTL_OPTIONS: { ms: number; label: string; short: string }[] = [
  { ms: 5 * 60_000, label: "5 dakika", short: "5 dk" },
  { ms: 3600_000, label: "1 saat", short: "1 sa" },
  { ms: 86_400_000, label: "1 gün", short: "1 g" },
  { ms: 7 * 86_400_000, label: "7 gün", short: "7 g" },
];

export function ttlLabel(ms: number) {
  return TTL_OPTIONS.find((o) => o.ms === ms)?.short ?? left(ms);
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Remaining time, compact: 42 sn · 12 dk · 3 sa · 2 g */
function left(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} sn`;
  if (s < 3600) return `${Math.ceil(s / 60)} dk`;
  if (s < 86_400) return `${Math.ceil(s / 3600)} sa`;
  return `${Math.ceil(s / 86_400)} g`;
}

// ---------------------------------------------------------------- upload

export type Att = {
  key: string;
  name: string;
  size: number;
  preview: string | null;
  sent: number;
  ref: FileRef | null;
  error: string | null;
  cancel: () => void;
};

async function toWebp(file: File): Promise<File> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await c.convertToBlob({ type: "image/webp", quality: 0.9 });
  const stem = file.name.replace(/\.[^.]+$/, "") || "görsel";
  return new File([blob], `${stem}.webp`, { type: "image/webp" });
}

/** Streams a file into the core in 4 MB pieces; `onChange` reports progress and the result. */
export function upload(space: SpaceView, raw: File, onChange: (a: Att) => void): Att {
  let dead = false;
  let handle: number | null = null;
  const a: Att = {
    key: `${Date.now()}-${Math.random()}`,
    name: raw.name || "pano",
    size: raw.size,
    preview: null,
    sent: 0,
    ref: null,
    error: null,
    cancel: () => {
      dead = true;
      if (a.preview) URL.revokeObjectURL(a.preview);
      if (a.ref) void call("attach_discard", { hash: a.ref.hash });
      else if (handle !== null) void call("attach_cancel", { handle });
    },
  };
  const push = (p: Partial<Att>) => {
    Object.assign(a, p);
    if (!dead) onChange({ ...a });
  };
  void (async () => {
    try {
      let file = raw;
      if (TRANSCODE.test(raw.type) && raw.size <= 64 * 1024 * 1024) {
        file = await toWebp(raw).catch(() => raw);
        push({ name: file.name, size: file.size, preview: file.type === "image/webp" ? URL.createObjectURL(file) : null });
      }
      if (file.size === 0) throw "Boş dosya gönderilemez";
      if (file.size > space.max_file) throw `Bu halkada dosyalar en fazla ${fmtSize(space.max_file)} olabilir`;
      handle = await call("attach_begin", { space: space.id, name: file.name, size: file.size });
      for (let at = 0; at < file.size; at += CHUNK) {
        if (dead) return;
        const piece = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
        const body = new Uint8Array(4 + piece.length);
        new DataView(body.buffer).setUint32(0, handle, true);
        body.set(piece, 4);
        await call("attach_chunk", body.buffer);
        push({ sent: Math.min(file.size, at + CHUNK) });
      }
      if (dead) return;
      push({ ref: await call("attach_end", { handle }) });
    } catch (e) {
      if (handle !== null) void call("attach_cancel", { handle });
      push({ error: errText(e) });
    }
  })();
  return a;
}

export function AttachmentChips({ atts, onRemove }: { atts: Att[]; onRemove: (key: string) => void }) {
  if (atts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-line px-2.5 py-2">
      {atts.map((a) => (
        <div
          key={a.key}
          className={cn(
            "group/att relative flex h-12 max-w-56 items-center gap-2 overflow-hidden rounded-md border bg-paper-1 pr-7",
            a.error ? "border-danger/50" : "border-line-2",
            a.preview ? "pl-0" : "pl-2",
          )}
        >
          {a.preview ? (
            <img src={a.preview} alt="" className="h-full w-12 shrink-0 object-cover" />
          ) : (
            <FileText className="size-4 shrink-0 text-ink-3" />
          )}
          <div className="min-w-0">
            <div className="truncate text-xs text-ink-1">{a.name}</div>
            <div className={cn("num truncate text-2xs", a.error ? "text-danger" : "text-ink-3")}>
              {a.error ?? (a.ref ? fmtSize(a.size) : `${Math.floor((a.sent / Math.max(1, a.size)) * 100)}%`)}
            </div>
          </div>
          {!a.ref && !a.error && (
            <div className="absolute inset-x-0 bottom-0 h-px bg-copper transition-transform duration-150 ease-out origin-left" style={{ transform: `scaleX(${a.sent / Math.max(1, a.size)})` }} />
          )}
          <button
            aria-label={`${a.name} ekini kaldır`}
            onClick={() => onRemove(a.key)}
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-[4px] text-ink-3 hover:bg-paper-3 hover:text-ink-1 focus-visible:outline-2 focus-visible:outline-copper"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- timer

/** `cap`: the channel's timer, which the sender can shorten but never lift. */
export function TimerMenu({ value, cap, onChange, disabled }: { value: number | null; cap: number | null; onChange: (ms: number | null) => void; disabled?: boolean }) {
  const opts = TTL_OPTIONS.filter((o) => cap === null || o.ms < cap);
  const active = value ?? cap;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={disabled}
            aria-label="Süreli mesaj"
            className={cn(
              "-my-1 flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-ink-3 hover:bg-paper-3 hover:text-ink-1 focus-visible:outline-2 focus-visible:outline-copper disabled:opacity-40 [&_svg]:size-4",
              active !== null && "text-copper hover:text-copper",
            )}
          >
            <Timer />
            {active !== null && <span className="num text-2xs font-medium">{ttlLabel(active)}</span>}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Süreli mesaj</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-2xs font-normal text-ink-3">Süresi dolunca her cihazdan geri dönüşsüz silinir</DropdownMenuLabel>
        {cap === null ? (
          <DropdownMenuItem onSelect={() => onChange(null)}>
            <span className="flex-1">Kapalı</span>
            {active === null && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onChange(null)}>
            <span className="flex-1">Kanal süresi · {ttlLabel(cap)}</span>
            {value === null && <Check className="size-3.5" />}
          </DropdownMenuItem>
        )}
        {opts.map((o) => (
          <DropdownMenuItem key={o.ms} onSelect={() => onChange(o.ms)}>
            <span className="flex-1">{o.label}</span>
            {value === o.ms && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Live countdown; ticks every second only in the last two minutes. */
export function ExpiryChip({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now);
  const rest = at - now;
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), rest < 120_000 ? 1000 : 30_000);
    return () => clearTimeout(t);
  }, [now, rest]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="num inline-flex items-center gap-0.5 text-2xs text-copper">
          <Timer className="size-3" />
          {left(rest)}
        </span>
      </TooltipTrigger>
      <TooltipContent>Süresi dolunca her cihazdan silinir</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------- received files

export function MessageFiles({ m, space, dense }: { m: MessageView; space: SpaceView; dense: boolean }) {
  if (m.files.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col items-start gap-1.5">
      {m.files.map((f) =>
        f.image ? <InlineImage key={f.hash} f={f} m={m} space={space} dense={dense} /> : <FileCard key={f.hash} f={f} m={m} />,
      )}
    </div>
  );
}

function useFile(f: FileRef, m: MessageView) {
  const prog = useApp((s) => s.fileProgress[f.hash]);
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void call("file_ready", { hash: f.hash }).then((r) => live && setReady(r)).catch(() => live && setReady(false));
    return () => {
      live = false;
    };
  }, [f.hash]);
  const isReady = ready === true || (prog !== undefined && prog.size > 0 && prog.have === prog.size);
  const failed = prog !== undefined && prog.size === 0;
  const [busy, setBusy] = useState(false);
  const fetch = () => {
    setBusy(true);
    useApp.setState((s) => ({ fileProgress: { ...s.fileProgress, [f.hash]: { have: 0, size: f.size } } }));
    void call("fetch_file", { space: m.space, msg: m.id, hash: f.hash })
      .catch((e) => {
        useApp.setState((s) => ({ fileProgress: { ...s.fileProgress, [f.hash]: { have: 0, size: 0 } } }));
        fail(e);
      })
      .finally(() => setBusy(false));
  };
  const downloading = !isReady && !failed && prog !== undefined && prog.size > 0;
  return { known: ready !== null, isReady, failed, downloading, have: prog?.have ?? 0, fetch, busy };
}

function InlineImage({ f, m, space, dense }: { f: FileRef; m: MessageView; space: SpaceView; dense: boolean }) {
  const file = useFile(f, m);
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const auto = f.size <= space.auto_image;
  const [w, h] = f.image!;

  useEffect(() => {
    if (file.known && !file.isReady && !file.downloading && !file.failed && auto) file.fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.known]);

  useEffect(() => {
    if (!file.isReady) return;
    let live = true;
    let made: string | null = null;
    void call("file_bytes", { space: m.space, msg: m.id, hash: f.hash })
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([b], { type: "image/webp" }));
        setUrl(made);
      })
      .catch(() => live && setBroken(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file.isReady, f.hash, m.id, m.space]);

  // reserve the final box from the signed dimensions: no layout shift when the bytes land
  const maxW = dense ? 240 : 400;
  const scale = Math.min(1, maxW / w, 320 / h);
  return (
    <div
      className="relative overflow-hidden rounded-md border border-line bg-paper-2"
      style={{ width: Math.max(48, Math.round(w * scale)), aspectRatio: `${w} / ${h}`, maxWidth: "100%" }}
    >
      {url ? (
        <>
          <button onClick={() => setOpen(true)} aria-label={`${f.name} büyüt`} className="block size-full cursor-zoom-in">
            <img src={url} alt={f.name} draggable={false} className="block size-full object-cover" />
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              aria-describedby={undefined}
              className="w-auto max-w-[92vw] gap-0 border-0 bg-transparent p-0 shadow-none sm:max-w-[92vw]"
            >
              <DialogTitle className="sr-only">{f.name}</DialogTitle>
              <img
                src={url}
                alt={f.name}
                draggable={false}
                onClick={() => setOpen(false)}
                className="block max-h-[88vh] max-w-[92vw] cursor-zoom-out rounded-md object-contain"
                style={{ aspectRatio: `${w} / ${h}` }}
              />
            </DialogContent>
          </Dialog>
        </>
      ) : broken || file.failed ? (
        <div className="absolute inset-0 grid place-items-center text-ink-3">
          <button onClick={() => (setBroken(false), file.fetch())} className="flex flex-col items-center gap-1 text-2xs hover:text-ink-1">
            <ImageOff className="size-4" /> Görsel yüklenemedi · tekrar dene
          </button>
        </div>
      ) : file.downloading || file.isReady || (auto && file.known) ? (
        <div className="skeleton absolute inset-0" aria-label="Görsel yükleniyor" />
      ) : file.known ? (
        <button onClick={file.fetch} className="absolute inset-0 grid place-items-center text-xs text-ink-2 hover:text-ink-1">
          <span className="flex items-center gap-1.5 rounded-full border border-line-2 bg-paper-1 px-2.5 py-1">
            <Download className="size-3.5" /> Görseli yükle · <span className="num">{fmtSize(f.size)}</span>
          </span>
        </button>
      ) : null}
      {file.downloading && (
        <div className="absolute inset-x-0 bottom-0 h-px origin-left bg-copper" style={{ transform: `scaleX(${file.have / f.size})` }} />
      )}
    </div>
  );
}

function FileCard({ f, m }: { f: FileRef; m: MessageView }) {
  const file = useFile(f, m);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const exec = EXEC.test(f.name);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);

  const save = () => {
    if (exec && !confirm) return setConfirm(true);
    setConfirm(false);
    void call("save_file", { space: m.space, msg: m.id, hash: f.hash }).then(setSaved).catch(fail);
  };

  return (
    <div className="relative flex h-12 w-full max-w-80 items-center gap-2.5 overflow-hidden rounded-md border border-line bg-paper-2 pr-1.5 pl-2.5">
      <FileText className={cn("size-4 shrink-0", exec ? "text-warn" : "text-ink-3")} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-ink-1" title={f.name}>{f.name}</div>
        <div className="num truncate text-2xs text-ink-3">
          {file.downloading ? `${fmtSize(file.have)} / ${fmtSize(f.size)}` : fmtSize(f.size)}
          {exec && " · çalıştırılabilir"}
        </div>
      </div>
      {saved ? (
        <button onClick={() => void call("reveal_file", { path: saved }).catch(fail)} className="flex h-7 items-center gap-1 rounded-[5px] px-2 text-2xs text-ink-2 hover:bg-paper-3 hover:text-ink-1">
          <FolderOpen className="size-3.5" /> Göster
        </button>
      ) : file.isReady ? (
        <button
          onClick={save}
          className={cn(
            "h-7 rounded-[5px] px-2 text-2xs font-medium",
            confirm ? "bg-warn/15 text-warn" : "text-copper hover:bg-paper-3",
          )}
        >
          {confirm ? "Bu bir program. Yine de kaydet?" : "Kaydet"}
        </button>
      ) : (
        <button
          onClick={file.fetch}
          disabled={file.downloading || file.busy || !file.known}
          aria-label="İndir"
          className="grid size-7 place-items-center rounded-[5px] text-ink-2 hover:bg-paper-3 hover:text-ink-1 disabled:opacity-40"
        >
          {file.downloading || file.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        </button>
      )}
      {file.downloading && (
        <div className="absolute inset-x-0 bottom-0 h-px origin-left bg-copper" style={{ transform: `scaleX(${file.have / f.size})` }} />
      )}
    </div>
  );
}

