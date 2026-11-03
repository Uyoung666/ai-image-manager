import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { BuiltinPlugin, BuiltinThemeRecord } from "../types";
import { OceanEngine, type OceanOptions } from "./ascii-ocean/engine";
import { ASCII_OCEAN_PLUGIN_ID } from "./ascii-ocean-manifest";
import "./ascii-ocean.css";

function OceanBackdrop({
  record,
  onError,
}: {
  record: BuiltinThemeRecord;
  onError?: (error: unknown) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OceanEngine | null>(null);
  const errorRef = useRef(onError);
  const { t } = useTranslation();
  const errorLabelRef = useRef(t("pluginManagerError"));
  errorLabelRef.current = t("pluginManagerError");
  errorRef.current = onError;
  const reducedMotion = useReducedMotion();
  const { settings } = record;
  const options: OceanOptions = {
    dark: !document.documentElement.classList.contains("light"),
    fishCount: Number(settings.fishCount ?? 80),
    interactive: settings.interactive !== false,
    reducedMotion,
    sharkCount: Number(settings.sharkCount ?? 3),
    species: String(settings.species ?? "mixed"),
    speed: Number(settings.speed ?? 0.75),
  };
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const report = (error: unknown) => {
      console.error("[plugin] ASCII Ocean rendering failed", error);
      errorRef.current?.(new Error(`${errorLabelRef.current}: ASCII Ocean`));
    };
    try {
      engineRef.current = new OceanEngine(
        canvas,
        {
          ...optionsRef.current,
          fishCount: options.fishCount,
          sharkCount: options.sharkCount,
          species: options.species,
        },
        report
      );
    } catch (error) {
      report(error);
    }
    const observer = new MutationObserver(() => {
      optionsRef.current.dark =
        !document.documentElement.classList.contains("light");
      engineRef.current?.setOptions(optionsRef.current);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      observer.disconnect();
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [options.fishCount, options.sharkCount, options.species]);

  useEffect(() => {
    engineRef.current?.setOptions({
      ...optionsRef.current,
      reducedMotion,
      interactive: options.interactive,
      speed: options.speed,
    });
  }, [reducedMotion, options.interactive, options.speed]);

  return (
    <div aria-hidden="true" className="ascii-ocean-backdrop">
      <canvas
        className="ascii-ocean-canvas"
        ref={canvasRef}
        style={{ opacity: Number(settings.intensity ?? 45) / 100 }}
      />
    </div>
  );
}

export const AsciiOceanPlugin: BuiltinPlugin = {
  id: ASCII_OCEAN_PLUGIN_ID,
  activate(context) {
    const root = context.root;
    const previous = new Map<string, string>();
    for (const [name, value] of [
      ["--ocean-panel-blur", `${context.getSetting("blur") ?? 10}px`],
      ["--ocean-panel-opacity", `${context.getSetting("opacity") ?? 65}%`],
    ]) {
      previous.set(name, root.style.getPropertyValue(name));
      root.style.setProperty(name, value);
    }
    context.setRootAttribute("data-ascii-ocean", "active");
    return () => {
      context.setRootAttribute("data-ascii-ocean", null);
      for (const [name, value] of previous) {
        if (value) {
          root.style.setProperty(name, value);
        } else {
          root.style.removeProperty(name);
        }
      }
    };
  },
  renderBackdrop: (props) => <OceanBackdrop {...props} />,
};
