// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Truncated paths expose their complete value in a keyboard-focusable tooltip.
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
export function LibraryPathText({ path }: { path: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block min-w-0 truncate text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
        >
          {path}
        </span>
      </TooltipTrigger>
      <TooltipContent className="z-[70] max-w-[min(32rem,90dvw)] break-all">
        {path}
      </TooltipContent>
    </Tooltip>
  );
}
