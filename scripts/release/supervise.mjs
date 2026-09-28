import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A separate process is intentional: rejecting a Promise does not terminate
// stuck SDK sockets, native installers, or their child processes.
export function supervise(
  command,
  args,
  {
    timeoutMs = 20 * 60_000,
    idleMs = 120_000,
    env = process.env,
    spawnProcess = spawn,
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let failure;
    let idleTimer;
    let killTimer;
    let graceTimer;
    const terminate = (message) => {
      if (failure) {
        return;
      }
      failure = new Error(message);
      console.error(message);
      if (child.connected) {
        child.send({ type: "release-abort", reason: message }, () => {
          /* The kill deadline also covers IPC failure. */
        });
      }
      // Give the SDK time to destroy its stream and attempt multipartAbort.
      graceTimer = setTimeout(() => {
        if (process.platform === "win32") {
          const killer = spawnProcess(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" }
          );
          killer.on("error", () => child.kill());
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill();
          }
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(
              process.platform === "win32" ? child.pid : -child.pid,
              "SIGKILL"
            );
          } catch {
            /* already exited */
          }
        }, 5000);
      }, 5000);
    };
    const totalTimer = setTimeout(
      () => terminate(`Release command exceeded ${timeoutMs}ms`),
      timeoutMs
    );
    const progress = (destination, chunk) => {
      destination.write(chunk);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => terminate(`Release command made no progress for ${idleMs}ms`),
        idleMs
      );
    };
    idleTimer = setTimeout(
      () => terminate(`Release command made no progress for ${idleMs}ms`),
      idleMs
    );
    child.stdout.on("data", (chunk) => progress(process.stdout, chunk));
    child.stderr.on("data", (chunk) => progress(process.stderr, chunk));
    const cleanup = () => {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (failure || code !== 0) {
        reject(failure ?? new Error(`Release command exited with ${code}`));
      } else {
        resolve();
      }
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  supervise(process.execPath, process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
