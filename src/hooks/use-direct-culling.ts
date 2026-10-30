import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openFolderDialog } from "@/actions/shell";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { shootingProjectErrorKey } from "@/components/ShootingProjectStatus";
import type {
  ShootingProject,
  ShootingProjectSource,
} from "@/types/shooting-project";

export function useDirectCulling() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  const [source, setSource] = useState<ShootingProjectSource | null>(null);
  const openingRef = useRef(false);
  async function open(folderPath?: string) {
    if (openingRef.current || source) {
      return;
    }
    openingRef.current = true;
    setOpening(true);
    try {
      const selected = folderPath
        ? { path: folderPath }
        : await openFolderDialog();
      if (!selected.path) {
        return;
      }
      const inspected = await shootingProjectActions.inspectSource(
        selected.path
      );
      if (inspected.sourceStatus !== "online") {
        toast.error(t("shootingProject.sourceUnavailable"));
        return;
      }
      setSource(inspected);
    } catch (error) {
      toast.error(t(shootingProjectErrorKey(error)));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }
  function complete(project: ShootingProject) {
    setSource(null);
    navigate({
      to: "/shooting-projects/$projectId",
      params: { projectId: project.id },
    });
  }
  return {
    busy: opening || source !== null,
    opening,
    source,
    open: () => open(),
    openFromPath: (folderPath: string) => open(folderPath),
    complete,
    close: () => setSource(null),
  };
}
