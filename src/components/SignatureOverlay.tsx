// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noSvgWithoutTitle: scoped component lint cleanup preserves existing UI behavior
import { useEffect, useRef, useState } from "react";
import { SignatureArtwork } from "@/components/signature-artwork";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

interface SignatureOverlayProps {
  active: boolean;
  onDone?: () => void;
}

function useIsDarkMode() {
  const [isDark, setIsDark] = useState(() =>
    typeof document === "undefined"
      ? true
      : document.documentElement.classList.contains("dark")
  );

  useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(html.classList.contains("dark"));
    });
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function SignatureOverlay({ active, onDone }: SignatureOverlayProps) {
  const [phase, setPhase] = useState<"idle" | "drawing" | "done" | "fading">(
    "idle"
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isDark = useIsDarkMode();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!active) {
      setPhase("idle");
      return;
    }

    if (reduceMotion) {
      setPhase("done");
      onDone?.();
      return;
    }

    const startTimer = setTimeout(() => setPhase("drawing"), 200);
    const doneTimer = setTimeout(() => setPhase("done"), 2800);
    const fadeTimer = setTimeout(() => setPhase("fading"), 5200);
    const completeTimer = setTimeout(() => {
      setPhase("idle");
      onDone?.();
    }, 6000);

    timerRef.current = startTimer;
    return () => {
      clearTimeout(startTimer);
      clearTimeout(doneTimer);
      clearTimeout(fadeTimer);
      clearTimeout(completeTimer);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [active, onDone, reduceMotion]);

  if (phase === "idle") {
    return null;
  }

  const isDrawing = phase === "drawing";

  return (
    <div
      className={`pointer-events-none fixed inset-0 z-[10000] flex items-center justify-center ${isDark ? "bg-black/30" : "bg-white/20"}`}
      style={{
        opacity: phase === "fading" ? 0 : 1,
        transition: reduceMotion
          ? "none"
          : "opacity 800ms ease-out, background-color 400ms ease",
      }}
    >
      <SignatureArtwork
        className="h-auto w-[min(750px,90vw)]"
        isDark={isDark}
        isDrawing={isDrawing}
        reduceMotion={reduceMotion}
      />
    </div>
  );
}
