import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import type {
  BuiltinPlugin,
  BuiltinPluginContext,
  BuiltinThemeRecord,
} from "../types";
import { type AquaFluidHandle, attachAquaFluid } from "./aqua-fluid";
import { NEBULA_GLASS_PLUGIN_ID } from "./nebula-glass-manifest";
import "./nebula-glass.css";

type NebulaSettings = Record<string, boolean | number | string | null>;

function useBackdropPlayback() {
  const systemReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [reducedMotion, setReducedMotion] = useState(
    () => document.documentElement.dataset.reducedMotion === "true"
  );
  const [hidden, setHidden] = useState(
    () => document.visibilityState !== "visible"
  );

  useEffect(() => {
    const root = document.documentElement;
    const syncMotion = () =>
      setReducedMotion(root.dataset.reducedMotion === "true");
    const syncVisibility = () =>
      setHidden(document.visibilityState !== "visible");
    const observer = new MutationObserver(syncMotion);
    observer.observe(root, {
      attributeFilter: ["data-reduced-motion"],
      attributes: true,
    });
    document.addEventListener("visibilitychange", syncVisibility);
    syncMotion();
    syncVisibility();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  return { hidden, reducedMotion: reducedMotion || systemReducedMotion };
}

function numberSetting(
  settings: NebulaSettings,
  id: string,
  fallback: number
): number {
  const value = settings[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringSetting(
  settings: NebulaSettings,
  id: string,
  fallback: string
): string {
  const value = settings[id];
  return typeof value === "string" ? value : fallback;
}

function AquaFluidCanvas({
  depth,
  hue,
  reduceMotion,
}: {
  depth: number;
  hue: number;
  reduceMotion: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<AquaFluidHandle | null>(null);
  const [dark, setDark] = useState(
    () => !document.documentElement.classList.contains("light")
  );
  const initialOptionsRef = useRef({
    dark,
    depth,
    hue,
    reducedMotion: reduceMotion,
  });

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(!root.classList.contains("light"));
    const observer = new MutationObserver(update);
    observer.observe(root, { attributeFilter: ["class"], attributes: true });
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const handle = attachAquaFluid(canvas, initialOptionsRef.current);
    handleRef.current = handle;
    return () => {
      handle?.dispose();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    handleRef.current?.setOptions({
      dark,
      depth,
      hue,
      reducedMotion: reduceMotion,
    });
  }, [dark, depth, hue, reduceMotion]);

  return <canvas className="nebula-glass-fluid-canvas" ref={canvasRef} />;
}

function NebulaBackdrop({ record }: { record: BuiltinThemeRecord }) {
  const settings = record.settings;
  const { hidden, reducedMotion } = useBackdropPlayback();
  const [failedAsset, setFailedAsset] = useState<string | null>(null);
  const backdrop = stringSetting(settings, "backdrop", "aurora");
  const wallpaper = record.assetUrls.wallpaper;
  const wallpaperVideo = record.assetUrls.wallpaperVideo;
  const hue = numberSetting(settings, "fluidHue", 320);
  const depth = numberSetting(settings, "fluidDepth", 25);
  const brightness = numberSetting(settings, "brightness", 50);
  const backdropBlur = numberSetting(settings, "backdropBlur", 0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const showImage =
    backdrop === "image" && wallpaper && failedAsset !== wallpaper;
  const showVideo =
    backdrop === "video" && wallpaperVideo && failedAsset !== wallpaperVideo;

  useEffect(() => {
    const video = videoRef.current;
    if (!(video && showVideo)) {
      return;
    }
    if (reducedMotion || hidden) {
      video.pause();
    } else {
      video.play().catch(() => undefined);
    }
    return () => video.pause();
  }, [hidden, reducedMotion, showVideo]);

  return (
    <div
      aria-hidden="true"
      className="nebula-glass-backdrop"
      style={
        {
          "--nebula-backdrop-blur": `${backdropBlur}px`,
          "--nebula-backdrop-brightness": `${brightness / 50}`,
          "--nebula-depth": `${depth / 100}`,
          "--nebula-hue": `${(hue + 217) % 360}deg`,
        } as CSSProperties
      }
    >
      <div className="nebula-glass-aurora" />
      {showImage ? (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: The decorative image only listens for load errors.
        <img
          alt=""
          className="nebula-glass-wallpaper"
          height={1080}
          key={wallpaper}
          onError={() => setFailedAsset(wallpaper)}
          src={wallpaper}
          width={1920}
        />
      ) : null}
      {showVideo ? (
        <video
          autoPlay={!(reducedMotion || hidden)}
          className="nebula-glass-wallpaper"
          key={wallpaperVideo}
          loop
          muted
          onError={() => setFailedAsset(wallpaperVideo)}
          playsInline
          preload="auto"
          ref={videoRef}
          src={wallpaperVideo}
        />
      ) : null}
      {backdrop === "aurora" ? (
        <AquaFluidCanvas
          depth={depth}
          hue={hue}
          reduceMotion={reducedMotion || hidden}
        />
      ) : null}
      <div className="nebula-glass-grain" />
    </div>
  );
}

export const NebulaGlassPlugin: BuiltinPlugin = {
  activate(context: BuiltinPluginContext) {
    const readNumber = (id: string, fallback: number, max: number) => {
      const value = context.getSetting(id);
      return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.min(value, max))
        : fallback;
    };
    const frost = readNumber("frost", 7, 100) / 100;
    const previous = new Map<string, { value: string; priority: string }>();
    for (const [name, value] of Object.entries({
      "--nebula-glass-blur": `${readNumber("blur", 20, 36)}px`,
      "--nebula-fill-dark": `${58 + frost * 42}%`,
      "--nebula-fill-light": `${72 + frost * 28}%`,
    })) {
      previous.set(name, {
        value: context.root.style.getPropertyValue(name),
        priority: context.root.style.getPropertyPriority(name),
      });
      context.root.style.setProperty(name, value);
    }
    context.setRootAttribute("data-nebula-glass", "active");
    context.setRootAttribute(
      "data-nebula-backdrop",
      String(context.getSetting("backdrop") ?? "aurora")
    );
    context.setRootAttribute(
      "data-nebula-mode",
      String(context.getSetting("mode") ?? "mica")
    );
    return () => {
      context.setRootAttribute("data-nebula-glass", null);
      context.setRootAttribute("data-nebula-mode", null);
      context.setRootAttribute("data-nebula-backdrop", null);
      for (const [name, { value, priority }] of previous) {
        if (value) {
          context.root.style.setProperty(name, value, priority);
        } else {
          context.root.style.removeProperty(name);
        }
      }
    };
  },
  id: NEBULA_GLASS_PLUGIN_ID,
  renderBackdrop: ({ record }) => <NebulaBackdrop record={record} />,
};
