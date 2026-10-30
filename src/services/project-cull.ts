import { and, asc, desc, eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  cullSessionPhotos,
  cullSessions,
  shootingProjectActions,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import type { StartProjectCullInput } from "@/types/cull";
import type { ShootingProjectPhotoStatus } from "@/types/shooting-project";

export function getProjectCullSession(sessionId: number) {
  return getDatabase()
    .select()
    .from(cullSessions)
    .where(eq(cullSessions.id, sessionId))
    .get();
}

function requireProject(projectId: string) {
  const project = getDatabase()
    .select()
    .from(shootingProjects)
    .where(eq(shootingProjects.id, projectId))
    .get();
  if (!project) {
    throw new Error("拍摄项目不存在");
  }
  return project;
}

/** Project decisions have one journal, shared by curate and all PK rounds. */
export function changeProjectCullSelection(
  projectId: string,
  requested: {
    photoId: string;
    status: "pending" | "kept" | "rejected";
  }[]
) {
  requireProject(projectId);
  const db = getDatabase();
  return db.transaction(() => {
    const changes: {
      photoId: string;
      before: ShootingProjectPhotoStatus;
      after: ShootingProjectPhotoStatus;
    }[] = [];
    for (const { photoId, status } of requested) {
      const photo = db
        .select()
        .from(shootingProjectPhotos)
        .where(
          and(
            eq(shootingProjectPhotos.projectId, projectId),
            eq(shootingProjectPhotos.id, photoId)
          )
        )
        .get();
      if (!photo) {
        throw new Error("照片不在当前拍摄项目中");
      }
      if (photo.status === status) {
        continue;
      }
      changes.push({ photoId, before: photo.status, after: status });
      db.update(shootingProjectPhotos)
        .set({ status })
        .where(eq(shootingProjectPhotos.id, photoId))
        .run();
    }
    if (changes.length) {
      db.insert(shootingProjectActions)
        .values({
          projectId,
          payload: JSON.stringify(changes),
          createdAt: Date.now(),
        })
        .run();
      db.update(shootingProjects)
        .set({ updatedAt: Date.now() })
        .where(eq(shootingProjects.id, projectId))
        .run();
    }
    return { success: true, updatedCount: changes.length };
  });
}

/** Only initial, whole-directory rounds accept newly discovered members. */
export function syncProjectCullMembers(sessionId: number) {
  const db = getDatabase();
  const session = getProjectCullSession(sessionId);
  if (!session?.projectId) {
    return session;
  }
  const project = requireProject(session.projectId);
  if (session.mode !== "curate" && !session.projectScopeOpen) {
    return session;
  }
  db.transaction(() => {
    const existing = new Set(
      db
        .select({ id: cullSessionPhotos.projectPhotoId })
        .from(cullSessionPhotos)
        .where(eq(cullSessionPhotos.sessionId, sessionId))
        .all()
        .map((row) => row.id)
    );
    const discovered = db
      .select({ id: shootingProjectPhotos.id })
      .from(shootingProjectPhotos)
      .where(eq(shootingProjectPhotos.projectId, project.id))
      .orderBy(
        asc(shootingProjectPhotos.createdAt),
        asc(shootingProjectPhotos.relativePath)
      )
      .all();
    const missing = discovered.filter((photo) => !existing.has(photo.id));
    for (let index = 0; index < missing.length; index += 400) {
      db.insert(cullSessionPhotos)
        .values(
          missing
            .slice(index, index + 400)
            .map((photo) => ({ sessionId, projectPhotoId: photo.id }))
        )
        .run();
    }
    db.update(cullSessions)
      .set({
        totalPhotos: discovered.length,
        ...(project.initialScanCompleted ? { projectScopeOpen: false } : {}),
      })
      .where(eq(cullSessions.id, sessionId))
      .run();
  });
  return getProjectCullSession(sessionId);
}

export function startProjectCullSession(input: StartProjectCullInput) {
  const db = getDatabase();
  const project = requireProject(input.projectId);
  if (input.mode === "curate" || input.reuseExisting) {
    const existing = db
      .select()
      .from(cullSessions)
      .where(
        and(
          eq(cullSessions.projectId, project.id),
          eq(cullSessions.mode, input.mode)
        )
      )
      .orderBy(desc(cullSessions.id))
      .get();
    if (existing) {
      if (!input.reuseExisting) {
        db.update(cullSessions)
          .set({ status: "active", completedAt: null })
          .where(eq(cullSessions.id, existing.id))
          .run();
      }
      return syncProjectCullMembers(existing.id) ?? existing;
    }
  }
  let scope = input.scope ?? { kind: "all" };
  const all = db
    .select({
      id: shootingProjectPhotos.id,
      status: shootingProjectPhotos.status,
    })
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, project.id))
    .orderBy(
      asc(shootingProjectPhotos.createdAt),
      asc(shootingProjectPhotos.relativePath)
    )
    .all();
  if (
    input.mode === "duel" &&
    project.workflow === "hybrid" &&
    scope.kind === "all"
  ) {
    scope = {
      kind: "selected",
      photoIds: all
        .filter((photo) => photo.status === "kept")
        .map((photo) => photo.id),
    };
  }
  const requested = scope.kind === "selected" ? new Set(scope.photoIds) : null;
  const members = all.filter((photo) => !requested || requested.has(photo.id));
  if (requested && requested.size !== members.length) {
    throw new Error("照片不在当前拍摄项目中");
  }
  if (
    input.mode === "duel" &&
    project.workflow === "hybrid" &&
    members.some((photo) => photo.status !== "kept")
  ) {
    throw new Error("组合选片的 PK 只能包含甄选保留的照片");
  }
  if (
    input.mode === "duel" &&
    members.length < 2 &&
    (requested || project.initialScanCompleted)
  ) {
    throw new Error("PK 至少需要两张照片");
  }
  return db.transaction(() => {
    if (input.pkMode) {
      db.update(shootingProjects)
        .set({ pkMode: input.pkMode })
        .where(eq(shootingProjects.id, project.id))
        .run();
    }
    const created = db
      .insert(cullSessions)
      .values({
        projectId: project.id,
        name: project.name,
        mode: input.mode,
        pkMode: input.pkMode ?? project.pkMode,
        sortStrategy: input.sortStrategy ?? "time",
        projectScope: scope.kind,
        projectScopeOpen: scope.kind === "all" && !project.initialScanCompleted,
        totalPhotos: members.length,
      })
      .returning()
      .get();
    for (let index = 0; index < members.length; index += 400) {
      db.insert(cullSessionPhotos)
        .values(
          members.slice(index, index + 400).map((photo) => ({
            sessionId: created.id,
            projectPhotoId: photo.id,
          }))
        )
        .run();
    }
    return created;
  });
}

export function listProjectCullSessions(projectId: string) {
  requireProject(projectId);
  return getDatabase()
    .select()
    .from(cullSessions)
    .where(eq(cullSessions.projectId, projectId))
    .orderBy(desc(cullSessions.id))
    .all();
}

export function loadProjectCullRows(sessionId: number) {
  const session = syncProjectCullMembers(sessionId);
  if (!session?.projectId) {
    throw new Error("选片会话不是拍摄项目");
  }
  return getDatabase()
    .select({
      id: cullSessionPhotos.id,
      projectPhotoId: shootingProjectPhotos.id,
      rating: cullSessionPhotos.rating,
      comparisons: cullSessionPhotos.comparisons,
      wins: cullSessionPhotos.wins,
      losses: cullSessionPhotos.losses,
      status: shootingProjectPhotos.status,
      phash: shootingProjectPhotos.phash,
      filename: shootingProjectPhotos.filename,
      width: shootingProjectPhotos.width,
      height: shootingProjectPhotos.height,
      format: shootingProjectPhotos.format,
      fileSize: shootingProjectPhotos.fileSize,
      fileDate: shootingProjectPhotos.dateTaken,
      modifiedAt: shootingProjectPhotos.modifiedAt,
      previewWidth: shootingProjectPhotos.previewWidth,
      previewHeight: shootingProjectPhotos.previewHeight,
      previewStatus: shootingProjectPhotos.previewStatus,
    })
    .from(cullSessionPhotos)
    .innerJoin(
      shootingProjectPhotos,
      eq(cullSessionPhotos.projectPhotoId, shootingProjectPhotos.id)
    )
    .where(
      and(
        eq(cullSessionPhotos.sessionId, sessionId),
        eq(shootingProjectPhotos.projectId, session.projectId)
      )
    )
    .orderBy(desc(cullSessionPhotos.rating), asc(cullSessionPhotos.id))
    .all();
}

export function projectCullPreparing(sessionId: number) {
  const session = getProjectCullSession(sessionId);
  if (!session?.projectId) {
    return false;
  }
  const project = requireProject(session.projectId);
  return session.mode === "curate"
    ? !project.initialScanCompleted
    : session.projectScopeOpen;
}

export function updateProjectCullStatus(
  sessionId: number,
  itemIds: number[],
  status: "pending" | "kept" | "rejected"
) {
  const session = getProjectCullSession(sessionId);
  if (!session?.projectId) {
    throw new Error("选片会话不是拍摄项目");
  }
  const requested = new Set(itemIds);
  const rows = loadProjectCullRows(sessionId).filter((row) =>
    requested.has(row.id)
  );
  if (rows.length !== requested.size) {
    throw new Error("照片不在当前选片会话中");
  }
  return changeProjectCullSelection(
    session.projectId,
    rows.map((row) => ({ photoId: row.projectPhotoId, status }))
  );
}

export function applyProjectCullTopN(input: {
  projectId: string;
  sessionId: number;
  count: number;
}) {
  const session = syncProjectCullMembers(input.sessionId);
  if (session?.projectId !== input.projectId || session.mode !== "duel") {
    throw new Error("PK 轮次不属于当前项目");
  }
  if (session.projectScopeOpen) {
    throw new Error("请等待文件发现完成后应用 PK 结果");
  }
  const rows = loadProjectCullRows(session.id);
  if (
    !Number.isInteger(input.count) ||
    input.count < 1 ||
    input.count > rows.length
  ) {
    throw new Error("保留数量无效");
  }
  return changeProjectCullSelection(
    input.projectId,
    rows.map((row, index) => ({
      photoId: row.projectPhotoId,
      status: index < input.count ? "kept" : "rejected",
    }))
  );
}

/** A project has one selection; its rank is projected from a single PK round. */
export function loadProjectResultRows(
  projectId: string,
  rankingSessionId?: number
) {
  const db = getDatabase();
  requireProject(projectId);
  const curate = db
    .select()
    .from(cullSessions)
    .where(
      and(
        eq(cullSessions.projectId, projectId),
        eq(cullSessions.mode, "curate")
      )
    )
    .get();
  if (!curate) {
    throw new Error("项目甄选会话不存在");
  }
  const ranking =
    rankingSessionId === undefined
      ? db
          .select()
          .from(cullSessions)
          .where(
            and(
              eq(cullSessions.projectId, projectId),
              eq(cullSessions.mode, "duel")
            )
          )
          .orderBy(desc(cullSessions.id))
          .get()
      : getProjectCullSession(rankingSessionId);
  if (ranking && (ranking.projectId !== projectId || ranking.mode !== "duel")) {
    throw new Error("PK 轮次不属于当前项目");
  }
  if (rankingSessionId !== undefined && !ranking) {
    throw new Error("PK 轮次不存在");
  }
  const ranked = ranking ? loadProjectCullRows(ranking.id) : [];
  const byPhoto = new Map(
    ranked.map((row, index) => [
      row.projectPhotoId,
      { ...row, rank: index + 1 },
    ])
  );
  const rows = loadProjectCullRows(curate.id).map((row) => {
    const score = byPhoto.get(row.projectPhotoId);
    return {
      ...row,
      rating: score?.rating ?? row.rating,
      comparisons: score?.comparisons ?? row.comparisons,
      wins: score?.wins ?? row.wins,
      losses: score?.losses ?? row.losses,
      rank: score?.rank ?? null,
    };
  });
  return {
    session: getProjectCullSession(curate.id) ?? curate,
    ranking: ranking ? getProjectCullSession(ranking.id) : undefined,
    rows,
  };
}

/** Archiving keeps the saved decisions, comparison history and completion state. */
export function archiveCullSession(input: {
  sessionId: number;
  archived: boolean;
}) {
  const session = getProjectCullSession(input.sessionId);
  if (!session || session.projectId) {
    throw new Error("仅支持归档独立选片任务");
  }
  return getDatabase()
    .update(cullSessions)
    .set({ archivedAt: input.archived ? Date.now() : null })
    .where(eq(cullSessions.id, input.sessionId))
    .returning()
    .get();
}
