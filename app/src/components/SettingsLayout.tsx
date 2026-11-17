import type { ReactNode } from "react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface Tab<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
}

export function SettingsLayout<T extends string>({
  title,
  subtitle,
  tabs,
  tab,
  setTab,
  children,
}: {
  title: string;
  subtitle?: string;
  tabs: Tab<T>[];
  tab: T;
  setTab: (t: T) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[188px] shrink-0 flex-col gap-px border-r border-line bg-paper-0 p-2 max-[700px]:w-[56px]" aria-label={title}>
        <div className="px-2 pt-1 pb-3 max-[700px]:hidden">
          <DialogTitle className="truncate text-[13px] font-semibold tracking-tight">{title}</DialogTitle>
          {subtitle && <DialogDescription className="truncate text-2xs text-ink-3">{subtitle}</DialogDescription>}
        </div>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={t.id === tab ? "page" : undefined}
            className={cn(
              "flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 hover:bg-paper-2 [&_svg]:size-3.5 [&_svg]:shrink-0",
              t.id === tab ? "bg-paper-3 text-ink-1 hover:bg-paper-3" : "text-ink-2",
            )}
            title={t.label}
          >
            {t.icon}
            <span className="truncate max-[700px]:hidden">{t.label}</span>
          </button>
        ))}
      </nav>
      <div key={tab} className="enter min-w-0 flex-1 overflow-y-auto px-6 pt-5 pb-8">
        {children}
      </div>
    </div>
  );
}

export function PaneTitle({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4 pr-6">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {desc && <p className="mt-0.5 text-xs text-ink-3">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

export function Row({ label, desc, children }: { label: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] text-ink-1">{label}</div>
        {desc && <div className="text-xs text-ink-3">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-1 text-2xs font-medium tracking-wide text-ink-3 uppercase">{title}</h3>}
      <div className="rounded-lg border border-line bg-paper-2/40 px-3">{children}</div>
    </section>
  );
}
