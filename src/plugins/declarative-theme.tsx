import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { THEME_TOKEN_MAP } from "./manifest";
import type {
  NormalizedPluginManifestV2,
  PluginManifestV1,
  PluginSettingValue,
  ThemeLayerV2,
  ThemeMaterialV2,
  ThemeParam,
  ThemeRecipeV2,
  ThemeSettingBinding,
} from "./types";

const MAX_THEME_LAYERS = 4;
const SAFE_COLOR_PATTERN = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const UNSAFE_STYLE_PATTERN =
  /(?:url\s*\(|@import|javascript\s*:|expression\s*\(|var\s*\(|[{}<>;])/i;
const UNSAFE_REMOTE_ASSET_PATTERN =
  /^(?:https?:|javascript:|data:|blob:|\/\/)/i;
const SAFE_BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "hard-light",
] as const;
const SAFE_FITS = ["cover", "contain", "fill"] as const;
const SAFE_MATERIAL_KINDS = [
  "none",
  "solid",
  "glass",
  "mica",
  "acrylic",
] as const;

type DeclarativeManifest = PluginManifestV1 | NormalizedPluginManifestV2;

export interface DeclarativeThemeRecord {
  assetUrls: Record<string, string>;
  manifest: DeclarativeManifest;
  settings: Record<string, PluginSettingValue>;
}

export interface DeclarativeThemeBackdropProps {
  className?: string;
  recipe?: ThemeRecipeV2;
  record: DeclarativeThemeRecord;
  root?: HTMLElement;
}

function isBinding(value: unknown): value is ThemeSettingBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { setting?: unknown }).setting === "string"
  );
}

function isSafeColor(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length <= 80 &&
    !UNSAFE_STYLE_PATTERN.test(normalized) &&
    SAFE_COLOR_PATTERN.test(normalized)
  );
}

function isSafeTokenValue(value: string): boolean {
  return isSafeColor(value);
}

function finiteSettingValue(
  value: PluginSettingValue | undefined
): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Resolve a literal or a setting binding without evaluating plugin code. */
export function resolveThemeParam<T>(
  value: ThemeParam<T> | null | undefined,
  settings: Record<string, PluginSettingValue>
): T | undefined {
  if (isBinding(value)) {
    const bound = settings[value.setting];
    return (bound === null || bound === undefined ? undefined : bound) as
      | T
      | undefined;
  }
  return value === null || value === undefined ? undefined : value;
}

function isAllowedAssetUrl(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || UNSAFE_STYLE_PATTERN.test(normalized)) {
    return false;
  }
  // Package/user resources are already resolved by the host. The renderer
  // accepts only that exact mapping and never turns a manifest path into URL.
  return !UNSAFE_REMOTE_ASSET_PATTERN.test(normalized);
}

/**
 * Resolve a theme asset through the host-provided exact URL map. Literal
 * package paths are intentionally not concatenated into a URL here.
 */
export function resolveThemeAsset(
  value: ThemeParam<string> | null | undefined,
  settings: Record<string, PluginSettingValue>,
  assetUrls: Record<string, string>
): string | undefined {
  let lookupKey: string | undefined;
  if (isBinding(value)) {
    lookupKey = value.setting;
  } else if (typeof value === "string") {
    lookupKey = value;
  }
  if (!lookupKey) {
    return undefined;
  }
  const mapped = assetUrls[lookupKey];
  if (!(mapped && isAllowedAssetUrl(mapped))) {
    return undefined;
  }
  if (isBinding(value)) {
    const bound = settings[value.setting];
    if (typeof bound !== "string" || !bound) {
      return undefined;
    }
  }
  return mapped;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function numberParam(
  value: ThemeParam<number> | undefined,
  settings: Record<string, PluginSettingValue>,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const resolved = finiteSettingValue(resolveThemeParam(value, settings));
  return clamp(resolved ?? fallback, minimum, maximum);
}

function colorParam(
  value: ThemeParam<string>,
  settings: Record<string, PluginSettingValue>,
  fallback = "transparent"
): string {
  const resolved = resolveThemeParam(value, settings);
  return typeof resolved === "string" && isSafeColor(resolved)
    ? resolved.trim()
    : fallback;
}

function filterForLayer(
  layer: ThemeLayerV2,
  settings: Record<string, PluginSettingValue>
): string | undefined {
  const filters: string[] = [];
  if (layer.blur !== undefined) {
    filters.push(`blur(${numberParam(layer.blur, settings, 0, 100, 0)}px)`);
  }
  if (layer.brightness !== undefined) {
    filters.push(
      `brightness(${numberParam(layer.brightness, settings, 0, 2, 1)})`
    );
  }
  if (layer.saturation !== undefined) {
    filters.push(
      `saturate(${numberParam(layer.saturation, settings, 0, 2, 1)})`
    );
  }
  if (layer.hueRotate !== undefined) {
    filters.push(
      `hue-rotate(${numberParam(layer.hueRotate, settings, -360, 360, 0)}deg)`
    );
  }
  return filters.length > 0 ? filters.join(" ") : undefined;
}

function baseLayerStyle(
  layer: ThemeLayerV2,
  settings: Record<string, PluginSettingValue>
): CSSProperties {
  const opacity =
    layer.opacity === undefined
      ? 1
      : numberParam(layer.opacity, settings, 0, 1, 1);
  return {
    ...({
      "--plugin-theme-layer-filter": filterForLayer(layer, settings),
    } as CSSProperties),
    filter: filterForLayer(layer, settings),
    inset: 0,
    mixBlendMode: SAFE_BLEND_MODES.includes(layer.blendMode as never)
      ? layer.blendMode
      : undefined,
    opacity,
    pointerEvents: "none",
    position: "absolute",
  };
}

function gradientStops(
  stops: ThemeLayerV2 extends infer _Layer
    ? Array<{ color: ThemeParam<string>; offset: ThemeParam<number> }>
    : never,
  settings: Record<string, PluginSettingValue>
): string {
  return stops
    .map((stop) => {
      const offset = numberParam(stop.offset, settings, 0, 1, 0);
      return `${colorParam(stop.color, settings)} ${offset * 100}%`;
    })
    .join(", ");
}

function imageStyle(
  layer: Extract<ThemeLayerV2, { type: "image" | "video" }>,
  settings: Record<string, PluginSettingValue>
): CSSProperties {
  const fit = SAFE_FITS.includes(layer.fit as never) ? layer.fit : "cover";
  return {
    ...baseLayerStyle(layer, settings),
    height: "100%",
    objectFit: fit,
    width: "100%",
  };
}

function renderThemeLayer(
  layer: ThemeLayerV2,
  settings: Record<string, PluginSettingValue>,
  assetUrls: Record<string, string>
): ReactNode {
  const style = baseLayerStyle(layer, settings);
  if (layer.type === "solid") {
    return (
      <div
        aria-hidden="true"
        data-plugin-theme-layer={layer.id}
        key={layer.id}
        style={{ ...style, backgroundColor: colorParam(layer.color, settings) }}
      />
    );
  }
  if (layer.type === "linearGradient") {
    const angle = numberParam(layer.angle, settings, -360, 360, 0);
    return (
      <div
        aria-hidden="true"
        data-plugin-theme-layer={layer.id}
        key={layer.id}
        style={{
          ...style,
          backgroundImage: `linear-gradient(${angle}deg, ${gradientStops(layer.stops, settings)})`,
        }}
      />
    );
  }
  if (layer.type === "radialGradient") {
    const centerX = layer.center
      ? numberParam(layer.center.x, settings, 0, 1, 0.5) * 100
      : 50;
    const centerY = layer.center
      ? numberParam(layer.center.y, settings, 0, 1, 0.5) * 100
      : 50;
    return (
      <div
        aria-hidden="true"
        data-plugin-theme-layer={layer.id}
        key={layer.id}
        style={{
          ...style,
          backgroundImage: `radial-gradient(circle at ${centerX}% ${centerY}%, ${gradientStops(layer.stops, settings)})`,
        }}
      />
    );
  }
  if (layer.type === "image" || layer.type === "video") {
    const src = resolveThemeAsset(layer.asset, settings, assetUrls);
    if (!src) {
      return null;
    }
    const mediaStyle = imageStyle(layer, settings);
    if (layer.type === "image") {
      return (
        <img
          alt=""
          aria-hidden="true"
          data-plugin-theme-layer={layer.id}
          height={1080}
          key={`${layer.id}:${src}`}
          src={src}
          style={mediaStyle}
          width={1920}
        />
      );
    }
    return (
      <DeclarativeThemeVideo
        key={`${layer.id}:${src}`}
        layerId={layer.id}
        src={src}
        style={mediaStyle}
      />
    );
  }

  const colors = (layer.colors ?? []).map((color) =>
    colorParam(color, settings)
  );
  const auroraColors = colors.length > 0 ? colors : ["#5b5cf0", "#22d3ee"];
  const colorStops = auroraColors
    .map(
      (color, index) =>
        `${color} ${Math.round((index / auroraColors.length) * 100)}%`
    )
    .join(", ");
  const intensity = numberParam(layer.intensity, settings, 0, 1, 0.75);
  const speed = numberParam(layer.speed, settings, 0, 20, 1);
  const animationDuration = clamp(24 / Math.max(speed, 0.1), 2, 120);
  return (
    <div
      aria-hidden="true"
      className="plugin-theme-aurora-layer"
      data-plugin-theme-layer={layer.id}
      key={layer.id}
      style={{
        ...style,
        animation:
          speed > 0
            ? `plugin-theme-aurora-drift ${animationDuration}s ease-in-out infinite alternate`
            : undefined,
        backgroundImage: `radial-gradient(circle at 20% 25%, ${colorStops}, transparent 72%)`,
        opacity: opacityForAurora(style.opacity, intensity),
        transition: "opacity 240ms ease",
        willChange: speed > 0 ? "transform" : undefined,
      }}
    />
  );
}

function renderThemeMaterial(
  material: ThemeMaterialV2 | undefined,
  settings: Record<string, PluginSettingValue>
): ReactNode {
  if (!material || material.kind === "none") {
    return null;
  }
  let defaultBlur = 30;
  if (material.kind === "solid") {
    defaultBlur = 0;
  } else if (material.kind === "glass") {
    defaultBlur = 18;
  } else if (material.kind === "mica") {
    defaultBlur = 24;
  }
  const blur = numberParam(material.blur, settings, 0, 100, defaultBlur);
  const brightness = numberParam(material.brightness, settings, 0, 2, 1);
  const saturation = numberParam(material.saturation, settings, 0, 2, 1);
  const hueRotate = numberParam(material.hueRotate, settings, -360, 360, 0);
  const opacity = numberParam(material.opacity, settings, 0, 1, 1);
  const noise = numberParam(material.noise, settings, 0, 1, 0);
  const backdropFilter =
    material.kind === "solid"
      ? undefined
      : `blur(${blur}px) brightness(${brightness}) saturate(${saturation}) hue-rotate(${hueRotate}deg)`;
  return (
    <>
      <div
        aria-hidden="true"
        data-plugin-theme-material={material.kind}
        style={{
          WebkitBackdropFilter: backdropFilter,
          backdropFilter,
          backgroundColor: colorParam(
            material.color ?? "#00000000",
            settings,
            "transparent"
          ),
          inset: 0,
          opacity,
          pointerEvents: "none",
          position: "absolute",
        }}
      />
      {noise > 0 ? (
        <div
          aria-hidden="true"
          data-plugin-theme-material-noise="true"
          style={{
            backgroundImage:
              "radial-gradient(circle, #ffffff 0 0.5px, transparent 0.75px)",
            backgroundSize: "4px 4px",
            inset: 0,
            opacity: clamp(noise * 0.18, 0, 0.18),
            pointerEvents: "none",
            position: "absolute",
          }}
        />
      ) : null}
    </>
  );
}

function opacityForAurora(
  layerOpacity: CSSProperties["opacity"],
  intensity: number
): number {
  const base = typeof layerOpacity === "number" ? layerOpacity : 1;
  return clamp(base * intensity, 0, 1);
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function DeclarativeThemeVideo({
  layerId,
  src,
  style,
}: {
  layerId: string;
  src: string;
  style: CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const video = ref.current;
    if (!video) {
      return;
    }
    const sync = () => {
      if (reducedMotion || document.visibilityState !== "visible") {
        video.pause();
      } else {
        video.play().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      document.removeEventListener("visibilitychange", sync);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [reducedMotion]);
  return (
    <video
      autoPlay={!reducedMotion}
      data-plugin-theme-layer={layerId}
      loop
      muted
      playsInline
      ref={ref}
      src={src}
      style={style}
    />
  );
}

function isThemeRecipe(value: unknown): value is ThemeRecipeV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { layers?: unknown }).layers)
  );
}

function manifestRecipe(
  record: DeclarativeThemeRecord
): ThemeRecipeV2 | undefined {
  const theme = (record.manifest as { theme?: unknown }).theme;
  return isThemeRecipe(theme) ? theme : undefined;
}

/** Apply declarative host variables and return a lossless disposer. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the single host-variable application boundary.
export function applyDeclarativeTheme(
  root: HTMLElement,
  recipe: ThemeRecipeV2,
  settings: Record<string, PluginSettingValue>
): () => void {
  const previous = new Map<string, string>();
  const setVariable = (name: string, value: string) => {
    if (!previous.has(name)) {
      previous.set(name, root.style.getPropertyValue(name));
    }
    root.style.setProperty(name, value);
  };
  for (const [token, raw] of Object.entries(recipe.tokens ?? {})) {
    if (!Object.hasOwn(THEME_TOKEN_MAP, token)) {
      continue;
    }
    const cssVariable = THEME_TOKEN_MAP[token];
    if (!cssVariable) {
      continue;
    }
    const resolved = resolveThemeParam(raw, settings);
    let value: string | undefined;
    if (typeof resolved === "number") {
      value = String(resolved);
    } else if (typeof resolved === "string") {
      value = resolved.trim();
    }
    if (value && isSafeTokenValue(value)) {
      setVariable(cssVariable, value);
    }
  }
  const material = recipe.material;
  if (material) {
    const materialValues: [
      string,
      ThemeParam<number> | ThemeParam<string> | undefined,
    ][] = [
      ["--plugin-theme-material-blur", material.blur],
      ["--plugin-theme-material-brightness", material.brightness],
      ["--plugin-theme-material-color", material.color],
      ["--plugin-theme-material-hue-rotate", material.hueRotate],
      ["--plugin-theme-material-noise", material.noise],
      ["--plugin-theme-material-opacity", material.opacity],
      ["--plugin-theme-material-saturation", material.saturation],
    ];
    for (const [name, raw] of materialValues) {
      const resolved = resolveThemeParam(raw, settings);
      if (typeof resolved === "number" && Number.isFinite(resolved)) {
        let minimum = 0;
        let maximum = 1;
        if (name.endsWith("blur")) {
          maximum = 100;
        } else if (name.endsWith("brightness")) {
          maximum = 2;
        } else if (name.endsWith("hue-rotate")) {
          minimum = -360;
          maximum = 360;
        } else if (name.endsWith("saturation")) {
          maximum = 2;
        }
        setVariable(name, String(clamp(resolved, minimum, maximum)));
      } else if (typeof resolved === "string" && isSafeColor(resolved)) {
        setVariable(name, resolved.trim());
      }
    }
    if (SAFE_MATERIAL_KINDS.includes(material.kind as never)) {
      setVariable("--plugin-theme-material-kind", material.kind);
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value) {
        root.style.setProperty(name, value);
      } else {
        root.style.removeProperty(name);
      }
    }
  };
}

export function DeclarativeThemeBackdrop({
  className,
  recipe: explicitRecipe,
  record,
  root,
}: DeclarativeThemeBackdropProps) {
  const recipe = explicitRecipe ?? manifestRecipe(record);
  const settings = record.settings;
  const resolvedRoot =
    root ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  const layers = useMemo(
    () => (recipe?.layers ?? []).slice(0, MAX_THEME_LAYERS),
    [recipe]
  );

  useLayoutEffect(() => {
    if (!(resolvedRoot && recipe)) {
      return;
    }
    return applyDeclarativeTheme(resolvedRoot, recipe, settings);
  }, [recipe, resolvedRoot, settings]);

  if (!recipe) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className={`plugin-declarative-theme${className ? ` ${className}` : ""}`}
      data-plugin-theme="declarative"
      style={{
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        position: "absolute",
      }}
    >
      {layers.map((layer) =>
        renderThemeLayer(layer, settings, record.assetUrls)
      )}
      {renderThemeMaterial(recipe.material, settings)}
    </div>
  );
}

export const DeclarativePluginBackdrop = DeclarativeThemeBackdrop;
