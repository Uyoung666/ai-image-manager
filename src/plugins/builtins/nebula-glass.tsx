import { type CSSProperties, useEffect, useRef, useState } from "react";
import type {
  BuiltinPlugin,
  BuiltinPluginContext,
  PluginRecord,
} from "../types";
import { type AquaFluidHandle, attachAquaFluid } from "./aqua-fluid";
import { NEBULA_GLASS_PLUGIN_ID } from "./nebula-glass-manifest";
import "./nebula-glass.css";

type NebulaSettings = Record<string, boolean | number | string>;

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

function NebulaBackdrop({ record }: { record: PluginRecord }) {
  const settings = record.settings;
  const reduceMotion =
    document.documentElement.dataset.reducedMotion === "true" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const backdrop = stringSetting(settings, "backdrop", "aurora");
  const wallpaper = record.assetUrls.wallpaper;
  const wallpaperVideo = record.assetUrls.wallpaperVideo;
  const hue = numberSetting(settings, "fluidHue", 320);
  const depth = numberSetting(settings, "fluidDepth", 25);
  const brightness = numberSetting(settings, "brightness", 50);
  const glassBlur = numberSetting(settings, "blur", 20);
  const backdropBlur = numberSetting(settings, "backdropBlur", 0);
  const frost = numberSetting(settings, "frost", 7);
  const videoRef = useRef<HTMLVideoElement>(null);
  const showFluid =
    backdrop === "aurora" ||
    (backdrop === "image" && !wallpaper) ||
    (backdrop === "video" && (!wallpaperVideo || reduceMotion));

  useEffect(() => {
    const video = videoRef.current;
    if (!(video && backdrop === "video" && wallpaperVideo)) {
      return;
    }
    const syncPlayback = () => {
      if (reduceMotion || document.visibilityState !== "visible") {
        video.pause();
        return;
      }
      video.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", syncPlayback);
    syncPlayback();
    return () => {
      document.removeEventListener("visibilitychange", syncPlayback);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [backdrop, reduceMotion, wallpaperVideo]);

  return (
    <div
      aria-hidden="true"
      className="nebula-glass-backdrop"
      style={
        {
          "--nebula-backdrop-blur": `${backdropBlur}px`,
          "--nebula-backdrop-brightness": `${brightness / 50}`,
          "--nebula-glass-blur": `${glassBlur}px`,
          "--nebula-depth": `${depth / 100}`,
          "--nebula-frost": `${Math.min(frost / 50, 1.4)}`,
          "--nebula-fill-dark": `${Math.min(frost / 50, 1.4) * 50}%`,
          "--nebula-fill-light": `${Math.min(frost / 50, 1.4) * 42}%`,
          "--nebula-hue": `${(hue + 217) % 360}deg`,
        } as CSSProperties
      }
    >
      {backdrop === "image" && wallpaper ? (
        <img
          alt=""
          className="nebula-glass-wallpaper"
          height={1080}
          key={wallpaper}
          src={wallpaper}
          width={1920}
        />
      ) : null}
      {backdrop === "video" && wallpaperVideo && !reduceMotion ? (
        <video
          autoPlay={!reduceMotion}
          className="nebula-glass-wallpaper"
          key={wallpaperVideo}
          loop
          muted
          playsInline
          ref={videoRef}
          src={wallpaperVideo}
        />
      ) : null}
      {showFluid ? (
        <>
          <div className="nebula-glass-aurora" />
          <AquaFluidCanvas
            depth={depth}
            hue={hue}
            reduceMotion={reduceMotion}
          />
        </>
      ) : null}
      <div className="nebula-glass-grain" />
    </div>
  );
}

export const NebulaGlassPlugin: BuiltinPlugin = {
  activate(context: BuiltinPluginContext) {
    context.setRootAttribute("data-nebula-glass", "active");
    context.setRootAttribute(
      "data-nebula-mode",
      String(context.getSetting("mode") ?? "mica")
    );
    return () => {
      context.setRootAttribute("data-nebula-glass", null);
      context.setRootAttribute("data-nebula-mode", null);
    };
  },
  id: NEBULA_GLASS_PLUGIN_ID,
  renderBackdrop: ({ record }) => <NebulaBackdrop record={record} />,
};
