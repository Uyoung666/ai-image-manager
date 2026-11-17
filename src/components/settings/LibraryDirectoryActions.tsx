import {
  ChevronDown,
  FolderOpen,
  FolderOutput,
  FolderPlus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  changeLibraryDirectory,
  chooseLibraryDirectory,
} from "@/actions/library-directory";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type {
  LibraryDirectoryError,
  LibraryDirectoryMode,
  LibraryDirectoryProgress,
} from "@/types/library-directory";

const actions = [
  { mode: "create", icon: FolderPlus },
  { mode: "open", icon: FolderOpen },
  { mode: "migrate", icon: FolderOutput },
] as const;

interface Props {
  currentPath: string;
  onBusyChange?: (busy: boolean) => void;
  onboarding?: boolean;
  onChanged: (path: string) => void;
}

export function LibraryDirectoryActions({
  currentPath,
  onBusyChange,
  onChanged,
  onboarding,
}: Props) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<{
    mode: LibraryDirectoryMode;
    path: string;
  }>();
  const [cleanupSource, setCleanupSource] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [working, setWorking] = useState(false);
  const [changedPath, setChangedPath] = useState<string>();
  const [warningPaths, setWarningPaths] = useState<string[]>([]);
  const [error, setError] = useState<LibraryDirectoryError>();
  const [alreadyOpen, setAlreadyOpen] = useState(false);
  const [progress, setProgress] = useState<LibraryDirectoryProgress>();
  const trigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!working) {
      return;
    }
    const onMessage = (
      event: MessageEvent<LibraryDirectoryProgress & { channel?: string }>
    ) => {
      if (
        event.source === window &&
        event.data?.channel === "data-path-migrate-progress"
      ) {
        setProgress(event.data);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [working]);

  async function choose(mode: LibraryDirectoryMode) {
    setShowActions(false);
    setChoosing(true);
    setAlreadyOpen(false);
    setError(undefined);
    setWarningPaths([]);
    setCleanupSource(false);
    try {
      const { path } = await chooseLibraryDirectory(
        t(`libraryDirectory_${mode}_title`)
      );
      if (path) {
        setSelection({ mode, path });
      }
    } catch {
      setError("unavailable");
    } finally {
      setChoosing(false);
    }
  }

  function close() {
    if (working) {
      return;
    }
    setSelection(undefined);
    setError(undefined);
    setWarningPaths([]);
    if (changedPath) {
      setChangedPath(undefined);
      onBusyChange?.(false);
      onChanged(changedPath);
    }
  }

  async function apply() {
    if (!selection || working) {
      return;
    }
    const { mode, path } = selection;
    setError(undefined);
    setWarningPaths([]);
    setProgress(undefined);
    setWorking(true);
    onBusyChange?.(true);
    let awaitingAcknowledgement = false;
    try {
      const result = await changeLibraryDirectory(
        mode === "migrate"
          ? { mode, newPath: path, cleanupSource }
          : { mode, newPath: path }
      );
      setWarningPaths(result.cleanupErrors ?? []);
      if (!result.ok) {
        setError(result.error);
      } else if (result.alreadyOpen) {
        setSelection(undefined);
        setAlreadyOpen(true);
      } else if (result.cleanupErrors?.length) {
        awaitingAcknowledgement = true;
        setChangedPath(result.path);
      } else {
        setSelection(undefined);
        onChanged(result.path);
      }
    } catch {
      setError("unavailable");
    } finally {
      setWorking(false);
      if (!awaitingAcknowledgement) {
        onBusyChange?.(false);
      }
    }
  }

  const failure = error && (
    <p
      className="text-destructive text-sm [overflow-wrap:anywhere]"
      role="alert"
    >
      {t(`libraryDirectory_error_${error}`)}
    </p>
  );

  return (
    <div className="min-w-0">
      <Popover onOpenChange={setShowActions} open={showActions}>
        <PopoverTrigger asChild>
          <Button
            className="h-8 max-w-full gap-1.5 px-3"
            data-testid="library-directory-actions"
            disabled={!currentPath || choosing || working}
            ref={trigger}
            type="button"
            variant="outline"
          >
            {t(
              onboarding ? "onboardingStep1Change" : "libraryDirectory_manage"
            )}
            <ChevronDown aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className={`max-h-[var(--radix-popover-content-available-height)] w-56 max-w-[calc(100dvw-1.5rem)] gap-0.5 overflow-y-auto p-1 ${onboarding ? "z-[105]" : ""}`}
          collisionPadding={8}
        >
          {actions.map(({ mode, icon: Icon }) => (
            <Button
              className="h-auto min-h-8 w-full min-w-0 justify-start gap-2 whitespace-normal px-2.5 py-1.5 text-left [overflow-wrap:anywhere]"
              data-testid={`library-directory-${mode}`}
              key={mode}
              onClick={() => choose(mode)}
              type="button"
              variant="ghost"
            >
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {t(`libraryDirectory_${mode}_title`)}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      {alreadyOpen && (
        <p className="mt-1.5 text-muted-foreground text-xs" role="status">
          {t("libraryDirectory_alreadyOpen")}
        </p>
      )}
      {!selection && failure}
      <Dialog
        onOpenChange={(open) => !open && close()}
        open={Boolean(selection)}
      >
        {selection && (
          <DialogContent
            className={onboarding ? "z-[110]" : undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
            overlayClassName={onboarding ? "z-[109]" : undefined}
            showCloseButton={!working}
          >
            <DialogHeader>
              <DialogTitle>
                {t(`libraryDirectory_${selection.mode}_title`)}
              </DialogTitle>
              <DialogDescription>
                {t(`libraryDirectory_${selection.mode}_hint`)}
              </DialogDescription>
            </DialogHeader>
            <dl className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]">
              {selection.mode === "migrate" && (
                <div>
                  <dt>{t("currentPath")}</dt>
                  <dd className="font-mono text-xs">{currentPath}</dd>
                </div>
              )}
              <div>
                <dt>{t("libraryDirectory_target")}</dt>
                <dd className="font-mono text-xs">{selection.path}</dd>
              </div>
            </dl>
            {selection.mode === "migrate" && !changedPath && (
              <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
                <span>{t("libraryDirectory_cleanup")}</span>
                <Switch
                  ariaLabel={t("libraryDirectory_cleanup")}
                  checked={cleanupSource}
                  disabled={working}
                  onCheckedChange={setCleanupSource}
                />
              </div>
            )}
            {working && (
              <p
                className="text-muted-foreground text-sm [overflow-wrap:anywhere]"
                role="status"
              >
                {progress?.phase === "copying"
                  ? t("copyingDataDir", progress)
                  : t(
                      `libraryDirectory_progress_${progress?.phase ?? "stopping-services"}`
                    )}
              </p>
            )}
            {failure}
            {warningPaths.length > 0 && (
              <div
                className="min-w-0 text-sm [overflow-wrap:anywhere]"
                role="status"
              >
                <p>
                  {t(
                    changedPath
                      ? "libraryDirectory_cleanupWarning"
                      : "libraryDirectory_rollbackWarning"
                  )}
                </p>
                <ul>
                  {warningPaths.map((path) => (
                    <li className="font-mono text-xs" key={path}>
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <DialogFooter>
              <Button
                disabled={working}
                onClick={close}
                type="button"
                variant="outline"
              >
                {t(changedPath ? "close" : "cancel")}
              </Button>
              {!changedPath && (
                <Button disabled={working} onClick={apply} type="button">
                  {t("confirm")}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
