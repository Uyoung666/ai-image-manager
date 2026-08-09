import { useCallback, useEffect, useState } from "react";
import {
  getCurrentTheme,
  getResolvedTheme,
  setTheme,
  type ThemeMode,
} from "@/actions/theme";

interface ToggleThemeProps {
  onChange?: (mode: ThemeMode) => void;
}

export default function ToggleTheme({ onChange }: ToggleThemeProps) {
  const [_mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    getCurrentTheme().then(setMode);
  }, []);

  const handleToggle = useCallback(async () => {
    // 二元切换：始终在 dark / light 之间切换
    // 若当前为 system，先解析实际主题再切换到对面
    const resolved = await getResolvedTheme();
    const next = resolved === "dark" ? "light" : "dark";
    await setTheme(next);
    setMode(next);
    onChange?.(next);
  }, [onChange]);

  // checked = 深色模式；若为 system，解析实际主题来判断
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    getResolvedTheme().then((resolved) => setIsDark(resolved === "dark"));
  }, []);

  return (
    <label className="theme-toggle-switch">
      <input
        checked={isDark}
        className="theme-toggle-input"
        onChange={handleToggle}
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
