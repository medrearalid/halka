import { CircleAlert, Info, X } from "lucide-react";
import { useApp } from "@/state/store";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-[100] flex w-[320px] flex-col items-end gap-1.5" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className="toast pointer-events-auto flex w-full items-start gap-2 rounded-lg border border-line-2 bg-paper-2 py-2 pr-1.5 pl-2.5 text-xs shadow-pop"
        >
          {t.kind === "error" ? (
            <CircleAlert className="mt-px size-3.5 shrink-0 text-danger" />
          ) : (
            <Info className="mt-px size-3.5 shrink-0 text-ink-3" />
          )}
          <span className="min-w-0 flex-1 text-ink-1" data-selectable>
            {t.text}
          </span>
          <button aria-label="Kapat" onClick={() => dismiss(t.id)} className="grid size-4 place-items-center rounded text-ink-3 hover:text-ink-1">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
