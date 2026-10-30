/** @vitest-environment node */
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  create: vi.fn(),
  inspectSource: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  remove: vi.fn(),
  stopLibrary: vi.fn(),
  stopOutput: vi.fn(),
  output: vi.fn(),
  library: vi.fn(),
}));

vi.mock("@/services/shooting-project-output", () => ({
  createShootingProjectOutput: services.output,
  stopShootingProjectOutputTasks: services.stopOutput,
  ShootingProjectOutputError: class extends Error {
    readonly code: string;
    constructor(code: string) {
      super(`Private source details: ${code}`);
      this.code = code;
    }
  },
}));
vi.mock("@/services/shooting-project-library", () => ({
  addShootingProjectToLibrary: services.library,
  stopShootingProjectLibraryTasks: services.stopLibrary,
  ShootingProjectLibraryError: class extends Error {
    readonly code: string;
    constructor(code: string) {
      super(`Private source details: ${code}`);
      this.code = code;
    }
  },
}));

vi.mock("@/services/shooting-projects", () => ({
  createShootingProject: services.create,
  inspectShootingProjectSource: services.inspectSource,
  listShootingProjects: services.list,
  openShootingProject: services.open,
  deleteShootingProject: services.remove,
  ShootingProjectError: class extends Error {
    readonly code: string;
    constructor(code: string) {
      super(`Internal context: ${code}`);
      this.code = code;
    }
  },
}));

import { shootingProjects } from "@/ipc/shooting-projects";
import { ShootingProjectLibraryError } from "@/services/shooting-project-library";
import { ShootingProjectOutputError } from "@/services/shooting-project-output";
import { ShootingProjectError } from "@/services/shooting-projects";

describe("shooting project IPC boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects malformed IDs before looking up any project", async () => {
    await expect(
      call(shootingProjects.open, { id: "../../photos" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(services.open).not.toHaveBeenCalled();
  });

  it("rejects unexpected fields and non-boolean library confirmation", async () => {
    for (const input of [
      { sourceRoot: "D:\\shoot", acknowledgeLibrarySource: "true" },
      { sourceRoot: "D:\\shoot", startAi: true },
      { sourceRoot: "D:\\shoot", name: "x".repeat(201) },
    ]) {
      await expect(
        call(shootingProjects.create, input as never)
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(services.create).not.toHaveBeenCalled();
  });

  it("returns a localizable confirmation error without exposing source details", async () => {
    services.create.mockRejectedValue(
      new ShootingProjectError("LIBRARY_CONFIRMATION_REQUIRED")
    );
    await expect(
      call(shootingProjects.create, { sourceRoot: "D:\\shoot" })
    ).rejects.toMatchObject({
      code: "LIBRARY_CONFIRMATION_REQUIRED",
      status: 400,
    });
    try {
      await call(shootingProjects.create, { sourceRoot: "D:\\shoot" });
    } catch (error) {
      expect((error as Error).message).not.toContain("Internal context");
    }
  });

  it("keeps a missing project distinct from a source that is offline", async () => {
    services.open.mockRejectedValueOnce(new ShootingProjectError("NOT_FOUND"));
    const id = "b4b7db0d-825a-460d-a4c0-c38c10f9028d";
    await expect(call(shootingProjects.open, { id })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    services.open.mockResolvedValueOnce({ id, sourceStatus: "offline" });
    await expect(call(shootingProjects.open, { id })).resolves.toMatchObject({
      id,
      sourceStatus: "offline",
    });
  });

  it("propagates a database write failure instead of returning a saved project", async () => {
    const error = new Error("database is locked");
    services.create.mockRejectedValue(error);
    await expect(
      call(shootingProjects.create, { sourceRoot: "D:\\shoot" })
    ).rejects.toBe(error);
  });

  it("rejects unsafe workflow payloads before invoking privileged operations", async () => {
    const id = "b4b7db0d-825a-460d-a4c0-c38c10f9028d";
    const requests = [
      [
        shootingProjects.select,
        { projectId: id, photoIds: ["../photo"], status: "kept" },
      ],
      [
        shootingProjects.select,
        { projectId: id, photoIds: [id], status: "favorite" },
      ],
      [
        shootingProjects.createOutput,
        { projectId: id, targetParent: "D:\\output", overwrite: true },
      ],
      [shootingProjects.retryOutput, { projectId: id, taskId: "../task" }],
      [
        shootingProjects.commitRelink,
        { projectId: id, token: "../root", acceptCandidates: true },
      ],
      [
        shootingProjects.addToLibrary,
        {
          projectId: id,
          source: "original",
          confirmed: false,
          inspectionToken: id,
        },
      ],
      [
        shootingProjects.addToLibrary,
        { projectId: id, source: "original", confirmed: true },
      ],
      [
        shootingProjects.openOutput,
        { projectId: id, taskId: id, targetRoot: "D:\\arbitrary" },
      ],
    ] as const;
    for (const [route, input] of requests) {
      await expect(call(route as never, input as never)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(services.output).not.toHaveBeenCalled();
    expect(services.library).not.toHaveBeenCalled();
  });

  it("localizes output and library failures without leaking filesystem details", async () => {
    const id = "b4b7db0d-825a-460d-a4c0-c38c10f9028d";
    services.output.mockRejectedValueOnce(
      new ShootingProjectOutputError("OUTPUT_CONFLICT")
    );
    services.library.mockRejectedValueOnce(
      new ShootingProjectLibraryError("LIBRARY_SCOPE_CHANGED")
    );
    for (const [route, input, code] of [
      [
        shootingProjects.createOutput,
        { projectId: id, targetParent: "D:\\output" },
        "OUTPUT_CONFLICT",
      ],
      [
        shootingProjects.addToLibrary,
        {
          projectId: id,
          source: "original",
          confirmed: true,
          inspectionToken: id,
        },
        "LIBRARY_SCOPE_CHANGED",
      ],
    ] as const) {
      try {
        await call(route as never, input as never);
        expect.fail("Expected a localizable operation failure");
      } catch (error) {
        expect(error).toMatchObject({ code, status: 400 });
        expect((error as Error).message).not.toContain(
          "Private source details"
        );
      }
    }
  });

  it("waits for file handoffs to stop before deleting project data", async () => {
    const id = "b4b7db0d-825a-460d-a4c0-c38c10f9028d";
    const events: string[] = [];
    services.stopLibrary.mockImplementation(async () => {
      await Promise.resolve();
      events.push("library stopped");
    });
    services.stopOutput.mockImplementation(async () => {
      await Promise.resolve();
      events.push("output stopped");
    });
    services.remove.mockImplementation(() => {
      events.push("deleted");
      return Promise.resolve({ deleted: true });
    });
    await expect(
      call(shootingProjects.remove, { projectId: id })
    ).resolves.toEqual({ deleted: true });
    expect(events).toEqual(["library stopped", "output stopped", "deleted"]);
    expect(services.stopLibrary).toHaveBeenCalledWith(id);
    expect(services.stopOutput).toHaveBeenCalledWith(id);
  });
});
