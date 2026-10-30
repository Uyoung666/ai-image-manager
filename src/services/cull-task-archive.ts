import { and, eq, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { cullSessions, shootingProjects } from "@/db/schema";
import { clearCullCaches } from "@/ipc/cull/cache";
import { stopShootingProjectLibraryTasks } from "./shooting-project-library";
import { stopShootingProjectOutputTasks } from "./shooting-project-output";
import { deleteShootingProject } from "./shooting-projects";

export type ArchivedCullTask = { archivedAt: number } & (
  | { kind: "project"; id: string }
  | { kind: "library"; id: number }
);

/** Delete only the confirmed archive snapshot; never expand a search or touch originals. */
export async function clearArchivedCullTasks(tasks: ArchivedCullTask[]) {
  const result = { deleted: 0, failed: 0, skipped: 0 };
  const seen = new Set<string>();
  const db = getDatabase();
  for (const task of tasks) {
    const key = `${task.kind}:${task.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    try {
      if (task.kind === "library") {
        const removed = db
          .delete(cullSessions)
          .where(
            and(
              eq(cullSessions.id, task.id),
              isNull(cullSessions.projectId),
              eq(cullSessions.archivedAt, task.archivedAt)
            )
          )
          .returning({ id: cullSessions.id })
          .get();
        if (removed) {
          clearCullCaches(task.id);
          result.deleted++;
        } else {
          result.skipped++;
        }
        continue;
      }
      const archived = () =>
        db
          .select({ id: shootingProjects.id })
          .from(shootingProjects)
          .where(
            and(
              eq(shootingProjects.id, task.id),
              eq(shootingProjects.archivedAt, task.archivedAt)
            )
          )
          .get();
      if (!archived()) {
        result.skipped++;
        continue;
      }
      await stopShootingProjectLibraryTasks(task.id);
      await stopShootingProjectOutputTasks(task.id);
      if (!archived()) {
        result.skipped++;
        continue;
      }
      const rounds = db
        .select({ id: cullSessions.id })
        .from(cullSessions)
        .where(eq(cullSessions.projectId, task.id))
        .all();
      await deleteShootingProject(task.id);
      for (const round of rounds) {
        clearCullCaches(round.id);
      }
      result.deleted++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
