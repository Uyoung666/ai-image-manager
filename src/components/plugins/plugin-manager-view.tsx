import {
  AlertCircle,
  Blocks,
  CheckCircle2,
  Code2,
  Download,
  Eye,
  FolderOpen,
  Info,
  LogOut,
  PackageCheck,
  PackageOpen,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  LocalizedText,
  NormalizedPluginManifest,
  PluginManifest,
  PluginRecord,
  PluginSettingValue,
  PluginSource,
  PluginStatus,
} from "@/plugins/types";
import { cn } from "@/utils/tailwind";

/**
 * A renderer-safe view of a plugin record. The view deliberately accepts both
 * normalized v2 records and the legacy v1 records exposed by the host.
 */
export interface PluginManagerPlugin {
  assetUrls?: Record<string, string>;
  enabled: boolean;
  error?: string;
  manifest: PluginManifest;
  settings?: Record<string, PluginSettingValue>;
  source: PluginSource | "dev";
  status: PluginStatus;
}

/**
 * The host may add package metadata while inspecting an archive. All metadata
 * beyond the manifest is optional so the component can also render the
 * manager's minimal inspection result.
 */
export interface PluginManagerInstallPreview {
  archiveSize?: number;
  capabilities?: string[];
  checksum?: string;
  checksumSummary?: string;
  compatibility?:
    | string
    | {
        compatible?: boolean;
        reason?: string;
      };
  compatible?: boolean;
  currentVersion?: string | null;
  existingVersion?: string;
  kind?: "install" | "update";
  manifest: PluginManifest;
  packageBytes?: number;
  packageSize?: number;
  pluginId?: string;
  relation?: string;
  signed?: boolean;
  source?: PluginSource | "dev" | "dialog";
  token?: string;
  trust?: string;
  version?: string;
}

export interface PluginManagerViewProps {
  activeId: string | null;
  developerMode?: boolean;
  installPreview?: PluginManagerInstallPreview | null;
  loading?: boolean;
  onCancelInstall?: () => void;
  onConfirmInstall?: (preview: PluginManagerInstallPreview) => void;
  onDeveloperModeChange?: (enabled: boolean) => void;
  onExitPreview?: () => void;
  onInstallPlugin?: () => void;
  onLoadDeveloperDirectory?: () => void;
  onPreviewPlugin?: (pluginId: string) => void;
  onRefresh?: () => void;
  onReloadDeveloperPlugin?: (pluginId: string) => void;
  onRemoveDeveloperPlugin?: (pluginId: string) => void;
  onSelectPlugin?: (pluginId: string) => void;
  onTogglePlugin?: (pluginId: string, enabled: boolean) => void;
  onUninstallPlugin?: (pluginId: string, removeData: boolean) => void;
  plugins: readonly PluginManagerPlugin[];
  previewId: string | null;
  selectedId: string | null;
  settingsPanel?: ReactNode;
}

type Translation = (key: string, options?: Record<string, unknown>) => string;

function localizedText(
  value: LocalizedText | string | undefined,
  language: string,
  fallback = ""
): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value) {
    return fallback;
  }
  const preferred = language.toLowerCase().startsWith("zh")
    ? value.zh
    : value.en;
  return preferred || value.en || value.zh || fallback;
}

function manifestName(
  manifest: PluginManifest,
  language: string,
  fallback: string
): string {
  return localizedText(manifest.name, language, fallback);
}

function manifestDescription(
  manifest: PluginManifest,
  language: string,
  fallback: string
): string {
  return localizedText(manifest.description, language, fallback);
}

function authorName(
  manifest: PluginManifest,
  language: string,
  fallback: string
): string {
  if ("name" in manifest.author && typeof manifest.author.name === "string") {
    return manifest.author.name || fallback;
  }
  return localizedText(manifest.author as LocalizedText, language, fallback);
}

function statusIcon(status: PluginStatus) {
  if (status === "active") {
    return CheckCircle2;
  }
  if (
    status === "incompatible" ||
    status === "invalid" ||
    status === "failed"
  ) {
    return XCircle;
  }
  return AlertCircle;
}

function statusKey(status: PluginStatus): string {
  return `pluginManagerStatus${status[0].toUpperCase()}${status.slice(1)}`;
}

function statusLabel(status: PluginStatus, t: Translation): string {
  return t(statusKey(status));
}

function sourceLabel(source: PluginSource | "dev", t: Translation): string {
  let key = "pluginManagerSourceLocal";
  if (source === "builtin") {
    key = "pluginManagerSourceBuiltin";
  } else if (source === "dev") {
    key = "pluginManagerSourceDeveloper";
  }
  return t(key);
}

function trustLabel(plugin: PluginManagerPlugin, t: Translation): string {
  if (plugin.source === "builtin") {
    return t("pluginManagerTrustTrusted");
  }
  if (plugin.source === "dev") {
    return t("pluginManagerTrustDeveloper");
  }
  return t("pluginManagerTrustUnsigned");
}

function capabilityLabel(capability: string, t: Translation): string {
  if (capability === "theme") {
    return t("pluginManagerCapabilityTheme");
  }
  return capability;
}

function formatBytes(value: number | undefined, t: Translation): string {
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    return t("pluginManagerNotAvailable");
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function checksumSummary(preview: PluginManagerInstallPreview): string {
  if (preview.checksumSummary) {
    return preview.checksumSummary;
  }
  if (!preview.checksum) {
    return "";
  }
  if (preview.checksum.length <= 20) {
    return preview.checksum;
  }
  return `${preview.checksum.slice(0, 12)}…${preview.checksum.slice(-8)}`;
}

function installationRelation(
  preview: PluginManagerInstallPreview,
  t: Translation
): string {
  if (preview.kind === "update") {
    return t("pluginManagerInstallUpgrade", {
      version:
        preview.currentVersion ??
        preview.existingVersion ??
        t("pluginManagerNotAvailable"),
    });
  }
  if (preview.kind === "install") {
    return t("pluginManagerInstallNew");
  }
  const relation = preview.relation?.toLowerCase();
  if (relation?.includes("upgrade")) {
    return t("pluginManagerInstallUpgrade", {
      version:
        preview.currentVersion ??
        preview.existingVersion ??
        t("pluginManagerNotAvailable"),
    });
  }
  if (relation?.includes("downgrade")) {
    return t("pluginManagerInstallDowngrade", {
      version:
        preview.currentVersion ??
        preview.existingVersion ??
        t("pluginManagerNotAvailable"),
    });
  }
  if (relation?.includes("replace") || relation?.includes("same")) {
    return t("pluginManagerInstallReplace");
  }
  return t("pluginManagerInstallNew");
}

function compatibilityState(preview: PluginManagerInstallPreview): {
  compatible: boolean | undefined;
  reason?: string;
} {
  if (typeof preview.compatible === "boolean") {
    return { compatible: preview.compatible };
  }
  if (typeof preview.compatibility === "string") {
    return { compatible: undefined, reason: preview.compatibility };
  }
  if (preview.compatibility) {
    return {
      compatible: preview.compatibility.compatible,
      reason: preview.compatibility.reason,
    };
  }
  return { compatible: undefined };
}

function pluginIcon(
  plugin: PluginManagerPlugin,
  fallback: string,
  alt: string
): ReactNode {
  const iconPath = "icon" in plugin.manifest ? plugin.manifest.icon : undefined;
  const iconUrl = iconPath ? plugin.assetUrls?.[iconPath] : undefined;
  if (iconUrl) {
    return (
      <img
        alt={alt}
        className="size-10 rounded-lg object-cover"
        height={40}
        src={iconUrl}
        width={40}
      />
    );
  }
  return (
    <span
      aria-label={fallback}
      className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
      role="img"
    >
      <Blocks aria-hidden="true" className="size-5" />
    </span>
  );
}

function MetadataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground [overflow-wrap:anywhere]">
        {value}
      </dd>
    </div>
  );
}

function PluginCard({
  language,
  loading,
  onSelect,
  onToggle,
  plugin,
  selected,
  t,
}: {
  language: string;
  loading: boolean;
  onSelect?: (pluginId: string) => void;
  onToggle?: (pluginId: string, enabled: boolean) => void;
  plugin: PluginManagerPlugin;
  selected: boolean;
  t: Translation;
}) {
  const title = manifestName(plugin.manifest, language, plugin.manifest.id);
  const description = manifestDescription(plugin.manifest, language, "");
  const Icon = statusIcon(plugin.status);
  const canToggle = plugin.status === "active" || plugin.status === "disabled";
  return (
    <div
      className={cn(
        "group min-w-0 rounded-xl border border-border/70 bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40",
        selected && "border-primary/60 bg-primary/5 ring-1 ring-primary/20"
      )}
      data-plugin-card-id={plugin.manifest.id}
    >
      <div className="flex min-w-0 items-start gap-3">
        <button
          aria-pressed={selected}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          data-plugin-selection="true"
          data-testid={`plugin-card-${plugin.manifest.id}`}
          onClick={() => onSelect?.(plugin.manifest.id)}
          type="button"
        >
          {pluginIcon(plugin, t("pluginManagerIconFallback"), title)}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-medium text-sm leading-snug">
                  {title}
                </p>
                <p className="mt-0.5 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                  {authorName(
                    plugin.manifest,
                    language,
                    t("pluginManagerNotAvailable")
                  )}
                  <span aria-hidden="true"> · </span>v{plugin.manifest.version}
                </p>
              </div>
            </div>
            {description ? (
              <p className="mt-2 break-words text-muted-foreground text-xs [overflow-wrap:anywhere]">
                {description}
              </p>
            ) : null}
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="rounded-full bg-muted px-1.5 py-0.5">
                {sourceLabel(plugin.source, t)}
              </span>
              <span className="rounded-full bg-muted px-1.5 py-0.5">
                {trustLabel(plugin, t)}
              </span>
              {plugin.source === "dev" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-warning">
                  <Code2 aria-hidden="true" className="size-3" />
                  {t("pluginManagerDeveloperDirectory")}
                </span>
              ) : null}
            </div>
          </div>
        </button>
        <div className="flex shrink-0 flex-col items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={statusLabel(plugin.status, t)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground"
                type="button"
              >
                <Icon aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{statusLabel(plugin.status, t)}</TooltipContent>
          </Tooltip>
          <Switch
            ariaLabel={`${t("pluginManagerToggle")}: ${title}`}
            checked={plugin.enabled}
            disabled={loading || !canToggle}
            onCheckedChange={(enabled) =>
              onToggle?.(plugin.manifest.id, enabled)
            }
          />
        </div>
      </div>
    </div>
  );
}

function DetailView({
  language,
  loading,
  onPreview,
  onReloadDeveloperPlugin,
  onRemoveDeveloperPlugin,
  onUninstall,
  plugin,
  previewId,
  settingsPanel,
  t,
}: {
  language: string;
  loading: boolean;
  onPreview?: (pluginId: string) => void;
  onReloadDeveloperPlugin?: (pluginId: string) => void;
  onRemoveDeveloperPlugin?: (pluginId: string) => void;
  onUninstall?: (pluginId: string, removeData: boolean) => void;
  plugin: PluginManagerPlugin;
  previewId: string | null;
  settingsPanel?: ReactNode;
  t: Translation;
}) {
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [removeData, setRemoveData] = useState(true);
  const title = manifestName(plugin.manifest, language, plugin.manifest.id);
  const isPreviewing = previewId === plugin.manifest.id;
  const capabilities = plugin.manifest.capabilities.map((capability) =>
    capabilityLabel(capability, t)
  );
  const minAppVersion = plugin.manifest.engine.minAppVersion;

  const closeUninstall = () => {
    setUninstallOpen(false);
    setRemoveData(true);
  };

  const openUninstall = () => {
    setRemoveData(true);
    setUninstallOpen(true);
  };

  return (
    <div className="min-w-0 space-y-4" data-plugin-detail="true">
      <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {pluginIcon(plugin, t("pluginManagerIconFallback"), title)}
            <div className="min-w-0">
              <h2 className="break-words font-semibold text-base [overflow-wrap:anywhere]">
                {title}
              </h2>
              <p className="mt-1 break-words text-muted-foreground text-xs [overflow-wrap:anywhere]">
                {manifestDescription(plugin.manifest, language, "")}
              </p>
            </div>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {isPreviewing ? null : (
              <Button
                aria-label={`${t("pluginManagerPreview")}: ${title}`}
                disabled={
                  loading ||
                  plugin.status === "incompatible" ||
                  plugin.status === "invalid"
                }
                onClick={() => onPreview?.(plugin.manifest.id)}
                size="sm"
                variant="outline"
              >
                <Eye aria-hidden="true" />
                {t("pluginManagerPreview")}
              </Button>
            )}
            {plugin.source === "dev" ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={`${t("pluginManagerReloadDeveloper")}: ${title}`}
                      disabled={loading}
                      onClick={() =>
                        onReloadDeveloperPlugin?.(plugin.manifest.id)
                      }
                      size="icon-sm"
                      variant="outline"
                    >
                      <RefreshCw aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("pluginManagerReloadDeveloper")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={`${t("pluginManagerRemoveDeveloper")}: ${title}`}
                      disabled={loading}
                      onClick={() =>
                        onRemoveDeveloperPlugin?.(plugin.manifest.id)
                      }
                      size="icon-sm"
                      variant="destructive"
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("pluginManagerRemoveDeveloper")}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
            {plugin.source === "local" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`${t("pluginManagerUninstall")}: ${title}`}
                    disabled={loading}
                    onClick={openUninstall}
                    size="icon-sm"
                    variant="destructive"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("pluginManagerUninstall")}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <dl className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2">
          <MetadataRow
            label={t("pluginManagerAuthor")}
            value={authorName(
              plugin.manifest,
              language,
              t("pluginManagerNotAvailable")
            )}
          />
          <MetadataRow
            label={t("pluginManagerVersion")}
            value={`v${plugin.manifest.version}`}
          />
          <MetadataRow
            label={t("pluginManagerSource")}
            value={sourceLabel(plugin.source, t)}
          />
          <MetadataRow
            label={t("pluginManagerTrust")}
            value={trustLabel(plugin, t)}
          />
          <MetadataRow
            label={t("pluginManagerStatus")}
            value={statusLabel(plugin.status, t)}
          />
          <MetadataRow
            label={t("pluginManagerCompatibility")}
            value={`≥ ${minAppVersion}`}
          />
          <MetadataRow
            label={t("pluginManagerCapabilities")}
            value={
              capabilities.length > 0
                ? capabilities.join(", ")
                : t("pluginManagerNotAvailable")
            }
          />
        </dl>
      </section>

      <section
        className="min-w-0 rounded-xl border border-border/70 bg-card p-4"
        data-plugin-section="configuration"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Settings2 aria-hidden="true" className="size-4 text-primary" />
          <h3 className="font-medium text-sm">
            {t("pluginManagerConfiguration")}
          </h3>
        </div>
        <div className="mt-3 min-w-0">
          {settingsPanel ?? (
            <p className="break-words text-muted-foreground text-xs">
              {t("pluginManagerNoConfiguration")}
            </p>
          )}
        </div>
      </section>

      <section
        className="min-w-0 rounded-xl border border-border/70 bg-card p-4"
        data-plugin-section="diagnostics"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Info aria-hidden="true" className="size-4 text-primary" />
          <h3 className="font-medium text-sm">
            {t("pluginManagerDiagnostics")}
          </h3>
        </div>
        <dl className="mt-3 grid min-w-0 gap-2">
          <MetadataRow
            label={t("pluginManagerPluginId")}
            value={plugin.manifest.id}
          />
          <MetadataRow
            label={t("pluginManagerEngineCompatibility")}
            value={minAppVersion}
          />
          <MetadataRow
            label={t("pluginManagerError")}
            value={plugin.error ?? t("pluginManagerNoDiagnostics")}
          />
        </dl>
      </section>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            closeUninstall();
          }
        }}
        open={uninstallOpen}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("pluginManagerUninstallTitle", { name: title })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("pluginManagerUninstallDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex min-w-0 items-start gap-2 rounded-md border border-border/70 p-2 text-xs">
            <input
              aria-label={t("pluginManagerRemoveData")}
              checked={removeData}
              className="mt-0.5 size-4 shrink-0 accent-primary"
              onChange={(event) => setRemoveData(event.target.checked)}
              type="checkbox"
            />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {t("pluginManagerRemoveData")}
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={closeUninstall}>
              {t("pluginManagerUninstallCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onUninstall?.(plugin.manifest.id, removeData);
                closeUninstall();
              }}
              variant="destructive"
            >
              {t("pluginManagerUninstallConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InstallPreviewDialog({
  language,
  loading,
  onCancel,
  onConfirm,
  preview,
  t,
}: {
  language: string;
  loading: boolean;
  onCancel?: () => void;
  onConfirm?: (preview: PluginManagerInstallPreview) => void;
  preview: PluginManagerInstallPreview | null | undefined;
  t: Translation;
}) {
  if (!preview) {
    return null;
  }
  const compatibility = compatibilityState(preview);
  const isUnsigned =
    preview.signed !== true &&
    preview.source !== "builtin" &&
    preview.trust !== "trusted";
  const title = localizedText(
    preview.manifest.name,
    language,
    preview.manifest.id
  );
  const packageSize =
    preview.packageBytes ?? preview.packageSize ?? preview.archiveSize;
  const version = preview.version ?? preview.manifest.version;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel?.();
        }
      }}
      open
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("pluginManagerInstallTitle")}</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
          <MetadataRow
            label={t("pluginManagerAuthor")}
            value={authorName(
              preview.manifest,
              language,
              t("pluginManagerNotAvailable")
            )}
          />
          <MetadataRow
            label={t("pluginManagerVersion")}
            value={`v${version}`}
          />
          <MetadataRow
            label={t("pluginManagerCapabilities")}
            value={(preview.capabilities ?? preview.manifest.capabilities)
              .map((item) => capabilityLabel(item, t))
              .join(", ")}
          />
          <MetadataRow
            label={t("pluginManagerCompatibility")}
            value={`≥ ${preview.manifest.engine.minAppVersion}`}
          />
          <MetadataRow
            label={t("pluginManagerPackageSize")}
            value={formatBytes(packageSize, t)}
          />
          <MetadataRow
            label={t("pluginManagerChecksum")}
            value={checksumSummary(preview) || t("pluginManagerNotAvailable")}
          />
          <MetadataRow
            label={t("pluginManagerInstallRelation")}
            value={installationRelation(preview, t)}
          />
        </dl>
        {compatibility.compatible === false ? (
          <div className="flex min-w-0 gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive text-xs">
            <AlertCircle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            <p className="min-w-0 break-words [overflow-wrap:anywhere]">
              {compatibility.reason || t("pluginManagerInstallBlocked")}
            </p>
          </div>
        ) : null}
        {isUnsigned ? (
          <div className="flex min-w-0 gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-warning text-xs">
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            <p className="min-w-0 break-words [overflow-wrap:anywhere]">
              {t("pluginManagerUnsignedWarning")}
            </p>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onCancel} variant="outline">
            {t("pluginManagerInstallCancel")}
          </Button>
          <Button
            disabled={loading || compatibility.compatible === false}
            onClick={() => onConfirm?.(preview)}
          >
            <PackageCheck aria-hidden="true" />
            {t("pluginManagerInstallConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PluginManagerView({
  activeId,
  developerMode = false,
  installPreview,
  loading = false,
  onCancelInstall,
  onConfirmInstall,
  onDeveloperModeChange,
  onExitPreview,
  onLoadDeveloperDirectory,
  onPreviewPlugin,
  onReloadDeveloperPlugin,
  onRemoveDeveloperPlugin,
  onRefresh,
  onSelectPlugin,
  onTogglePlugin,
  onUninstallPlugin,
  onInstallPlugin,
  plugins,
  previewId,
  selectedId,
  settingsPanel,
}: PluginManagerViewProps) {
  const { i18n, t } = useTranslation();
  const selectedPlugin = plugins.find(
    (plugin) => plugin.manifest.id === selectedId
  );
  const previewPlugin = plugins.find(
    (plugin) => plugin.manifest.id === previewId
  );
  const activePlugin = plugins.find(
    (plugin) => plugin.manifest.id === activeId
  );
  const previewTitle = previewPlugin
    ? manifestName(
        previewPlugin.manifest,
        i18n.language,
        previewPlugin.manifest.id
      )
    : t("pluginManagerPreview");

  return (
    <div
      className="flex min-w-0 max-w-full flex-col gap-4 overflow-x-hidden"
      data-layout="responsive"
      data-plugin-manager-view="true"
      data-testid="plugin-manager-view"
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-words font-semibold text-lg [overflow-wrap:anywhere]">
            {t("pluginManagerTitle")}
          </h1>
          <p className="mt-1 break-words text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {t("pluginManagerDescription")}
          </p>
        </div>
        <div className="grid w-full min-w-0 max-w-full grid-cols-1 items-center gap-2 min-[720px]:flex-1 min-[720px]:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <Button
              disabled={loading}
              onClick={onInstallPlugin}
              size="sm"
              variant="outline"
            >
              <Download aria-hidden="true" />
              {t("pluginManagerInstall")}
            </Button>
            {developerMode ? (
              <Button
                disabled={loading}
                onClick={onLoadDeveloperDirectory}
                size="sm"
                variant="outline"
              >
                <FolderOpen aria-hidden="true" />
                {t("pluginManagerLoadDirectory")}
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={t("pluginManagerRefresh")}
                  disabled={loading}
                  onClick={onRefresh}
                  size="icon-sm"
                  variant="outline"
                >
                  <RefreshCw aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("pluginManagerRefresh")}</TooltipContent>
            </Tooltip>
          </div>
          <div
            className="flex min-w-0 items-center gap-2 justify-self-end rounded-md border border-border/70 px-2 py-1.5"
            data-plugin-manager-developer-mode="true"
          >
            <Code2
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
            <span className="min-w-0 break-words text-xs">
              {t("pluginManagerDeveloperMode")}
            </span>
            <Switch
              ariaLabel={t("pluginManagerDeveloperMode")}
              checked={developerMode}
              disabled={loading}
              onCheckedChange={(enabled) => onDeveloperModeChange?.(enabled)}
            />
          </div>
        </div>
      </header>

      {previewId ? (
        <div
          className="sticky top-0 z-20 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs shadow-sm backdrop-blur"
          data-preview-banner="true"
          data-testid="preview-banner"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles
              aria-hidden="true"
              className="size-4 shrink-0 text-primary"
            />
            <p className="min-w-0 break-words [overflow-wrap:anywhere]">
              {t("pluginManagerPreviewBanner", { name: previewTitle })}
            </p>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {previewPlugin && activeId !== previewId ? (
              <Button
                disabled={
                  loading ||
                  previewPlugin.status === "incompatible" ||
                  previewPlugin.status === "invalid"
                }
                onClick={() => onTogglePlugin?.(previewId, true)}
                size="sm"
              >
                {t("pluginManagerEnable")}
              </Button>
            ) : null}
            <Button onClick={onExitPreview} size="sm" variant="outline">
              <LogOut aria-hidden="true" />
              {t("pluginManagerExitPreview")}
            </Button>
          </div>
        </div>
      ) : null}

      <div
        className="grid min-h-0 min-w-0 grid-cols-1 gap-4 min-[900px]:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)]"
        data-plugin-manager-columns="true"
        data-testid="plugin-manager-columns"
      >
        <section
          className="min-w-0 rounded-xl border border-border/70 bg-card/60 p-3"
          data-plugin-list="true"
        >
          <div className="flex min-w-0 items-center justify-between gap-2 px-1 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <PackageOpen aria-hidden="true" className="size-4 text-primary" />
              <h2 className="break-words font-medium text-sm">
                {t("pluginManagerListTitle")}
              </h2>
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {plugins.length}
            </span>
          </div>
          {plugins.length === 0 ? (
            <div className="flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground text-xs">
              <Blocks aria-hidden="true" className="size-6 opacity-60" />
              <p className="max-w-xs break-words [overflow-wrap:anywhere]">
                {t("pluginManagerEmpty")}
              </p>
            </div>
          ) : (
            <ul className="grid min-w-0 gap-2">
              {plugins.map((plugin) => (
                <li key={plugin.manifest.id}>
                  <PluginCard
                    language={i18n.language}
                    loading={loading}
                    onSelect={onSelectPlugin}
                    onToggle={onTogglePlugin}
                    plugin={plugin}
                    selected={plugin.manifest.id === selectedId}
                    t={t}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0" data-plugin-detail-pane="true">
          {selectedPlugin ? (
            <DetailView
              language={i18n.language}
              loading={loading}
              onPreview={onPreviewPlugin}
              onReloadDeveloperPlugin={onReloadDeveloperPlugin}
              onRemoveDeveloperPlugin={onRemoveDeveloperPlugin}
              onUninstall={onUninstallPlugin}
              plugin={selectedPlugin}
              previewId={previewId}
              settingsPanel={settingsPanel}
              t={t}
            />
          ) : (
            <div className="flex min-h-52 min-w-0 items-center justify-center rounded-xl border border-border/70 border-dashed p-6 text-center text-muted-foreground text-xs">
              <p className="max-w-sm break-words [overflow-wrap:anywhere]">
                {t("pluginManagerSelectHint")}
              </p>
            </div>
          )}
        </section>
      </div>

      {activePlugin && !previewId ? (
        <p className="sr-only">
          {t("pluginManagerActivePlugin", {
            name: manifestName(
              activePlugin.manifest,
              i18n.language,
              activePlugin.manifest.id
            ),
          })}
        </p>
      ) : null}

      <InstallPreviewDialog
        language={i18n.language}
        loading={loading}
        onCancel={onCancelInstall}
        onConfirm={onConfirmInstall}
        preview={installPreview}
        t={t}
      />
    </div>
  );
}

// Keep the record type import visible to downstream consumers that used the
// previous generic name while the view accepts the renderer-safe structural
// union above.
export type PluginManagerRecord = PluginRecord<NormalizedPluginManifest>;
