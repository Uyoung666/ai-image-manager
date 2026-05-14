import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type ThemeMode, getCurrentTheme, toggleTheme } from "@/actions/theme";
import { Button } from "@/components/ui/button";

interface ToggleThemeProps {
  onChange?: (mode: ThemeMode) => void;
}

export default function ToggleTheme({ onChange }: ToggleThemeProps) {
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    getCurrentTheme().then(setMode);
  }, []);

  const handleToggle = useCallback(async () => {
    await toggleTheme();
    const updated = await getCurrentTheme();
    setMode(updated);
    onChange?.(updated);
  }, [onChange]);

  return (
    <Button onClick={handleToggle} size="icon" variant="ghost">
      {mode === "dark" ? (
        <Moon size={16} />
      ) : mode === "light" ? (
        <Sun size={16} />
      ) : (
        <Monitor size={16} />
      )}
    </Button>
  );
}
