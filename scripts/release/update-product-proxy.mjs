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
function powershell(script) {
  return execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }
  );
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

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

/** Trust exists only in the disposable CI account; no TLS bypass flags enter the app. */
export async function createProductUpdateProxy(
  directory,
  manifest,
  packageFiles
) {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error(
      "Product HTTPS proxy requires a disposable Windows Actions runner"
    );
  }
  await fsp.mkdir(directory, { recursive: true });
  const password = randomBytes(24).toString("hex");
  const pfxFile = path.join(directory, "isolated-updater.pfx");
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
        `$ErrorActionPreference='Stop'; foreach($store in @('My','Root')) { $target="Cert:\\CurrentUser\\$store\\${thumbprint}"; if(Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target } }`
      );
    }
  };
  try {
    const result = await powershell(
      `$ErrorActionPreference='Stop'; $cert=New-SelfSignedCertificate -DnsName 'github.com','api.github.com' -CertStoreLocation Cert:\\CurrentUser\\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddDays(1); [IO.File]::WriteAllBytes(${quote(pfxFile)},$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,${quote(password)})); $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser'); $store.Open('ReadWrite'); try {$store.Add($cert)} finally {$store.Close()}; $cert.Thumbprint`
    );
    thumbprint = result.stdout.trim();
    if (!CERTIFICATE_THUMBPRINT.test(thumbprint)) {
      throw new Error("Invalid test certificate identity");
    }
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
    await close();
    throw error;
  }
}
