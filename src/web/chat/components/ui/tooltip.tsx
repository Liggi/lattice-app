import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { Info } from "lucide-react"

import { cn } from "@/web/chat/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

type LatticeTooltipContentProps =
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    /** Optional header label. Without it the tooltip is a single line. */
    label?: string;
    /** Header icon, shown only with a label. Default: Info */
    icon?: React.ReactNode;
  }

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  LatticeTooltipContentProps
>(({ className, sideOffset = 8, label, icon, children, ...props }, ref) => {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-[360px] overflow-hidden rounded-md border border-line bg-surface",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      >
        {label && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <span className="text-fg-3 shrink-0">
              {icon ?? <Info size={14} />}
            </span>
            <span className="text-xs font-medium text-fg-2">
              {label}
            </span>
          </div>
        )}

        <div className="px-3 py-2 text-xs text-fg leading-relaxed whitespace-pre-wrap">
          {children}
        </div>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
})
TooltipContent.displayName = TooltipPrimitive.Content.displayName

/**
 * Minimal tooltip: one dark pill, no header chrome. For dense icon surfaces
 * (session-card chips, filter toggles) where the labeled variant is too loud.
 */
const TooltipContentPlain = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg",
        "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className
      )}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
))
TooltipContentPlain.displayName = 'TooltipContentPlain'

export { Tooltip, TooltipTrigger, TooltipContent, TooltipContentPlain, TooltipProvider }
