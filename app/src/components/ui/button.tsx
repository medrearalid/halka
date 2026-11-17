import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium tracking-tight whitespace-nowrap select-none transition-[background-color,color,border-color,opacity,transform] duration-150 ease-(--ease-out) outline-none active:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-busy:opacity-70 aria-busy:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-copper text-copper-ink hover:bg-copper-2",
        destructive: "bg-danger-soft text-danger hover:bg-danger hover:text-paper-0",
        outline: "border border-line-2 bg-transparent text-ink-1 hover:bg-paper-3",
        secondary: "bg-paper-3 text-ink-1 hover:bg-paper-4",
        ghost: "text-ink-2 hover:bg-paper-3 hover:text-ink-1",
        link: "text-copper underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-2.5",
        xs: "h-6 px-2 text-xs",
        sm: "h-6.5 px-2 text-xs",
        lg: "h-8 px-3",
        icon: "size-7",
        "icon-xs": "size-5 rounded-[5px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-6",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
