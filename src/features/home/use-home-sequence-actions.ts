import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { photoSequenceActions } from "@/actions/photo-sequences";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";

interface SequenceRebuildPreview {
  existingAutomatic: number;
  folderId?: number;
  nextAutomatic: number;
  skipped?: {
    missingCaptureTime: number;
    missingDevice: number;
    missingHash: number;
  };
  timelapseSegments: number;
}
type PendingSequenceAction =
  | { id: number; type: "restore" }
  | { id: number; type: "ungroup" };
interface Options {
  activeFolderId: number | null;
  handleOpenSequenceDetails: (id: number) => void;
  setSelectedSequence: Dispatch<SetStateAction<PhotoSequenceDetail | null>>;
  setSequenceRefresh: Dispatch<SetStateAction<number>>;
}
export function useHomeSequenceActions({
  activeFolderId,
  setSelectedSequence,
  setSequenceRefresh,
  handleOpenSequenceDetails,
}: Options) {
  const { t } = useTranslation();

  const [rebuildingSequences, setRebuildingSequences] = useState(false);

  const [sequenceRebuildPreview, setSequenceRebuildPreview] =
    useState<SequenceRebuildPreview | null>(null);

  const [pendingSequenceAction, setPendingSequenceAction] =
    useState<PendingSequenceAction | null>(null);

  const handleRebuildSequences = useCallback(async () => {
    setRebuildingSequences(true);
    try {
      const folderId = activeFolderId ?? undefined;
      const preview = (await photoSequenceActions.rebuild(folderId, true)) as {
        candidatePhotos: number;
        skipped: {
          missingCaptureTime: number;
          missingDevice: number;
          missingHash: number;
        };
        existingAutomatic: number;
        nextAutomatic: number;
        timelapseSegments: number;
      };
      if (!("nextAutomatic" in preview)) {
        throw new Error("Sequence dry-run did not return a preview");
      }
      if (preview.candidatePhotos === 0) {
        toast.info(
          t("sequenceDetectionSkipped", {
            time: preview.skipped.missingCaptureTime,
            device: preview.skipped.missingDevice,
            hash: preview.skipped.missingHash,
          })
        );
        return;
      }
      setSequenceRebuildPreview({
        skipped: preview.skipped,
        existingAutomatic: preview.existingAutomatic,
        folderId,
        nextAutomatic: preview.nextAutomatic,
        timelapseSegments: preview.timelapseSegments,
      });
      return;
    } catch {
      toast.error(t("sequenceDetectFailed"));
    } finally {
      setRebuildingSequences(false);
    }
  }, [activeFolderId, t]);
  const confirmSequenceRebuild = () => {
    const preview = sequenceRebuildPreview;
    if (!preview) {
      return;
    }
    setSequenceRebuildPreview(null);
    setRebuildingSequences(true);
    photoSequenceActions
      .rebuild(preview.folderId)
      .then((result) => {
        if ("nextAutomatic" in result && result.nextAutomatic > 0) {
          toast.success(t("sequenceDetectComplete"));
        } else {
          toast.info(t("sequenceDetectNoMatches"));
        }
      })
      .catch(() => toast.error(t("sequenceDetectFailed")))
      .finally(() => setRebuildingSequences(false));
  };
  const confirmSequenceAction = () => {
    const action = pendingSequenceAction;
    if (!action) {
      return;
    }
    setPendingSequenceAction(null);
    const request =
      action.type === "restore"
        ? photoSequenceActions.restoreAutomatic(action.id)
        : photoSequenceActions.deleteManual(action.id);
    request
      .then(() => {
        setSelectedSequence(null);
        setSequenceRefresh((value) => value + 1);
        toast.success(
          action.type === "restore"
            ? t("sequenceRestoreSuccess")
            : t("sequenceUngroupSuccess")
        );
      })
      .catch(() =>
        toast.error(
          action.type === "restore"
            ? t("sequenceRestoreFailed")
            : t("sequenceUngroupFailed")
        )
      );
  };
  const handleSetSequenceRepresentative = (
    sequenceId: number,
    photoId: number
  ) => {
    photoSequenceActions
      .setRepresentative(sequenceId, photoId)
      .then(() => {
        handleOpenSequenceDetails(sequenceId);
        setSequenceRefresh((value) => value + 1);
      })
      .catch(() => toast.error(t("sequenceRepresentativeSetFailed")));
  };
  const handleSplitSequence = (sequenceId: number, position: number) => {
    photoSequenceActions
      .split(sequenceId, position)
      .then(() => {
        setSelectedSequence(null);
        setSequenceRefresh((value) => value + 1);
        toast.success(t("sequenceSplitSuccess"));
      })
      .catch(() => toast.error(t("sequenceSplitFailed")));
  };
  return {
    rebuildingSequences,
    setRebuildingSequences,
    sequenceRebuildPreview,
    setSequenceRebuildPreview,
    pendingSequenceAction,
    setPendingSequenceAction,
    handleRebuildSequences,
    confirmSequenceRebuild,
    confirmSequenceAction,
    handleSplitSequence,
    handleSetSequenceRepresentative,
  };
}
