import * as React from "react";
import { hueOf, initials } from "@/lib/avatar";
import { useProfilePhoto } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

export function Avatar({
  id,
  name,
  size = 28,
  online,
  className,
  style,
  photoSrc,
}: {
  id: string;
  name: string;
  size?: number;
  online?: boolean;
  className?: string;
  style?: React.CSSProperties;
  photoSrc?: string | null;
}) {
  const storedPhoto = useProfilePhoto(id, photoSrc === undefined);
  const photo = photoSrc === undefined ? storedPhoto : photoSrc;
  return (
    <span
      className={cn("avatar relative inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-tight", className)}
      style={{ "--h": hueOf(id), width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.38)), ...style } as React.CSSProperties}
      aria-hidden
    >
      {photo ? <img src={photo} alt="" draggable={false} className="absolute inset-0 size-full rounded-full object-cover" /> : initials(name)}
      {online !== undefined && (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-[9px] rounded-full ring-2 ring-(--dot-ring,var(--paper-0))",
            online ? "bg-live" : "bg-ink-3",
          )}
        />
      )}
    </span>
  );
}

/** The Halka mark: a ring with a small gap — the seat you take. */
export function RingMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeDasharray="46 7.4" strokeDashoffset="-3.7" strokeLinecap="round" transform="rotate(90 12 12)" />
      <circle cx="12" cy="20.5" r="2.1" fill="currentColor" />
    </svg>
  );
}

export function IconBtn({
  label,
  shortcut,
  children,
  className,
  side = "top",
  ...props
}: React.ComponentProps<typeof Button> & { label: string; shortcut?: string; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className={className} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {shortcut && <span className="ml-1.5 font-mono text-ink-3">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="group/sec flex h-7 items-center justify-between pr-1 pl-2 text-2xs font-medium tracking-wide text-ink-3 uppercase">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Empty({ icon, title, body, children }: { icon?: React.ReactNode; title: string; body?: string; children?: React.ReactNode }) {
  return (
    <div className="enter flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-ink-3">{icon}</div>}
      <div className="text-[13px] font-medium tracking-tight text-ink-1">{title}</div>
      {body && <p className="max-w-[34ch] text-xs text-ink-3">{body}</p>}
      {children}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-2xs text-ink-3">{hint}</span>}
    </label>
  );
}

/** Compact segmented control. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex h-7 rounded-md border border-line-2 bg-paper-0 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className="num flex-1 rounded-[4px] px-2 text-xs whitespace-nowrap text-ink-2 transition-colors duration-150 hover:text-ink-1 aria-checked:bg-paper-3 aria-checked:text-ink-1"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
