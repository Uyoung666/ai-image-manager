import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getResolvedTheme, setTheme, type ThemeMode } from "@/actions/theme";
import {
  cancelThemeViewTransition,
  startThemeViewTransition,
} from "@/utils/theme-view-transition";

interface ToggleThemeProps {
  onChange?: (mode: ThemeMode) => void;
}

export default function ToggleTheme({ onChange }: ToggleThemeProps) {
  const { t } = useTranslation();
  const controlRef = useRef<HTMLLabelElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    mountedRef.current = true;
    getResolvedTheme().then((resolved) => {
      if (mountedRef.current && !busyRef.current) {
        setIsDark(resolved === "dark");
      }
    });
    return () => {
      mountedRef.current = false;
      cancelThemeViewTransition();
    };
  }, []);

  const handleToggle = useCallback(async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    const restoreFocus = document.activeElement === inputRef.current;
    setIsPending(true);
    try {
      const resolved = await getResolvedTheme();
      const next = resolved === "dark" ? "light" : "dark";
      await startThemeViewTransition(controlRef.current, async () => {
        await setTheme(next, { animateColors: false });
        if (mountedRef.current) {
          flushSync(() => {
            setIsDark(next === "dark");
            onChange?.(next);
          });
        }
      });
    } catch {
      if (mountedRef.current) {
        toast.error(t("saveFailed"));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        flushSync(() => setIsPending(false));
        if (restoreFocus && document.activeElement === document.body) {
          inputRef.current?.focus({ preventScroll: true });
        }
      }
    }
  }, [onChange, t]);

  return (
    <label className="theme-toggle-switch" ref={controlRef}>
      <input
        aria-label={t("settingsTheme")}
        checked={isDark}
        className="theme-toggle-input"
        disabled={isPending}
        onChange={handleToggle}
        ref={inputRef}
        type="checkbox"
      />
      <div className="theme-toggle-slider">
        <div className="theme-toggle-sun-moon">
          {/* 月亮斑点 */}
          <svg
            aria-hidden="true"
            className="theme-toggle-moon-dot theme-toggle-moon-dot-1"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-moon-dot theme-toggle-moon-dot-2"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-moon-dot theme-toggle-moon-dot-3"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          {/* 光线 */}
          <svg
            aria-hidden="true"
            className="theme-toggle-light-ray theme-toggle-light-ray-1"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-light-ray theme-toggle-light-ray-2"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-light-ray theme-toggle-light-ray-3"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          {/* 暗色云朵 */}
          <svg
            aria-hidden="true"
            className="theme-toggle-cloud-dark theme-toggle-cloud-1"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-cloud-dark theme-toggle-cloud-2"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-cloud-dark theme-toggle-cloud-3"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          {/* 亮色云朵 */}
          <svg
            aria-hidden="true"
            className="theme-toggle-cloud-light theme-toggle-cloud-4"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-cloud-light theme-toggle-cloud-5"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-cloud-light theme-toggle-cloud-6"
            viewBox="0 0 100 100"
          >
            <circle cx="50" cy="50" r="50" />
          </svg>
        </div>
        {/* 星星 */}
        <div className="theme-toggle-stars">
          <svg
            aria-hidden="true"
            className="theme-toggle-star theme-toggle-star-1"
            viewBox="0 0 20 20"
          >
            <path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-star theme-toggle-star-2"
            viewBox="0 0 20 20"
          >
            <path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-star theme-toggle-star-3"
            viewBox="0 0 20 20"
          >
            <path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" />
          </svg>
          <svg
            aria-hidden="true"
            className="theme-toggle-star theme-toggle-star-4"
            viewBox="0 0 20 20"
          >
            <path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z" />
          </svg>
        </div>
      </div>
    </label>
  );
}
