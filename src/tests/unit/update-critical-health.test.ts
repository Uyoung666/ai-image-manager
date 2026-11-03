// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registry, ServiceLevel } from "@/services/registry";

vi.mock("@/db", () => ({ getDatabase: () => ({ run: vi.fn() }) }));
vi.mock("@/services/http-server", () => ({ isHttpServerRunning: () => true }));

it("does not await degradable service health when confirming a new version", async () => {
  const optionalHealth = vi.fn(() => new Promise<never>(() => undefined));
  registry.register({
    name: "update-confirmation-optional",
    level: ServiceLevel.Optional,
    health: optionalHealth,
    start: vi.fn(),
    stop: vi.fn(),
  });
  const report = await registry.health(ServiceLevel.Critical);
  expect(report.services.filter((service) => service.status !== "ok")).toEqual(
    []
  );
  expect(report.services.length).toBeGreaterThan(0);
  expect(
    report.services.every((service) => service.level === ServiceLevel.Critical)
  ).toBe(true);
  expect(optionalHealth).not.toHaveBeenCalled();
});
