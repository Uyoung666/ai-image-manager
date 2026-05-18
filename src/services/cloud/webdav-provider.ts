import type { CloudProvider } from "./abstract-provider";

export const webdavProvider: CloudProvider = {
  provider: "webdav",

  async checkConnection(config) {
    const url = config.url?.replace(/\/$/, "") || "";
    if (!url) {
      return { success: false, error: "URL 未配置" };
    }

    const start = Date.now();
    try {
      const headers: Record<string, string> = { Depth: "0" };
      if (config.username || config.password) {
        const token = Buffer.from(
          `${config.username}:${config.password}`
        ).toString("base64");
        headers.Authorization = `Basic ${token}`;
      }
      const res = await fetch(url, { method: "PROPFIND", headers });
      if (res.ok || res.status === 207) {
        return { success: true, latencyMs: Date.now() - start };
      }
      return { success: false, error: `HTTP ${res.status}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },

  async upload(buffer, remotePath, contentType, config) {
    const baseUrl = config.url?.replace(/\/$/, "") || "";
    const url = `${baseUrl}/${remotePath}`;
    const authHeaders: Record<string, string> = {};
    if (config.username || config.password) {
      const token = Buffer.from(
        `${config.username}:${config.password}`
      ).toString("base64");
      authHeaders.Authorization = `Basic ${token}`;
    }

    // Ensure parent directories exist (MKCOL each segment)
    const segments = remotePath.split("/");
    segments.pop(); // remove filename, only create dirs
    let dirPath = "";
    for (const seg of segments) {
      dirPath += (dirPath ? "/" : "") + seg;
      const mkcolRes = await fetch(`${baseUrl}/${dirPath}`, {
        method: "MKCOL",
        headers: authHeaders,
      });
      // 405 = already exists, 201 = created — both are fine
      if (!mkcolRes.ok && mkcolRes.status !== 405) {
        throw new Error(`WebDAV MKCOL failed: HTTP ${mkcolRes.status}`);
      }
    }

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.byteLength),
        ...authHeaders,
      },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      throw new Error(`WebDAV upload failed: HTTP ${res.status}`);
    }
    return url;
  },

  async listFiles(prefix, config) {
    const baseUrl = config.url?.replace(/\/$/, "") || "";
    const headers: Record<string, string> = { Depth: "1" };
    if (config.username || config.password) {
      const token = Buffer.from(
        `${config.username}:${config.password}`
      ).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }

    const res = await fetch(`${baseUrl}/${prefix}`, {
      method: "PROPFIND",
      headers,
    });
    if (!res.ok) {
      return [];
    }
    const xml = await res.text();

    // Parse XML response for href elements
    const hrefs: string[] = [];
    const hrefRegex = /<d:href>([^<]+)<\/d:href>/g;
    let match;
    while ((match = hrefRegex.exec(xml)) !== null) {
      hrefs.push(decodeURIComponent(match[1]));
    }
    return hrefs;
  },
};
