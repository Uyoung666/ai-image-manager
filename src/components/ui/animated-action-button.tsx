import * as React from "react";
import { cn } from "@/utils/tailwind";
import { Button } from "@/components/ui/button";
import "./animated-action-button.css";

export interface AnimatedActionButtonProps
  extends React.ComponentPropsWithoutRef<"button"> {
  animationDisabled?: boolean;
  children: React.ReactNode;
  icon?: React.ReactNode;
  loading?: boolean;
}

function PaperPlaneIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        d="M1.946 9.315c-.522-.174-.527-.455.01-.634l19.087-6.362c.529-.176.832.12.684.638l-5.454 19.086c-.15.529-.455.547-.679.045L12 14l6-8-8 6-8.054-2.685Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function AnimatedActionButton({
  animationDisabled = false,
  children,
  className,
  disabled = false,
  icon,
  loading = false,
  type = "button",
  ...props
}: AnimatedActionButtonProps) {
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) {
      return;
    }

    const updateButtonWidth = () => {
      const width = button.getBoundingClientRect().width;
      if (width > 0) {
        button.style.setProperty(
          "--animated-action-button-width",
          `${width}px`
        );
      }
    };

    updateButtonWidth();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateButtonWidth);
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  return (
    <Button
      {...props}
      aria-busy={loading || undefined}
      className={cn(
        "animated-action-button h-auto min-h-7 max-w-full gap-0 whitespace-normal rounded-[10px] bg-primary px-3 py-2 text-[12px] text-primary-foreground",
        className
      )}
      data-animation-disabled={animationDisabled ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      disabled={disabled || loading}
      ref={buttonRef}
      type={type}
    >
      <span className="animated-action-button__viewport">
        {icon ? (
          <span aria-hidden="true" className="animated-action-button__icon">
            {icon}
          </span>
        ) : null}
        <span className="animated-action-button__label">{children}</span>
        <span aria-hidden="true" className="animated-action-button__plane">
          <span className="animated-action-button__plane-motion">
            <PaperPlaneIcon />
          </span>
        </span>
      </span>
    </Button>
  );
}
