import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";

// ── Types ──────────────────────────────────────────────────────────

export interface GlobalAiProgress {
  canCancel: boolean;
  /** Whether any background AI task is currently active. */
  isRunning: boolean;
  /** 0–100 aggregate progress percentage. */
  percent: number;
  /** Which kind of task is currently active. */
  phase:
    | "idle"
    | "scanning"
    | "loading-model"
    | "embedding"
    | "tagging"
    | "face-detection"
    | "import-queue";
  /** Human-readable status line for the UI. */
  statusText: string;
}

interface ScanPayload {
  channel: "scan-progress";
  phase: "scanning" | "indexing" | "complete";
  scanned: number;
  total: number;
}

interface AiProgressPayload {
  channel: "ai-progress";
  downloadPercent?: number;
  phase:
    | "idle"
    | "loading"
    | "embedding"
    | "tagging"
    | "complete"
    | "error"
    | "tag-error"
    | "repairing";
  processed: number;
  total: number;
}

interface FaceProgressPayload {
  channel: "face-detection-progress";
  phase: "idle" | "running" | "complete";
  processed: number;
  total: number;
}

interface QueueTask {
  error?: string;
  folderPath: string;
  id: number;
  newPhotoCount?: number;
  photoCount?: number;
  position: number;
  status: "queued" | "scanning" | "embedding" | "done" | "failed" | "cancelled";
}

interface QueueStatusPayload {
  channel: "import-queue-status";
  current: QueueTask | null;
  history: QueueTask[];
  pending: QueueTask[];
}

// ── Helpers ────────────────────────────────────────────────────────

function clampPct(n: number, d: number): number {
  if (d <= 0) {
    return 0;
  }
  return Math.round(Math.min(1, n / d) * 100);
}

function getFolderDisplayName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/");
  return parts.at(-1) || fullPath;
}

interface ProgressSnapshot {
  aiPercent: number;
  aiPhase: AiProgressPayload["phase"];
  aiText: string;
  facePercent: number;
  faceText: string;
  hasAi: boolean;
  hasFace: boolean;
  hasQueue: boolean;
  hasScan: boolean;
  isFaceRunning: boolean;
  isScanning: boolean;
  queueCurrent: QueueTask | null;
  queuePending: number;
  queueText: string;
  scanPercent: number;
  scanText: string;
}

function getScanSnapshot(scan: ScanPayload | null) {
  const scanActive =
    scan !== null && scan.phase !== "complete" && scan.total > 0;
  const scanPct = scan ? clampPct(scan.scanned, scan.total) : 0;
  let scanText = "";
  if (scan) {
    scanText =
      scan.phase === "indexing"
        ? `导入并生成缩略图 ${scan.scanned}/${scan.total}`
        : `扫描文件中... ${scan.scanned}/${scan.total}`;
  }
  return {
    hasScan: scanActive,
    isScanning: scan?.phase === "scanning" || scan?.phase === "indexing",
    scanPercent: scanPct,
    scanText,
  };
}

function getAiSnapshot(ai: AiProgressPayload | null) {
  const aiActive =
    ai !== null &&
    ai.phase !== "idle" &&
    ai.phase !== "complete" &&
    ai.phase !== "error";
  let aiPct = 0;
  let aiText = "";
  if (ai) {
    if (ai.phase === "loading" || ai.phase === "repairing") {
      aiPct = ai.downloadPercent ?? 0;
      aiText =
        ai.phase === "repairing"
          ? "正在修复向量数据库..."
          : `正在初始化 AI 模型... ${aiPct}%`;
    } else if (ai.phase === "embedding") {
      aiPct = clampPct(ai.processed, ai.total);
      aiText = `AI 特征提取 ${ai.processed}/${ai.total}`;
    } else if (ai.phase === "tagging") {
      aiPct = clampPct(ai.processed, ai.total);
      aiText = `AI 标签生成 ${ai.processed}/${ai.total}`;
    }
  }
  return {
    hasAi: aiActive,
    aiPhase: ai?.phase ?? "idle",
    aiPercent: aiPct,
    aiText,
  };
}

function getFaceSnapshot(
  face: FaceProgressPayload | null,
  faceRunning: boolean
) {
  const faceActive = face !== null && face.phase === "running" && faceRunning;
  const facePct = face ? clampPct(face.processed, face.total) : 0;
  const faceText = face ? `人脸检测中 ${face.processed}/${face.total}` : "";
  return {
    hasFace: faceActive,
    isFaceRunning: faceRunning,
    facePercent: facePct,
    faceText,
  };
}

function getQueueSnapshot(
  queue: QueueStatusPayload | null,
  queueRunning: boolean
) {
  const current = queue?.current ?? null;
  const pending = queue?.pending.length ?? 0;
  const hasQueue = queueRunning && (current !== null || pending > 0);
  let queueText = "";
  if (current) {
    const name = getFolderDisplayName(current.folderPath);
    const suffix = pending > 0 ? ` (还有 ${pending} 个排队)` : "";
    queueText = `正在导入: ${name}${suffix}`;
  } else if (pending > 0) {
    queueText = `${pending} 个文件夹等待导入`;
  }
  return { hasQueue, queueCurrent: current, queuePending: pending, queueText };
}

function buildSnapshot(
  scan: ScanPayload | null,
  ai: AiProgressPayload | null,
  face: FaceProgressPayload | null,
  faceRunning: boolean,
  queue: QueueStatusPayload | null,
  queueRunning: boolean
): ProgressSnapshot {
  const scanSnap = getScanSnapshot(scan);
  const aiSnap = getAiSnapshot(ai);
  const faceSnap = getFaceSnapshot(face, faceRunning);
  const queueSnap = getQueueSnapshot(queue, queueRunning);

  return {
    hasScan: scanSnap.hasScan,
    isScanning: scanSnap.isScanning,
    scanPercent: scanSnap.scanPercent,
    scanText: scanSnap.scanText,
    hasAi: aiSnap.hasAi,
    aiPhase: aiSnap.aiPhase,
    aiPercent: aiSnap.aiPercent,
    aiText: aiSnap.aiText,
    hasFace: faceSnap.hasFace,
    isFaceRunning: faceSnap.isFaceRunning,
    facePercent: faceSnap.facePercent,
    faceText: faceSnap.faceText,
    hasQueue: queueSnap.hasQueue,
    queueCurrent: queueSnap.queueCurrent,
    queuePending: queueSnap.queuePending,
    queueText: queueSnap.queueText,
  };
}

/**
 * Resolution order (highest priority first):
 *   1. Queue running (import + AI) — the user's explicit action
 *   2. Face detection running
 *   3. CLIP model loading / embedding
 *   4. File scan / indexing
 *   5. Idle
 */
function deriveStatus(snap: ProgressSnapshot): GlobalAiProgress {
  // Queue currently processing a folder (covers scan+embed phases)
  if (snap.hasQueue && snap.queueCurrent) {
    return {
      canCancel: snap.queueCurrent.status === "scanning",
      isRunning: true,
      percent: snap.scanPercent > 0 ? snap.scanPercent : snap.aiPercent,
      statusText: snap.queueText,
      phase: "import-queue",
    };
  }

  if (snap.hasQueue && snap.queuePending > 0) {
    return {
      canCancel: false,
      isRunning: true,
      percent: 0,
      statusText: snap.queueText,
      phase: "import-queue",
    };
  }

  if (snap.hasFace && snap.isFaceRunning) {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.facePercent,
      statusText: snap.faceText,
      phase: "face-detection",
    };
  }

  if (snap.hasAi && snap.aiPhase === "loading") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "loading-model",
    };
  }

  if (snap.hasAi && snap.aiPhase === "embedding") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "embedding",
    };
  }

  if (snap.hasAi && snap.aiPhase === "tagging") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "tagging",
    };
  }

  if (snap.hasAi && snap.aiPhase === "repairing") {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.aiPercent,
      statusText: snap.aiText,
      phase: "loading-model",
    };
  }

  if (snap.hasScan) {
    return {
      canCancel: false,
      isRunning: true,
      percent: snap.scanPercent,
      statusText: snap.scanText,
      phase: "scanning",
    };
  }

  return {
    canCancel: false,
    isRunning: false,
    percent: 0,
    statusText: "",
    phase: "idle",
  };
}

// ── Hook ───────────────────────────────────────────────────────────

export function useGlobalAiStatus(): GlobalAiProgress {
  const { t } = useTranslation();
  const [scan, setScan] = useState<ScanPayload | null>(null);
  const [ai, setAi] = useState<AiProgressPayload | null>(null);
  const [face, setFace] = useState<FaceProgressPayload | null>(null);
  const [faceRunning, setFaceRunning] = useState(false);
  const [queue, setQueue] = useState<QueueStatusPayload | null>(null);
  const [queueRunning, setQueueRunning] = useState(false);

  const faceActiveRef = useRef(false);
  const lastAiPhaseRef = useRef<AiProgressPayload["phase"]>("idle");
  const prevQueueDoneIdsRef = useRef<Set<number>>(new Set());
  const seenTerminalTaskIdsRef = useRef<Set<number>>(new Set());
  const completedBatchRef = useRef({ folders: 0, photos: 0 });

  // ── Queue completion → auto-refresh UI caches ─────────────────

  const handleQueueStatus = useCallback(
    (payload: QueueStatusPayload) => {
      setQueue(payload);
      const hasActive = payload.current !== null || payload.pending.length > 0;
      setQueueRunning(hasActive);

      if (payload.history.length > 0) {
        for (const task of payload.history) {
          if (seenTerminalTaskIdsRef.current.has(task.id)) {
            continue;
          }
          seenTerminalTaskIdsRef.current.add(task.id);
          if (task.status === "done") {
            completedBatchRef.current.folders++;
            completedBatchRef.current.photos += task.newPhotoCount ?? 0;
          } else if (task.status === "failed") {
            toast.error(
              t("toastImportFailed", {
                folder: getFolderDisplayName(task.folderPath),
                error: task.error ?? "",
              })
            );
          }
        }
        const doneIds = new Set(
          payload.history
            .filter((task) => task.status === "done")
            .map((task) => task.id)
        );
        const prevIds = prevQueueDoneIdsRef.current;
        for (const id of doneIds) {
          if (!prevIds.has(id)) {
            queryClient.invalidateQueries({ queryKey: ["folders"] });
            queryClient.invalidateQueries({
              queryKey: ["photos"],
              refetchType: "active",
            });
            break;
          }
        }
        prevQueueDoneIdsRef.current = doneIds;
      }

      if (!hasActive && completedBatchRef.current.folders > 0) {
        toast.success(t("toastImportBatchComplete", completedBatchRef.current));
        completedBatchRef.current = { folders: 0, photos: 0 };
      }
    },
    [t]
  );

  const handleScanMsg = useCallback((payload: ScanPayload) => {
    setScan(payload);
    if (payload.phase === "complete") {
      setTimeout(() => {
        setScan((prev) => (prev?.phase === "complete" ? null : prev));
      }, 3000);
    }
  }, []);

  const handleFaceMsg = useCallback((payload: FaceProgressPayload) => {
    setFace(payload);
    faceActiveRef.current = payload.phase === "running";
    setFaceRunning(payload.phase === "running");
    if (payload.phase === "complete") {
      setTimeout(() => {
        setFace((prev) => (prev?.phase === "complete" ? null : prev));
        setFaceRunning(false);
      }, 3000);
    }
  }, []);

  // ── postMessage listener ─────────────────────────────────────

  const handleMessage = useCallback(
    (e: MessageEvent) => {
      const ch = e.data?.channel as string | undefined;
      if (!ch) {
        return;
      }

      switch (ch) {
        case "scan-progress":
          handleScanMsg(e.data as ScanPayload);
          break;
        case "ai-progress":
          lastAiPhaseRef.current = (e.data as AiProgressPayload).phase;
          setAi(e.data as AiProgressPayload);
          break;
        case "ai-embedding-done":
          if (lastAiPhaseRef.current === "error") {
            toast.error(t("toastAiIndexFailed"));
          } else if (lastAiPhaseRef.current === "tag-error") {
            toast.error(t("aiTagsFailed"));
          } else if (lastAiPhaseRef.current !== "idle") {
            toast.success(t("toastAiIndexReady"));
          }
          lastAiPhaseRef.current = "idle";
          setAi(null);
          queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
          break;
        case "face-detection-progress":
          handleFaceMsg(e.data as FaceProgressPayload);
          break;
        case "face-detection-done":
          setFace(null);
          setFaceRunning(false);
          faceActiveRef.current = false;
          break;
        case "import-queue-status":
          handleQueueStatus(e.data as QueueStatusPayload);
          break;
        default:
          break;
      }
    },
    [handleQueueStatus, handleScanMsg, handleFaceMsg, t]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // ── Initial state sync ──────────────────────────────────────────
  // If the user reloads while tasks are running, poll IPC once to
  // catch up. PostMessage listeners handle subsequent updates.

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const [aiStatus, faceStatus, queueStatus] = await Promise.all([
          ipc.client.photos.getAiProgress({}).catch(() => null),
          ipc.client.faces.getDetectionProgress({}).catch(() => null),
          ipc.client.photos.getImportQueueStatus({}).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        applyInitAi(aiStatus);
        applyInitFace(faceStatus);
        applyInitQueue(queueStatus);
      } catch {
        /* best-effort */
      }
    }

    function applyInitAi(raw: unknown) {
      if (!raw) {
        return;
      }
      const p = raw as AiProgressPayload & { isActive: boolean };
      if (p.isActive || p.phase === "loading" || p.phase === "embedding") {
        setAi({
          channel: "ai-progress" as const,
          phase: p.phase,
          processed: p.processed,
          total: p.total,
          downloadPercent: p.downloadPercent,
        });
      }
    }

    function applyInitFace(raw: unknown) {
      if (!raw) {
        return;
      }
      const p = raw as FaceProgressPayload;
      if (p.phase === "running") {
        setFace(p);
        faceActiveRef.current = true;
        setFaceRunning(true);
      }
    }

    function applyInitQueue(raw: unknown) {
      if (!raw) {
        return;
      }
      const q = raw as QueueStatusPayload;
      setQueue(q);
      setQueueRunning(q.current !== null || q.pending.length > 0);
      prevQueueDoneIdsRef.current = new Set(
        q.history.filter((t) => t.status === "done").map((t) => t.id)
      );
      seenTerminalTaskIdsRef.current = new Set(
        q.history.map((task) => task.id)
      );
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Derive unified status ──────────────────────────────────────

  const snap = buildSnapshot(scan, ai, face, faceRunning, queue, queueRunning);
  return deriveStatus(snap);
}
