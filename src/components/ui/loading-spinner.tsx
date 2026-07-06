import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/utils/tailwind";

const loadingSpinnerVariants = cva(
  "animate-spin rounded-full border-2",
  {
    variants: {
      variant: {
        default: "border-primary border-t-transparent",
        secondary: "border-muted-foreground border-t-transparent",
        overlay: "border-white/20 border-t-white",
        soft: "border-primary/30 border-t-primary",
        inherit: "border-current border-t-transparent",
      },
      size: {
        xs: "h-3 w-3",
        sm: "h-4 w-4",
        md: "h-5 w-5",
        lg: "h-6 w-6",
        xl: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

interface LoadingSpinnerProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof loadingSpinnerVariants> {
  /** 屏幕阅读器标签，默认 "Loading" */
  label?: string;
}

function LoadingSpinner({
  variant,
  size,
  className,
  label = "Loading",
  ...props
}: LoadingSpinnerProps) {
  return (
    <div
      aria-label={label}
      data-slot="loading-spinner"
      role="status"
      className={cn(loadingSpinnerVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { LoadingSpinner, loadingSpinnerVariants };
