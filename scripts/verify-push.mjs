import fs from "node:fs";
import path from "node:path";
import { TestRuntime } from "../src/tests/helpers/test-runtime.ts";
import { resolveLocaleBaseline, run } from "./ci-verify.mjs";

async function verifyPush() {
  if (process.platform !== "win32" || !process.version.startsWith("v22.")) {
    throw new Error("Push verification requires Windows and Node 22");
  }
  const root = path.resolve(import.meta.dirname, "..");
  const commit = run("git", ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  });
  const changes = run("git", ["status", "--porcelain"], {
    cwd: root,
    capture: true,
  });
  if (changes) {
    throw new Error(
      "Commit the changes to verify before running npm run verify:push"
    );
  }
  const baseline = await resolveLocaleBaseline();
  console.log(
    `Verifying ${commit} with Node ${process.version}, locale baseline ${baseline}`
  );
  const runtime = new TestRuntime(
    "verify-push",
    path.join(root, ".test-runtime")
  );
  const cwd = path.join(runtime.root, "repo");
  const env = { ...process.env, CI: "true", LOCALE_BASELINE_REF: baseline };
  const verify = (group, overrides) =>
    run(process.execPath, [path.join(cwd, "scripts/ci-verify.mjs"), group], {
      cwd,
      env: { ...env, ...overrides },
    });

  try {
    run("git", [
      "-c",
      "core.autocrlf=false",
      "clone",
      "--shared",
      "--no-checkout",
      root,
      cwd,
    ]);
    run("git", ["-c", "core.autocrlf=false", "checkout", "--detach", commit], {
      cwd,
    });
    const models = path.join(root, "models");
    if (fs.existsSync(models)) {
      fs.cpSync(models, path.join(cwd, "models"), { recursive: true });
    }
    verify("install-check");
    verify("static");
    verify("locale");
    verify("install-runtime");
    verify("unit", { AIM_MODEL_SCOPE: "face,Xenova/siglip-base-patch16-224" });
    verify("face");
    verify("e2e", { AIM_MODEL_SCOPE: "" });
  } catch (error) {
    runtime.retain();
    console.error(`Verification evidence: ${runtime.root}`);
    throw error;
  }
  try {
    const cleanup = runtime.cleanup();
    if (cleanup.status !== "deleted") {
      console.warn(
        `Verification directory retained: ${cleanup.root} (${cleanup.reason})`
      );
    }
  } catch (error) {
    console.warn(
      `Verification directory retained: ${runtime.root} (${error.message})`
    );
  }
  console.log(`Push verification passed for ${commit}`);
}

try {
  await verifyPush();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
