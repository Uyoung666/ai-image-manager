import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const CERTIFICATE_THUMBPRINT = /^[A-F0-9]{40}$/i;
const BYTE_RANGE = /^bytes=\d+-$/;

const execute = promisify(execFile);
const hosts = new Set(["github.com", "api.github.com"]);
const repository = "/Uyoung666/ai-image-manager";
export function selectProductRequest(host, url, manifest) {
  if (!hosts.has(host)) {
    return null;
  }
  const parsed = new URL(url, `https://${host}`);
  if (
    host === "api.github.com" &&
    parsed.pathname === `/repos${repository}/releases`
  ) {
    return {
      json: [
        {
          tag_name: manifest.tag,
          body: "Isolated product upgrade verification",
        },
      ],
    };
  }
  const base = `${repository}/releases/download/${manifest.tag}/`;
  if (host !== "github.com" || !parsed.pathname.startsWith(base)) {
    return null;
  }
  const name = decodeURIComponent(parsed.pathname.slice(base.length));
  if (name === "update-manifest.json") {
    return { json: manifest };
  }
  const info = Object.values(manifest.packages).find(
    (entry) => entry.filename === name
  );
  return info ? { info } : null;
}
export function certificatePowerShellScript(script) {
  // -NoProfile sessions do not reliably auto-load the Certificate provider.
  // Use this PowerShell installation's module even when pwsh supplied PSModulePath.
  return `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop; $null=Get-PSDrive -Name Cert -PSProvider Certificate -ErrorAction Stop; ${script}`;
}

async function certificateStep(stage, operation) {
  console.log(`[product-update-proxy] certificate: ${stage}`);
  try {
    return await operation();
  } catch (error) {
    const detail = error.killed
      ? "timed out after 30000ms"
      : error.stderr?.trim() || `exit code ${error.code ?? "unknown"}`;
    throw new Error(`Product test certificate ${stage} failed: ${detail}`);
  }
}

function powershell(script, stage) {
  return certificateStep(stage, () =>
    execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(certificatePowerShellScript(script), "utf16le").toString(
          "base64"
        ),
      ],
      { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }
    )
  );
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

export function isDisposableWindowsRunner(platform, environment) {
  return (
    platform === "win32" &&
    environment.GITHUB_ACTIONS === "true" &&
    environment.RUNNER_ENVIRONMENT === "github-hosted"
  );
}

async function serveProductPackage(request, response, info, file) {
  if (!file || (await fsp.stat(file)).size !== info.size) {
    throw new Error("Missing verified test package");
  }
  const range = request.headers.range;
  if (range && !BYTE_RANGE.test(range)) {
    response.writeHead(416).end();
    return;
  }
  const offset = range ? Number(range.slice(6, -1)) : 0;
  if (offset >= info.size) {
    response.writeHead(416).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    "content-length": info.size - offset,
    ...(range
      ? {
          "content-range": `bytes ${offset}-${info.size - 1}/${info.size}`,
        }
      : {}),
  });
  const stream = fs.createReadStream(file, { start: offset });
  response.on("close", () => stream.destroy());
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

/** Trust exists only on the disposable hosted CI machine; TLS checks stay enabled. */
export async function createProductUpdateProxy(
  directory,
  manifest,
  packageFiles
) {
  if (!isDisposableWindowsRunner(process.platform, process.env)) {
    throw new Error(
      "Product HTTPS proxy requires a disposable Windows Actions runner"
    );
  }
  await fsp.mkdir(directory, { recursive: true });
  const password = randomBytes(24).toString("hex");
  const pfxFile = path.join(directory, "isolated-updater.pfx");
  const certificateFile = path.join(directory, "isolated-updater.cer");
  let thumbprint;
  let proxy;
  let origin;
  const connections = new Set();
  const trace = [];
  let activated = false;
  const close = async () => {
    for (const connection of connections) {
      connection.destroy();
    }
    await Promise.all(
      [proxy, origin]
        .filter(Boolean)
        .map((server) => new Promise((resolve) => server.close(resolve)))
    );
    if (thumbprint) {
      await powershell(
        `$root='Cert:\\LocalMachine\\Root\\${thumbprint}'; if(Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Force }; $personal='Cert:\\CurrentUser\\My\\${thumbprint}'; if(Test-Path -LiteralPath $personal) { Remove-Item -LiteralPath $personal -DeleteKey -Force }`,
        "remove temporary trust and key"
      );
    }
  };
  try {
    const result = await powershell(
      `$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=[Security.Principal.WindowsPrincipal]::new($identity); if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated disposable hosted runner is required' }; $cert=New-SelfSignedCertificate -DnsName 'github.com','api.github.com' -CertStoreLocation Cert:\\CurrentUser\\My -Provider 'Microsoft Software Key Storage Provider' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1); $cert.Thumbprint`,
      "create software certificate"
    );
    const createdThumbprint = result.stdout.trim();
    if (!CERTIFICATE_THUMBPRINT.test(createdThumbprint)) {
      throw new Error("Invalid test certificate identity");
    }
    thumbprint = createdThumbprint;
    await powershell(
      `$cert=Get-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${thumbprint}'; [IO.File]::WriteAllBytes(${quote(pfxFile)},$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,${quote(password)})); [IO.File]::WriteAllBytes(${quote(certificateFile)},$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))`,
      "export temporary certificate"
    );
    // CurrentUser Root can display a confirmation dialog even in a -NonInteractive shell.
    // The hosted machine is discarded after the job; import only the public certificate.
    await certificateStep("install hosted-machine trust", () =>
      execute(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "certutil.exe"
        ),
        ["-f", "-addstore", "Root", certificateFile],
        { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }
      )
    );
    origin = https.createServer(
      { pfx: await fsp.readFile(pfxFile), passphrase: password },
      async (request, response) => {
        try {
          const selected = selectProductRequest(
            request.headers.host,
            request.url,
            manifest
          );
          trace.push({
            host: request.headers.host,
            url: request.url,
            range: request.headers.range,
          });
          if (!selected) {
            response.writeHead(404).end();
            return;
          }
          if (!activated && request.headers.host === "api.github.com") {
            response.setHeader("content-type", "application/json");
            response.end("[]");
            return;
          }
          if (selected.json) {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(selected.json));
            return;
          }
          await serveProductPackage(
            request,
            response,
            selected.info,
            packageFiles[selected.info.filename]
          );
        } catch {
          response.writeHead(500).end();
        }
      }
    );
    const track = (socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
    };
    origin.on("connection", track);
    await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
    proxy = http.createServer((_request, response) =>
      response.writeHead(403).end()
    );
    proxy.on("connection", track);
    proxy.on("connect", (request, client, head) => {
      if (
        !(hosts.has(request.url.split(":")[0]) && request.url.endsWith(":443"))
      ) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = net.connect(origin.address().port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) {
          upstream.write(head);
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      track(upstream);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${proxy.address().port}`,
      trace,
      close,
      activate: () => {
        activated = true;
      },
    };
  } catch (error) {
    await close().catch((cleanupError) => {
      console.error(
        `[product-update-proxy] certificate cleanup failed: ${cleanupError.message}`
      );
    });
    throw error;
  }
}
