/** @vitest-environment node */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import {
  cullActionLogs,
  cullSessionPhotos,
  cullSessions,
  photos,
  shootingProjectActions,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import { clearCullCaches } from "@/ipc/cull/cache";
import {
  archiveSession,
  batchUpdatePhotoStatus,
  createSession,
  getNextPair,
  getProjectResults,
  getSession,
  getSessionSummary,
  listSessions,
  listTaskSummaries,
  submitComparison,
  undoLastAction,
  updatePhotoStatus,
} from "@/ipc/cull/handlers";
import {
  applyProjectCullTopN,
  changeProjectCullSelection,
  listProjectCullSessions,
  loadProjectCullRows,
  startProjectCullSession,
  syncProjectCullMembers,
  updateProjectCullStatus,
} from "@/services/project-cull";
import {
  getShootingProjectWorkspace,
  startShootingProjectServices,
  stopShootingProjectServices,
  undoShootingProjectSelection,
} from "@/services/shooting-projects";
import { stopThumbnailer } from "@/services/thumbnailer";
import type { ShootingProjectPhotoStatus } from "@/types/shooting-project";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({ dataPath: "" }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/import-queue", () => {
  throw new Error("Direct culling must not load the import queue");
});
vi.mock("@/services/indexer", () => {
  throw new Error("Direct culling must not load the library indexer");
});
vi.mock("@/services/ai-embedder", () => {
  throw new Error("Direct culling must not load AI");
});

let runtime: TestRuntime;

beforeEach(() => {
  runtime = new TestRuntime("project-cull-workflow");
  state.dataPath = path.join(runtime.root, "profile");
  fs.mkdirSync(state.dataPath, { recursive: true });
  vi.stubEnv("APPDATA", runtime.root);
  startShootingProjectServices();
});

afterEach(async () => {
  await stopShootingProjectServices();
  await stopThumbnailer();
  const db = getDatabase();
  for (const session of db
    .select({ id: cullSessions.id })
    .from(cullSessions)
    .all()) {
    clearCullCaches(session.id);
  }
  closeDatabase();
  vi.unstubAllEnvs();
  expect(runtime.cleanup().status).toBe("deleted");
});

function project(
  count: number,
  status: ShootingProjectPhotoStatus = "pending",
  scanning = false
) {
  const db = getDatabase();
  const id = randomUUID();
  const now = Date.now();
  const sourceRoot = path.join(runtime.root, id);
  fs.mkdirSync(sourceRoot);
  db.insert(shootingProjects)
    .values({
      id,
      name: "直接选片",
      sourceRoot,
      sourceStatus: "online",
      sourceCheckedAt: now,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      scanStatus: scanning ? "running" : "completed",
      initialScanCompleted: !scanning,
    })
    .run();
  const ids = addPhotos(id, count, status);
  return { id, ids };
}

function addPhotos(
  projectId: string,
  count: number,
  status: ShootingProjectPhotoStatus = "pending"
): string[] {
  const db = getDatabase();
  const start = db
    .select()
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, projectId))
    .all().length;
  const rows = Array.from({ length: count }, (_, index) => {
    const filename = `photo-${String(start + index).padStart(3, "0")}.jpg`;
    return {
      id: randomUUID(),
      projectId,
      filename,
      relativePath: filename,
      fileSize: 100,
      modifiedAt: index + start + 1,
      dateTaken: index + start + 1,
      format: "jpg",
      width: 100,
      height: 80,
      status,
      sourceStatus: "available" as const,
      previewStatus: "ready" as const,
      previewWidth: 100,
      previewHeight: 80,
      createdAt: Date.now() + index,
    };
  });
  if (rows.length) {
    db.insert(shootingProjectPhotos).values(rows).run();
  }
  return rows.map((row) => row.id);
}

function decisions(projectId: string) {
  return getDatabase()
    .select({
      id: shootingProjectPhotos.id,
      status: shootingProjectPhotos.status,
    })
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, projectId))
    .all();
}

describe("direct-folder culling reuses gallery culling without AI", () => {
  it("uses the project PK preference and persists a changed preference for later rounds", async () => {
    const { id } = project(3, "kept");
    const db = getDatabase();
    db.update(shootingProjects)
      .set({ pkMode: "quick" })
      .where(eq(shootingProjects.id, id))
      .run();
    const first = await startProjectCullSession({
      projectId: id,
      mode: "duel",
    });
    expect(first.pkMode).toBe("quick");
    const second = await startProjectCullSession({
      projectId: id,
      mode: "duel",
      pkMode: "fine",
    });
    expect(second.pkMode).toBe("fine");
    closeDatabase();
    expect(
      getDatabase()
        .select()
        .from(shootingProjects)
        .where(eq(shootingProjects.id, id))
        .get()?.pkMode
    ).toBe("fine");
  });
  it("archives completed library tasks without changing results or undo, and restores them after reopening", async () => {
    const db = getDatabase();
    const photo = db
      .insert(photos)
      .values({ path: "/library/one.jpg", filename: "one.jpg", createdAt: 1 })
      .returning()
      .get();
    const session = db
      .insert(cullSessions)
      .values({
        name: "Finished",
        mode: "duel",
        status: "completed",
        totalPhotos: 1,
        completedComparisons: 12,
        completedAt: 123,
        createdAt: 1,
      })
      .returning()
      .get();
    const row = db
      .insert(cullSessionPhotos)
      .values({
        sessionId: session.id,
        photoId: photo.id,
        status: "kept",
        rating: 1600,
        comparisons: 12,
        wins: 10,
        losses: 2,
      })
      .returning()
      .get();
    const log = db
      .insert(cullActionLogs)
      .values({
        sessionId: session.id,
        action: "batchStatus",
        payload: '{"entries":[]}',
        createdAt: 1,
      })
      .returning()
      .get();
    expect((await call(listSessions, {})).map((s) => s.id)).toEqual([
      session.id,
    ]);
    await call(archiveSession, { sessionId: session.id, archived: true });
    expect(await call(listSessions, {})).toEqual([]);
    closeDatabase();
    const archived = await call(listSessions, { archived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      ...session,
      archivedAt: expect.any(Number),
    });
    expect(getDatabase().select().from(cullSessionPhotos).get()).toEqual(row);
    expect(getDatabase().select().from(cullActionLogs).get()).toEqual(log);
    await call(archiveSession, { sessionId: session.id, archived: false });
    expect(await call(listSessions, { archived: true })).toEqual([]);
    expect((await call(listSessions, {}))[0]).toMatchObject(session);
  });

  it("rejects invalid, missing or project-round archive IDs without changing project or round state", async () => {
    const source = project(2);
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
    });
    const before = getDatabase()
      .select()
      .from(cullSessions)
      .where(eq(cullSessions.id, round.id))
      .get();
    await expect(
      call(archiveSession, { sessionId: -1, archived: true })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(archiveSession, { sessionId: 999_999, archived: true })
    ).rejects.toThrow();
    await expect(
      call(archiveSession, { sessionId: round.id, archived: true })
    ).rejects.toThrow();
    expect(
      getDatabase()
        .select()
        .from(cullSessions)
        .where(eq(cullSessions.id, round.id))
        .get()
    ).toEqual(before);
    expect(
      getDatabase()
        .select()
        .from(shootingProjects)
        .where(eq(shootingProjects.id, source.id))
        .get()?.archivedAt
    ).toBeNull();
  });

  it("keeps hybrid final ranks and Elo identical to PK after applying Top N and reopening", async () => {
    const source = project(8);
    const db = getDatabase();
    db.update(shootingProjects)
      .set({ workflow: "hybrid" })
      .where(eq(shootingProjects.id, source.id))
      .run();
    startProjectCullSession({ projectId: source.id, mode: "curate" });
    changeProjectCullSelection(
      source.id,
      source.ids.map((photoId, index) => ({
        photoId,
        status: index < 5 ? "kept" : "rejected",
      }))
    );
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
      scope: { kind: "all" },
    });
    const candidates = loadProjectCullRows(round.id);
    expect(candidates).toHaveLength(5);
    expect(round.projectScope).toBe("selected");
    candidates.forEach((row, index) => {
      db.update(cullSessionPhotos)
        .set({ rating: 1400 + index * 30, comparisons: 8 })
        .where(eq(cullSessionPhotos.id, row.id))
        .run();
    });
    const pk = await call(getSession, { sessionId: round.id });
    const ranked = pk.items.map((item) => ({
      filename: item.photo.filename,
      rating: item.rating,
    }));
    const final = await call(getProjectResults, { projectId: source.id });
    expect(final.rankingSessionId).toBe(round.id);
    expect(
      final.items
        .filter((item) => item.status === "kept")
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map((item) => ({ filename: item.photo.filename, rating: item.rating }))
    ).toEqual(ranked);
    expect(final.items.filter((item) => item.rank === null)).toHaveLength(3);
    applyProjectCullTopN({
      projectId: source.id,
      sessionId: round.id,
      count: 3,
    });
    closeDatabase();
    const reopened = await call(getProjectResults, {
      projectId: source.id,
      rankingSessionId: round.id,
    });
    expect(
      reopened.items
        .filter((item) => item.status === "kept")
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .map((item) => ({ filename: item.photo.filename, rating: item.rating }))
    ).toEqual(ranked.slice(0, 3));
    expect(
      reopened.items
        .filter((item) => item.rank === null)
        .every((item) => item.status === "rejected")
    ).toBe(true);
    expect(() =>
      startProjectCullSession({
        projectId: source.id,
        mode: "duel",
        scope: { kind: "selected", photoIds: [source.ids[0], source.ids[7]] },
      })
    ).toThrow();
    const other = project(2);
    const foreign = startProjectCullSession({
      projectId: other.id,
      mode: "duel",
    });
    await expect(
      call(getProjectResults, {
        projectId: source.id,
        rankingSessionId: foreign.id,
      })
    ).rejects.toThrow();
  });

  it("keeps photos outside a PK subset unranked and preserves them in the final selection", async () => {
    const source = project(4, "kept");
    startProjectCullSession({ projectId: source.id, mode: "curate" });
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
      scope: { kind: "selected", photoIds: source.ids.slice(0, 2) },
    });
    applyProjectCullTopN({
      projectId: source.id,
      sessionId: round.id,
      count: 1,
    });
    const final = await call(getProjectResults, { projectId: source.id });
    expect(final.items.filter((item) => item.status === "kept")).toHaveLength(
      3
    );
    expect(final.items.filter((item) => item.rank === null)).toHaveLength(2);
    expect(
      final.items
        .filter((item) => item.rank === null)
        .every((item) => item.status === "kept")
    ).toBe(true);
  });

  it("reuses completed sessions without resetting completion, membership or scores", () => {
    const source = project(3);
    for (const mode of ["curate", "duel"] as const) {
      const round = startProjectCullSession({ projectId: source.id, mode });
      getDatabase()
        .update(cullSessions)
        .set({ status: "completed", completedAt: 123, completedComparisons: 8 })
        .where(eq(cullSessions.id, round.id))
        .run();
      const before = loadProjectCullRows(round.id);
      const resumed = startProjectCullSession({
        projectId: source.id,
        mode,
        reuseExisting: true,
      });
      expect(resumed).toMatchObject({
        id: round.id,
        status: "completed",
        completedAt: 123,
        completedComparisons: 8,
      });
      expect(loadProjectCullRows(round.id)).toEqual(before);
    }
    expect(listProjectCullSessions(source.id)).toHaveLength(2);
    startProjectCullSession({ projectId: source.id, mode: "duel" });
    expect(listProjectCullSessions(source.id)).toHaveLength(3);
  });

  it("keeps the active PK pair when background similarity arrives, then advances after a decision", async () => {
    const source = project(4, "pending", true);
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
    });
    const first = await call(getNextPair, { sessionId: round.id });
    if (!("pair" in first && first.pair)) {
      throw new Error("Expected a pair");
    }
    const initialIds = first.pair.map((item) => item.sessionPhotoId);
    const rows = loadProjectCullRows(round.id);
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ phash: "0000000000000000" })
      .where(eq(shootingProjectPhotos.id, rows[2].projectPhotoId))
      .run();
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ phash: "0000000000000001" })
      .where(eq(shootingProjectPhotos.id, rows[3].projectPhotoId))
      .run();
    addPhotos(source.id, 1);
    const stable = await call(getNextPair, { sessionId: round.id });
    expect(stable).toMatchObject({
      pair: initialIds.map((id) => ({ sessionPhotoId: id })),
    });
    await call(submitComparison, {
      sessionId: round.id,
      winnerId: initialIds[0],
      loserId: initialIds[1],
    });
    const next = await call(getNextPair, { sessionId: round.id });
    expect(next).toMatchObject({
      pair: [rows[2].id, rows[3].id].map((id) => ({ sessionPhotoId: id })),
    });
  });

  it("appends new similarity candidates after the established curate sequence", async () => {
    const source = project(2, "pending", true);
    const session = startProjectCullSession({
      projectId: source.id,
      mode: "curate",
      sortStrategy: "similarity",
    });
    const first = await call(getNextPair, { sessionId: session.id });
    if (!("single" in first && first.single)) {
      throw new Error("Expected a single photo");
    }
    const initialId = first.single.sessionPhotoId;
    const rows = loadProjectCullRows(session.id);
    const remainingId = rows.find((row) => row.id !== initialId)?.id;
    const [added] = addPhotos(source.id, 1);
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ dateTaken: 0, phash: "0000000000000000" })
      .where(eq(shootingProjectPhotos.id, added))
      .run();
    expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
      single: { sessionPhotoId: initialId },
    });
    await call(updatePhotoStatus, {
      sessionId: session.id,
      photoId: initialId,
      status: "kept",
    });
    expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
      single: { sessionPhotoId: remainingId },
    });
  });

  it("restores the current undecided curate image after background ordering changes and a database reopen", async () => {
    const source = project(3);
    const session = startProjectCullSession({
      projectId: source.id,
      mode: "curate",
      sortStrategy: "similarity",
    });
    const first = await call(getNextPair, { sessionId: session.id });
    if (!("single" in first && first.single)) {
      throw new Error("Expected a single photo");
    }
    const firstId = first.single.sessionPhotoId;
    const rows = loadProjectCullRows(session.id);
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ dateTaken: 0 })
      .where(eq(shootingProjectPhotos.id, rows[2].projectPhotoId))
      .run();
    getDatabase()
      .update(shootingProjects)
      .set({
        browsingJson: JSON.stringify({
          currentPhotoId: rows[2].projectPhotoId,
        }),
      })
      .where(eq(shootingProjects.id, source.id))
      .run();
    expect(
      (await getShootingProjectWorkspace(source.id)).browsing.currentPhotoId
    ).toBe(first.single.photo.projectPhotoId);
    clearCullCaches(session.id);
    closeDatabase();
    expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
      single: { sessionPhotoId: firstId },
    });
  });

  it("narrows only the twenty-photo round from 100 kept to 85 and undoes the whole application once", async () => {
    const source = project(100, "kept");
    const selected = source.ids.slice(0, 20);
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
      scope: { kind: "selected", photoIds: selected },
    });
    const rows = loadProjectCullRows(round.id);
    expect(rows).toHaveLength(20);
    const before = decisions(source.id);
    await call(submitComparison, {
      sessionId: round.id,
      winnerId: rows[0].id,
      loserId: rows[1].id,
    });
    const ranked = loadProjectCullRows(round.id);
    expect(ranked[0].rating).toBeGreaterThan(1500);

    expect(
      applyProjectCullTopN({
        projectId: source.id,
        sessionId: round.id,
        count: 5,
      })
    ).toMatchObject({ success: true });
    const after = decisions(source.id);
    expect(after.filter((photo) => photo.status === "kept")).toHaveLength(85);
    expect(
      after
        .filter((photo) => !selected.includes(photo.id))
        .every((photo) => photo.status === "kept")
    ).toBe(true);
    expect(
      after
        .filter(
          (photo) => selected.includes(photo.id) && photo.status === "kept"
        )
        .map((photo) => photo.id)
        .sort()
    ).toEqual(
      ranked
        .slice(0, 5)
        .map((photo) => photo.projectPhotoId)
        .sort()
    );
    expect(
      getDatabase().select().from(shootingProjectActions).all()
    ).toHaveLength(1);

    await undoShootingProjectSelection(source.id);
    expect(decisions(source.id)).toEqual(before);
    expect(loadProjectCullRows(round.id)).toEqual(ranked);
    expect(getDatabase().select().from(photos).all()).toEqual([]);
  });

  it("permits already-kept candidates and keeps comparison undo separate from final decisions", async () => {
    const source = project(4, "kept");
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
      scope: { kind: "selected", photoIds: source.ids.slice(0, 2) },
    });
    const next = await call(getNextPair, { sessionId: round.id });
    expect(next).toMatchObject({ done: false });
    const rows = loadProjectCullRows(round.id);
    await call(submitComparison, {
      sessionId: round.id,
      winnerId: rows[0].id,
      loserId: rows[1].id,
    });
    applyProjectCullTopN({
      projectId: source.id,
      sessionId: round.id,
      count: 1,
    });
    const after = decisions(source.id);
    await call(undoLastAction, { sessionId: round.id });
    expect(decisions(source.id)).toEqual(after);
    expect(
      loadProjectCullRows(round.id).every(
        (photo) => photo.rating === 1500 && photo.comparisons === 0
      )
    ).toBe(true);
    expect(getDatabase().select().from(cullActionLogs).all()).toEqual([]);
  });

  it("resumes overlapping rounds after a database reopen without mixing their scores or membership", async () => {
    const source = project(5, "kept");
    const first = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
      scope: { kind: "selected", photoIds: source.ids.slice(0, 3) },
    });
    const second = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
      scope: { kind: "selected", photoIds: source.ids.slice(1, 4) },
    });
    const rows = loadProjectCullRows(first.id);
    await call(submitComparison, {
      sessionId: first.id,
      winnerId: rows[0].id,
      loserId: rows[1].id,
    });
    const firstRanked = loadProjectCullRows(first.id);
    closeDatabase();
    expect(
      listProjectCullSessions(source.id).map((session) => session.id)
    ).toEqual([second.id, first.id]);
    expect(loadProjectCullRows(first.id)).toEqual(firstRanked);
    expect(
      loadProjectCullRows(second.id).every(
        (photo) => photo.rating === 1500 && photo.comparisons === 0
      )
    ).toBe(true);
    expect(decisions(source.id).every((photo) => photo.status === "kept")).toBe(
      true
    );
    expect(await call(listSessions, {})).toEqual([]);
  });

  it("uses the project selection journal for shared curate mutations and preserves legacy undecided on undo", async () => {
    const source = project(1, "undecided");
    const session = startProjectCullSession({
      projectId: source.id,
      mode: "curate",
    });
    expect(
      startProjectCullSession({ projectId: source.id, mode: "curate" }).id
    ).toBe(session.id);
    const next = await call(getNextPair, { sessionId: session.id });
    expect(next).toMatchObject({ done: false });
    const item = loadProjectCullRows(session.id)[0];
    await call(updatePhotoStatus, {
      sessionId: session.id,
      photoId: item.id,
      status: "kept",
    });
    expect(decisions(source.id)[0].status).toBe("kept");
    await call(undoLastAction, { sessionId: session.id });
    expect(decisions(source.id)[0].status).toBe("undecided");
    expect(getDatabase().select().from(photos).all()).toEqual([]);
  });

  it("does not complete an initially empty whole-directory PK before discovery finishes", async () => {
    const source = project(0, "pending", true);
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
    });
    expect(await call(getNextPair, { sessionId: round.id })).toMatchObject({
      done: false,
      waiting: true,
    });
    addPhotos(source.id, 2);
    expect(loadProjectCullRows(round.id)).toHaveLength(2);
    expect(() =>
      applyProjectCullTopN({
        projectId: source.id,
        sessionId: round.id,
        count: 1,
      })
    ).toThrow();
    getDatabase()
      .update(shootingProjects)
      .set({ initialScanCompleted: true, scanStatus: "completed" })
      .where(eq(shootingProjects.id, source.id))
      .run();
    syncProjectCullMembers(round.id);
    expect(await call(getNextPair, { sessionId: round.id })).toMatchObject({
      done: false,
    });
    addPhotos(source.id, 1);
    expect(loadProjectCullRows(round.id)).toHaveLength(2);
  });

  it("waits instead of completing curate while initial discovery can still add photos", async () => {
    const source = project(1, "kept", true);
    const session = startProjectCullSession({
      projectId: source.id,
      mode: "curate",
    });
    expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
      done: false,
      waiting: true,
    });
    addPhotos(source.id, 1);
    expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
      done: false,
    });
    expect(loadProjectCullRows(session.id)).toHaveLength(2);
  });

  it("supports single-photo curate, empty curate and rejects a finished one-photo PK", async () => {
    const empty = project(0);
    const emptySession = startProjectCullSession({
      projectId: empty.id,
      mode: "curate",
    });
    expect(
      await call(getNextPair, { sessionId: emptySession.id })
    ).toMatchObject({ done: false, availability: { reason: "empty" } });
    const single = project(1);
    const singleSession = startProjectCullSession({
      projectId: single.id,
      mode: "curate",
    });
    expect(
      await call(getNextPair, { sessionId: singleSession.id })
    ).toMatchObject({ done: false });
    expect(() =>
      startProjectCullSession({ projectId: single.id, mode: "duel" })
    ).toThrow();
  });

  it("freezes explicit scopes and atomically rejects cross-project candidates and result applications", () => {
    const source = project(3, "kept", true);
    const foreign = project(2, "kept");
    expect(() =>
      startProjectCullSession({
        projectId: source.id,
        mode: "duel",
        scope: { kind: "selected", photoIds: [source.ids[0], foreign.ids[0]] },
      })
    ).toThrow();
    const round = startProjectCullSession({
      projectId: source.id,
      mode: "duel",
      scope: { kind: "selected", photoIds: source.ids.slice(0, 2) },
    });
    addPhotos(source.id, 2);
    expect(loadProjectCullRows(round.id)).toHaveLength(2);
    const before = decisions(source.id);
    expect(() =>
      applyProjectCullTopN({
        projectId: foreign.id,
        sessionId: round.id,
        count: 1,
      })
    ).toThrow();
    expect(() =>
      applyProjectCullTopN({
        projectId: source.id,
        sessionId: round.id,
        count: 3,
      })
    ).toThrow();
    expect(() =>
      updateProjectCullStatus(
        round.id,
        [loadProjectCullRows(round.id)[0].id, 999_999],
        "rejected"
      )
    ).toThrow();
    expect(decisions(source.id)).toEqual(before);
    expect(
      decisions(foreign.id).every((photo) => photo.status === "kept")
    ).toBe(true);
  });

  it("reports project selection through both shared summaries and full result rows", async () => {
    const source = project(3);
    const session = startProjectCullSession({
      projectId: source.id,
      mode: "curate",
    });
    const rows = loadProjectCullRows(session.id);
    await call(batchUpdatePhotoStatus, {
      sessionId: session.id,
      photoIds: rows.slice(0, 2).map((row) => row.id),
      status: "kept",
    });
    expect(
      await call(getSessionSummary, { sessionId: session.id })
    ).toMatchObject({
      keptCount: 2,
      pendingCount: 1,
      rejectedCount: 0,
      totalPhotos: 3,
    });
    const full = await call(getSession, { sessionId: session.id });
    expect(full.items.filter((item) => item.status === "kept")).toHaveLength(2);
    expect(
      getDatabase()
        .select()
        .from(cullSessionPhotos)
        .all()
        .every((item) => item.status === "pending")
    ).toBe(true);
  });

  it("preserves gallery pending filtering, favorite synchronization and comparison undo with unindexed photos", async () => {
    const db = getDatabase();
    const gallery = db
      .insert(photos)
      .values(
        [0, 1, 2].map((index) => ({
          path: path.join(runtime.root, `gallery-${index}.jpg`),
          filename: `gallery-${index}.jpg`,
          width: 100,
          height: 80,
        }))
      )
      .returning()
      .all();
    const session = await call(createSession, {
      name: "图库兼容",
      mode: "duel",
      photoIds: gallery.map((photo) => photo.id),
    });
    if (!session) {
      throw new Error("Gallery session was not created");
    }
    const rows = db
      .select()
      .from(cullSessionPhotos)
      .where(eq(cullSessionPhotos.sessionId, session.id))
      .all();
    await call(updatePhotoStatus, {
      sessionId: session.id,
      photoId: rows[0].id,
      status: "kept",
    });
    expect(
      db.select().from(photos).where(eq(photos.id, gallery[0].id)).get()
        ?.isFavorite
    ).toBe(true);
    const next = await call(getNextPair, { sessionId: session.id });
    expect(next).toMatchObject({ done: false });
    await call(submitComparison, {
      sessionId: session.id,
      winnerId: rows[1].id,
      loserId: rows[2].id,
    });
    await call(undoLastAction, { sessionId: session.id });
    expect(
      db
        .select()
        .from(cullSessionPhotos)
        .where(eq(cullSessionPhotos.sessionId, session.id))
        .all()
        .every((photo) => photo.rating === 1500)
    ).toBe(true);
    expect(
      db
        .select()
        .from(photos)
        .all()
        .every((photo) => !(photo.isIndexed || photo.isAiProcessed))
    ).toBe(true);
  });
});

describe("unified culling task summaries", () => {
  it("mixes sources by creation time with stable ties, shared search and archive filtering", async () => {
    const db = getDatabase();
    const first = project(1);
    db.update(shootingProjects)
      .set({ name: "Shared Project", createdAt: 10 })
      .where(eq(shootingProjects.id, first.id))
      .run();
    const library = db
      .insert(cullSessions)
      .values({
        name: "Shared Library",
        mode: "curate",
        createdAt: 20,
        status: "completed",
      })
      .returning()
      .get();
    db.insert(cullSessions)
      .values({ name: "Shared Archived", archivedAt: 30, createdAt: 30 })
      .run();
    const tasks = await call(listTaskSummaries, { search: "  SHARED  " });
    expect(tasks.map((task) => task.kind)).toEqual(["library", "project"]);
    expect(tasks[0].id).toBe(library.id);
    expect(await call(listTaskSummaries, { search: "no match" })).toEqual([]);
    expect(
      (await call(listTaskSummaries, { archived: true })).map(
        (task) => task.name
      )
    ).toEqual(["Shared Archived"]);
    db.update(shootingProjects)
      .set({ createdAt: 20 })
      .where(eq(shootingProjects.id, first.id))
      .run();
    expect(
      (await call(listTaskSummaries, {})).map((task) => task.kind)
    ).toEqual(["library", "project"]);
  });

  it("counts valid decisions instead of old counters, including early endings and zero photos", async () => {
    const db = getDatabase();
    const session = db
      .insert(cullSessions)
      .values({
        name: "Early finish",
        mode: "curate",
        status: "completed",
        completedComparisons: 99,
      })
      .returning()
      .get();
    for (const [index, status] of [
      "kept",
      "rejected",
      "pending",
      "kept",
    ].entries()) {
      const photo = db
        .insert(photos)
        .values({
          path: `/summary/${index}.jpg`,
          filename: `${index}.jpg`,
          createdAt: 1,
          deletedAt: index === 3 ? 2 : null,
        })
        .returning()
        .get();
      db.insert(cullSessionPhotos)
        .values({ sessionId: session.id, photoId: photo.id, status })
        .run();
    }
    const [task] = await call(listTaskSummaries, {});
    expect(task).toMatchObject({
      photoCount: 3,
      keptCount: 1,
      stages: [
        {
          status: "completed",
          processedCount: 2,
          totalPhotos: 3,
          progress: 67,
        },
      ],
    });
    db.update(photos).set({ deletedAt: 2 }).run();
    expect((await call(listTaskSummaries, {}))[0]).toMatchObject({
      photoCount: 0,
      keptCount: 0,
      stages: [{ processedCount: 0, progress: 0 }],
    });
  });

  it("summarizes hybrid stages and only the latest PK scope without creating or synchronizing members", async () => {
    const db = getDatabase();
    const shoot = project(4, "kept");
    db.update(shootingProjects)
      .set({ workflow: "hybrid" })
      .where(eq(shootingProjects.id, shoot.id))
      .run();
    const curate = startProjectCullSession({
      projectId: shoot.id,
      mode: "curate",
    });
    db.update(cullSessions)
      .set({ status: "completed" })
      .where(eq(cullSessions.id, curate.id))
      .run();
    const first = startProjectCullSession({
      projectId: shoot.id,
      mode: "duel",
      scope: { kind: "selected", photoIds: shoot.ids },
    });
    db.update(cullSessions)
      .set({ status: "completed" })
      .where(eq(cullSessions.id, first.id))
      .run();
    const latest = startProjectCullSession({
      projectId: shoot.id,
      mode: "duel",
      pkMode: "quick",
      scope: { kind: "selected", photoIds: shoot.ids.slice(0, 2) },
    });
    db.update(cullSessions)
      .set({ completedComparisons: 100 })
      .where(eq(cullSessions.id, latest.id))
      .run();
    const before = db.select().from(cullSessions).all();
    const [task] = await call(listTaskSummaries, {});
    expect(task.stages).toMatchObject([
      { mode: "curate", status: "completed", processedCount: 4 },
      {
        mode: "duel",
        round: 2,
        totalPhotos: 2,
        comparisons: 100,
        progress: 99,
      },
    ]);
    expect(db.select().from(cullSessions).all()).toEqual(before);
    db.update(cullSessions)
      .set({ status: "completed" })
      .where(eq(cullSessions.id, latest.id))
      .run();
    expect((await call(listTaskSummaries, {}))[0].stages[1].progress).toBe(100);
    expect(await call(listTaskSummaries, { search: "no match" })).toEqual([]);
  });

  it("reports offline sources and preparation without changing persisted records or starting sessions", async () => {
    const db = getDatabase();
    const shoot = project(0, "pending", true);
    db.update(shootingProjects)
      .set({
        sourceRoot: path.join(runtime.root, "missing"),
        workflow: "hybrid",
      })
      .where(eq(shootingProjects.id, shoot.id))
      .run();
    const before = db.select().from(shootingProjects).all();
    const [task] = await call(listTaskSummaries, {});
    expect(task).toMatchObject({
      sourceStatus: "offline",
      scanStatus: "running",
      stages: [{ status: "not-started" }, { status: "not-started" }],
    });
    expect(db.select().from(shootingProjects).all()).toEqual(before);
    expect(db.select().from(cullSessions).all()).toEqual([]);
  });
});

it("turns source permission failures into warnings and validates summary requests", async () => {
  project(1);
  const access = vi
    .spyOn(fs.promises, "opendir")
    .mockRejectedValueOnce(
      Object.assign(new Error("Denied"), { code: "EACCES" })
    );
  try {
    expect((await call(listTaskSummaries, {}))[0].sourceStatus).toBe(
      "inaccessible"
    );
    expect(getDatabase().select().from(cullSessions).all()).toEqual([]);
    await expect(
      call(listTaskSummaries, { search: "x".repeat(201) })
    ).rejects.toThrow();
  } finally {
    access.mockRestore();
  }
});

it("distinguishes failed previews from active preparation without completing the session", async () => {
  const source = project(2);
  const session = startProjectCullSession({
    projectId: source.id,
    mode: "curate",
  });
  getDatabase()
    .update(shootingProjectPhotos)
    .set({ previewStatus: "failed" })
    .where(eq(shootingProjectPhotos.projectId, source.id))
    .run();
  expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
    done: false,
    waiting: false,
    availability: { reason: "failed", unavailable: 2 },
  });
  getDatabase()
    .update(shootingProjectPhotos)
    .set({ previewStatus: "pending" })
    .where(eq(shootingProjectPhotos.projectId, source.id))
    .run();
  expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
    done: false,
    waiting: true,
    availability: { reason: "previews" },
  });
  getDatabase()
    .update(shootingProjects)
    .set({ sourceStatus: "offline" })
    .where(eq(shootingProjects.id, source.id))
    .run();
  expect(await call(getNextPair, { sessionId: session.id })).toMatchObject({
    done: false,
    waiting: false,
    availability: { reason: "offline" },
  });
  expect(listProjectCullSessions(source.id)[0].status).toBe("active");
});
