import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Ban, CornerUpLeft, Hash, MessageSquare, Pencil, Send, Trash2, X } from "lucide-react";
import { call, type ChannelView, type Id, type MessageView, type SpaceView } from "@/ipc";
import { emptyMsgs, useApp } from "@/state/store";
import { has, memberOf, nameOf } from "@/lib/space";
import { dayLabel, full, hhmm } from "@/lib/time";
import { copy, fail } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, Empty, IconBtn } from "./common";

const MAX_LEN = 4000;
const GROUP_MS = 5 * 60_000;
const DOM_CAP = 300;

/** `dense`: the slim voice-room column (smaller avatars, tighter gutters). Text channels get a reading measure instead. */
export function ChatView({ space, channel, open = true, dense = false }: { space: SpaceView; channel: ChannelView; open?: boolean; dense?: boolean }) {
  const msgs = useApp((s) => s.msgs[channel.id] ?? emptyMsgs);
  const meId = useApp((s) => s.snap!.me.id);
  const voice = channel.kind === "voice";
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [editing, setEditing] = useState<Id | null>(null);

  useEffect(() => {
    if (open) void useApp.getState().loadMessages(space.id, channel.id);
  }, [open, space.id, channel.id]);

  const lastOwn = useMemo(() => {
    for (let i = msgs.items.length - 1; i >= 0; i--) {
      const m = msgs.items[i];
      if (m.author === meId && !m.deleted) return m.id;
    }
    return null;
  }, [msgs.items, meId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!open ? null : !msgs.loaded ? (
        <TimelineSkeleton />
      ) : msgs.error && msgs.items.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
          <Empty title="Mesajlar yüklenemedi" body={msgs.error}>
            <button className="mt-1 text-xs text-copper hover:underline" onClick={() => void useApp.getState().loadMessages(space.id, channel.id)}>
              Tekrar dene
            </button>
          </Empty>
        </div>
      ) : msgs.items.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto">
          <Empty
            icon={voice ? <MessageSquare className="size-5" /> : <Hash className="size-6" />}
            title={voice ? "Henüz mesaj yok" : `#${channel.name} kanalının başı`}
            body={voice ? undefined : "Henüz kimse yazmadı. İlk mesajı sen at."}
          />
        </div>
      ) : (
        <Timeline
          space={space}
          channel={channel}
          items={msgs.items}
          hasMore={msgs.hasMore}
          loading={msgs.loading}
          meId={meId}
          dense={dense}
          editing={editing}
          setEditing={setEditing}
          onReply={setReplyTo}
        />
      )}
      <Composer
        space={space}
        channel={channel}
        replyTo={replyTo}
        clearReply={() => setReplyTo(null)}
        onEditLast={() => lastOwn && setEditing(lastOwn)}
        dense={dense}
      />
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-4 overflow-hidden px-4 pb-4" aria-busy aria-label="Mesajlar yükleniyor">
      {[62, 40, 78, 30, 55, 46].map((w, i) => (
        <div key={i} className="flex gap-2.5">
          <div className="skeleton size-7 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
            <div className="skeleton h-3 w-24" />
            <div className="skeleton h-3" style={{ width: `${w}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

type Row = { kind: "day"; key: string; label: string } | { kind: "msg"; key: string; m: MessageView; head: boolean };

function Timeline(props: {
  space: SpaceView;
  channel: ChannelView;
  items: MessageView[];
  hasMore: boolean;
  loading: boolean;
  meId: Id;
  dense: boolean;
  editing: Id | null;
  setEditing: (id: Id | null) => void;
  onReply: (m: MessageView) => void;
}) {
  const { space, channel, items, hasMore, loading, meId } = props;
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef({ atBottom: true, height: 0, firstId: "" as Id, lastId: "" as Id });
  const [unseen, setUnseen] = useState(false);

  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    let prev: MessageView | null = null;
    for (const m of items) {
      const day = dayLabel(m.ts);
      if (!prev || dayLabel(prev.ts) !== day) out.push({ kind: "day", key: `d${m.ts}`, label: day });
      const head = !prev || prev.author !== m.author || m.ts - prev.ts > GROUP_MS || !!m.reply_to || out[out.length - 1].kind === "day";
      out.push({ kind: "msg", key: m.id, m, head });
      prev = m;
    }
    return out;
  }, [items]);

  // Scroll anchoring: keep the view still when older pages are prepended, stick to bottom otherwise.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = st.current;
    const first = items[0]?.id ?? "";
    const last = items[items.length - 1]?.id ?? "";
    if (!s.firstId) el.scrollTop = el.scrollHeight;
    else if (first !== s.firstId && last === s.lastId) el.scrollTop += el.scrollHeight - s.height;
    else if (s.atBottom) el.scrollTop = el.scrollHeight;
    else if (last !== s.lastId) setUnseen(true);
    s.firstId = first;
    s.lastId = last;
    s.height = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = ref.current!;
    const s = st.current;
    s.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    s.height = el.scrollHeight;
    if (s.atBottom) {
      setUnseen(false);
      if (items.length > DOM_CAP) useApp.getState().trimMessages(channel.id, DOM_CAP);
    }
    if (el.scrollTop < 400 && hasMore && !loading) void useApp.getState().loadMessages(space.id, channel.id, true);
  };

  const jumpTo = (id: Id) => {
    const node = ref.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.animate([{ backgroundColor: "var(--copper-soft)" }, { backgroundColor: "transparent" }], { duration: 1400, easing: "ease-out" });
  };

  const canModerate = has(space, "manage_messages");

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto [overflow-anchor:none]">
        <div className={cn("flex min-h-full flex-col justify-end pt-6 pb-3", props.dense ? "pt-3" : "mx-auto w-full max-w-[880px]")}>
          {!hasMore && channel.kind === "text" && (
            <div className="px-4 pb-4">
              <div className="text-[15px] font-semibold tracking-tight">#{channel.name}</div>
              <div className="text-xs text-ink-3">Kanalın başı. Bu mesajlar yalnızca halkadakilerin cihazlarında duruyor.</div>
            </div>
          )}
          {rows.map((r) =>
            r.kind === "day" ? (
              <div key={r.key} className="my-2 flex items-center gap-3 px-4" role="separator">
                <div className="h-px flex-1 bg-line" />
                <span className="text-2xs font-medium text-ink-3">{r.label}</span>
                <div className="h-px flex-1 bg-line" />
              </div>
            ) : (
              <MessageRow
                key={r.key}
                m={r.m}
                head={r.head}
                dense={props.dense}
                space={space}
                mine={r.m.author === meId}
                canDelete={r.m.author === meId || canModerate}
                reply={r.m.reply_to ? (byId.get(r.m.reply_to) ?? null) : null}
                editing={props.editing === r.m.id}
                setEditing={props.setEditing}
                onReply={props.onReply}
                onJump={jumpTo}
              />
            ),
          )}
        </div>
      </div>
      {loading && hasMore && (
        <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
          <span className="enter rounded-full border border-line-2 bg-paper-2 px-2.5 py-0.5 text-2xs text-ink-3 shadow-pop">Eski mesajlar yükleniyor…</span>
        </div>
      )}
      {unseen && (
        <button
          onClick={() => {
            const el = ref.current!;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          className="enter absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line-2 bg-paper-2 px-2.5 py-1 text-xs text-ink-1 shadow-pop hover:bg-paper-3"
        >
          <ArrowDown className="size-3" /> Yeni mesajlar
        </button>
      )}
    </div>
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

/** Plain text only. URLs become copy-on-click spans; nothing navigates. */
export function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index!;
    if (i > last) parts.push(text.slice(last, i));
    const url = m[0];
    parts.push(
      <Tooltip key={i}>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            onClick={() => void copy(url, "Bağlantı kopyalandı")}
            onKeyDown={(e) => e.key === "Enter" && void copy(url, "Bağlantı kopyalandı")}
            className="cursor-pointer text-copper underline decoration-copper/35 underline-offset-2 hover:decoration-copper"
          >
            {url}
          </span>
        </TooltipTrigger>
        <TooltipContent>Kopyalamak için tıkla</TooltipContent>
      </Tooltip>,
    );
    last = i + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const MessageRow = memo(function MessageRow({
  m,
  head,
  dense,
  space,
  mine,
  canDelete,
  reply,
  editing,
  setEditing,
  onReply,
  onJump,
}: {
  m: MessageView;
  head: boolean;
  dense: boolean;
  space: SpaceView;
  mine: boolean;
  canDelete: boolean;
  reply: MessageView | null;
  editing: boolean;
  setEditing: (id: Id | null) => void;
  onReply: (m: MessageView) => void;
  onJump: (id: Id) => void;
}) {
  const author = memberOf(space, m.author);
  const name = author?.name ?? nameOf(space, m.author);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  return (
    <div data-mid={m.id} className={cn("group relative flex hover:bg-paper-2/60", dense ? "gap-2 px-3" : "gap-2.5 px-4", head ? (dense ? "mt-2 pt-0.5" : "mt-2.5 pt-0.5") : "")}>
      <div className={cn("shrink-0", dense ? "w-[22px]" : "w-7")}>
        {head ? (
          <Avatar id={m.author} name={name} size={dense ? 22 : 28} className={m.reply_to ? "mt-[20px]" : "mt-0.5"} />
        ) : (
          !dense && <span className="num block pt-[3px] text-right text-[10px] leading-4 text-ink-3 opacity-0 group-hover:opacity-100">{hhmm(m.ts)}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 pb-px">
        {reply !== null || m.reply_to ? (
          <button
            onClick={() => m.reply_to && onJump(m.reply_to)}
            className="mb-0.5 flex max-w-full items-center gap-1.5 text-left text-xs text-ink-3 hover:text-ink-2"
          >
            <CornerUpLeft className="size-3 shrink-0" />
            {reply ? (
              <>
                <span className="shrink-0 font-medium text-ink-2">{nameOf(space, reply.author)}</span>
                <span className="truncate">{reply.deleted ? "silinmiş mesaj" : reply.text}</span>
              </>
            ) : (
              <span>daha eski bir mesaja yanıt</span>
            )}
          </button>
        ) : null}
        {head && (
          <div className="flex items-baseline gap-2">
            {author ? (
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={(e) => useApp.getState().openProfile(m.author, space.id, e.currentTarget)}
                className="rounded-sm text-left text-[13px] font-medium tracking-tight text-ink-1 hover:underline"
              >{name}</button>
            ) : <span className="text-[13px] font-medium tracking-tight text-ink-1">{name}</span>}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="num text-2xs text-ink-3">{hhmm(m.ts)}</span>
              </TooltipTrigger>
              <TooltipContent>{full(m.ts)}</TooltipContent>
            </Tooltip>
          </div>
        )}
        {m.deleted ? (
          <div className="flex items-center gap-1.5 text-[13px] text-ink-3">
            <Ban className="size-3" /> Bu mesaj silindi
          </div>
        ) : editing ? (
          <EditBox m={m} onDone={() => setEditing(null)} />
        ) : (
          <div className="text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-ink-1" data-selectable>
            <RichText text={m.text} />
            {m.edited && <span className="ml-1 text-2xs text-ink-3">(düzenlendi)</span>}
          </div>
        )}
      </div>
      {!m.deleted && !editing && (
        <div className="absolute -top-3 right-3 z-10 hidden items-center rounded-md border border-line-2 bg-paper-2 p-0.5 shadow-pop group-hover:flex group-focus-within:flex">
          <ToolBtn label="Yanıtla" onClick={() => onReply(m)}>
            <CornerUpLeft />
          </ToolBtn>
          {mine && (
            <ToolBtn label="Düzenle" onClick={() => setEditing(m.id)}>
              <Pencil />
            </ToolBtn>
          )}
          {canDelete &&
            (confirmDel ? (
              <button
                onClick={() => void call("delete_message", { space: space.id, message: m.id }).catch(fail)}
                className="h-6 rounded-[4px] bg-danger-soft px-2 text-2xs font-medium text-danger"
              >
                Silinsin mi?
              </button>
            ) : (
              <ToolBtn label="Sil" onClick={() => setConfirmDel(true)} danger>
                <Trash2 />
              </ToolBtn>
            ))}
        </div>
      )}
    </div>
  );
});

function ToolBtn({ label, onClick, children, danger }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          onClick={onClick}
          className={cn(
            "grid size-6 place-items-center rounded-[4px] text-ink-2 hover:bg-paper-3 hover:text-ink-1 [&_svg]:size-3.5",
            danger && "hover:text-danger",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function EditBox({ m, onDone }: { m: MessageView; onDone: () => void }) {
  const [text, setText] = useState(m.text);
  const save = () => {
    const t = text.trim();
    if (!t || t === m.text) return onDone();
    if (t.length > MAX_LEN) return;
    onDone();
    void call("edit_message", { space: m.space, message: m.id, text: t }).catch(fail);
  };
  return (
    <div className="my-0.5">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
        className="block max-h-60 min-h-8 w-full resize-none rounded-md border border-copper/60 bg-paper-0 px-2 py-1.5 text-[13px] leading-[1.5] outline-none [field-sizing:content]"
      />
      <div className="mt-1 text-2xs text-ink-3">
        <kbd className="kbd">Esc</kbd> iptal · <kbd className="kbd">Enter</kbd> kaydet
      </div>
    </div>
  );
}

function Composer({
  space,
  channel,
  replyTo,
  clearReply,
  onEditLast,
  dense,
}: {
  space: SpaceView;
  channel: ChannelView;
  replyTo: MessageView | null;
  clearReply: () => void;
  onEditLast: () => void;
  dense: boolean;
}) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const canSend = has(space, "send");
  const over = text.length > MAX_LEN;

  useEffect(() => {
    if (replyTo) ta.current?.focus();
  }, [replyTo]);

  const send = () => {
    const t = text.trim();
    if (!t || over || !canSend) return;
    const reply = replyTo?.id ?? null;
    setText("");
    clearReply();
    call("send_message", { space: space.id, channel: channel.id, text: t, replyTo: reply }).catch((e) => {
      setText(t);
      fail(e);
    });
  };

  return (
    <div className={cn("shrink-0", dense ? "px-2.5 pb-2.5" : "mx-auto w-full max-w-[880px] px-4 pb-4")}>
      <div className="rounded-lg border border-line-2 bg-paper-2 transition-[border-color,box-shadow] duration-150 focus-within:border-copper/55 focus-within:shadow-[0_0_0_3px_var(--copper-soft)]">
        {replyTo && (
          <div className="enter flex items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-xs text-ink-3">
            <CornerUpLeft className="size-3" />
            <span>
              <span className="font-medium text-ink-2">{nameOf(space, replyTo.author)}</span> kişisine yanıt
            </span>
            <span className="min-w-0 flex-1 truncate">— {replyTo.text}</span>
            <button aria-label="Yanıtı iptal et" onClick={clearReply} className="grid size-4 place-items-center rounded hover:text-ink-1">
              <X className="size-3" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2 px-2.5 py-2">
          <textarea
            ref={ta}
            value={text}
            rows={1}
            disabled={!canSend}
            placeholder={!canSend ? "Bu kanalda yazma iznin yok" : channel.kind === "voice" ? "Odaya mesaj yaz" : `#${channel.name} kanalına yaz`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === "ArrowUp" && !text) {
                e.preventDefault();
                onEditLast();
              } else if (e.key === "Escape" && replyTo) {
                e.stopPropagation();
                clearReply();
              }
            }}
            className={cn(
              "block min-h-5 min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-5 text-ink-1 outline-none [field-sizing:content] placeholder:text-ink-3 disabled:cursor-not-allowed",
              channel.kind === "voice" ? "max-h-20" : "max-h-48",
            )}
            aria-label="Mesaj"
          />
          {text.length > MAX_LEN - 500 && (
            <span className={cn("num shrink-0 pb-px text-2xs", over ? "font-medium text-danger" : "text-ink-3")}>
              {text.length}/{MAX_LEN}
            </span>
          )}
          {channel.kind === "voice" && (
            <IconBtn label="Mesaj gönder" className="-my-1 -mr-1 shrink-0 text-copper" onClick={send} disabled={!canSend || !text.trim() || over}>
              <Send />
            </IconBtn>
          )}
        </div>
      </div>
      <div className={cn("mt-1 flex h-4 items-center gap-3 px-1 text-[10.5px] text-ink-3", channel.kind === "voice" && "hidden")}>
        <span>
          <kbd className="kbd">Enter</kbd> gönder
        </span>
        <span>
          <kbd className="kbd">⇧ Enter</kbd> yeni satır
        </span>
        <span>
          <kbd className="kbd">↑</kbd> son mesajını düzenle
        </span>
      </div>
    </div>
  );
}
