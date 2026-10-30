import { eq, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  cullSessionPhotos,
  cullSessions,
  photos,
  shootingProjectOutputs,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import { PK_MODE_CONFIG } from "@/ipc/cull/elo";
import type { CullTaskStage, CullTaskSummary } from "@/types/cull";
import { checkSourceStatus } from "./shooting-project-source";

type Session = typeof cullSessions.$inferSelect;
interface Counts {
  kept: number;
  rejected: number;
  total: number;
}
const EMPTY_COUNTS: Counts = { total: 0, kept: 0, rejected: 0 };

export function describeCullTaskStage(
  session:
    | Pick<Session, "mode" | "status" | "pkMode" | "completedComparisons">
    | undefined,
  counts: Counts,
  mode: "curate" | "duel",
  round?: number
): CullTaskStage {
  const processedCount = counts.kept + counts.rejected;
  const comparisons = session?.completedComparisons ?? 0;
  const config =
    PK_MODE_CONFIG[session?.pkMode ?? "standard"] ?? PK_MODE_CONFIG.standard;
  const expected =
    Math.ceil((counts.total * config.minComparisons) / 2) +
    Math.ceil(counts.total * config.recompareFactor);
  let progress = 0;
  if (counts.total > 0) {
    progress =
      mode === "curate"
        ? Math.round((processedCount / counts.total) * 100)
        : Math.min(99, Math.round((comparisons / Math.max(1, expected)) * 100));
    if (mode === "duel" && session?.status === "completed") {
      progress = 100;
    }
  }
  return {
    mode,
    status: session
      ? (session.status as "active" | "completed")
      : "not-started",
    totalPhotos: counts.total,
    processedCount,
    comparisons,
    progress,
    ...(round === undefined ? {} : { round }),
  };
}

/** Batch metadata only: no member synchronization, preparation, or session creation. */
export async function listCullTaskSummaries(input: {
  archived?: boolean;
  search?: string;
}): Promise<CullTaskSummary[]> {
  const db = getDatabase();
  const sessions = db.select().from(cullSessions).all();
  const projects = db.select().from(shootingProjects).all();
  const libraryCounts = db
    .select({
      id: cullSessionPhotos.sessionId,
      total: sql<number>`count(*)`,
      kept: sql<number>`sum(case when ${cullSessionPhotos.status} = 'kept' then 1 else 0 end)`,
      rejected: sql<number>`sum(case when ${cullSessionPhotos.status} = 'rejected' then 1 else 0 end)`,
    })
    .from(cullSessionPhotos)
    .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
    .where(isNull(photos.deletedAt))
    .groupBy(cullSessionPhotos.sessionId)
    .all();
  const projectCounts = db
    .select({
      id: shootingProjectPhotos.projectId,
      total: sql<number>`count(*)`,
      kept: sql<number>`sum(case when ${shootingProjectPhotos.status} = 'kept' then 1 else 0 end)`,
      rejected: sql<number>`sum(case when ${shootingProjectPhotos.status} = 'rejected' then 1 else 0 end)`,
    })
    .from(shootingProjectPhotos)
    .groupBy(shootingProjectPhotos.projectId)
    .all();
  const roundCounts = db
    .select({
      id: cullSessionPhotos.sessionId,
      total: sql<number>`count(*)`,
      kept: sql<number>`sum(case when ${shootingProjectPhotos.status} = 'kept' then 1 else 0 end)`,
      rejected: sql<number>`sum(case when ${shootingProjectPhotos.status} = 'rejected' then 1 else 0 end)`,
    })
    .from(cullSessionPhotos)
    .innerJoin(
      shootingProjectPhotos,
      eq(cullSessionPhotos.projectPhotoId, shootingProjectPhotos.id)
    )
    .groupBy(cullSessionPhotos.sessionId)
    .all();
  const libraryById = new Map(libraryCounts.map((row) => [row.id, row]));
  const projectById = new Map(projectCounts.map((row) => [row.id, row]));
  const roundById = new Map(roundCounts.map((row) => [row.id, row]));
  const outputByProject = new Map<
    string,
    typeof shootingProjectOutputs.$inferSelect
  >();
  for (const output of db.select().from(shootingProjectOutputs).all()) {
    const previous = outputByProject.get(output.projectId);
    if (
      !previous ||
      output.createdAt > previous.createdAt ||
      (output.createdAt === previous.createdAt && output.id > previous.id)
    ) {
      outputByProject.set(output.projectId, output);
    }
  }
  const search = input.search?.trim().toLocaleLowerCase() ?? "";
  const visible = (task: { name: string; archivedAt: number | null }) =>
    (task.archivedAt !== null) === Boolean(input.archived) &&
    task.name.toLocaleLowerCase().includes(search);
  const tasks: CullTaskSummary[] = sessions
    .filter((row) => !row.projectId && visible(row))
    .map((row) => {
      const counts = libraryById.get(row.id) ?? EMPTY_COUNTS;
      const workflow = row.mode === "curate" ? "curate" : "duel";
      return {
        kind: "library",
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
        workflow,
        photoCount: counts.total,
        keptCount: counts.kept,
        stages: [describeCullTaskStage(row, counts, workflow)],
      };
    });
  const projectSessions = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.projectId) {
      const rows = projectSessions.get(session.projectId) ?? [];
      rows.push(session);
      projectSessions.set(session.projectId, rows);
    }
  }
  tasks.push(
    ...(await Promise.all(
      projects.filter(visible).map(async (project) => {
        const counts = projectById.get(project.id) ?? EMPTY_COUNTS;
        const rounds = (projectSessions.get(project.id) ?? []).sort(
          (a, b) => b.id - a.id
        );
        const curate = rounds.find((row) => row.mode === "curate");
        const duels = rounds.filter((row) => row.mode === "duel");
        const latest = duels[0];
        const stages: CullTaskStage[] = [];
        if (project.workflow !== "duel") {
          stages.push(describeCullTaskStage(curate, counts, "curate"));
        }
        if (project.workflow !== "curate" || latest) {
          stages.push(
            describeCullTaskStage(
              latest,
              latest ? (roundById.get(latest.id) ?? EMPTY_COUNTS) : counts,
              "duel",
              duels.length || undefined
            )
          );
        }
        return {
          kind: "project" as const,
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          archivedAt: project.archivedAt,
          workflow: project.workflow,
          photoCount: counts.total,
          keptCount: counts.kept,
          stages,
          sourceStatus: await checkSourceStatus(project.sourceRoot),
          scanStatus: project.scanStatus,
          outputStatus: outputByProject.get(project.id)?.status,
        };
      })
    ))
  );
  return tasks.sort(
    (a, b) =>
      b.createdAt - a.createdAt ||
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`, "en")
  );
}
