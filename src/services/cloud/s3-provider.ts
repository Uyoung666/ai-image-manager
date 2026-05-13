import type { CloudProvider } from "./abstract-provider";

export const s3Provider: CloudProvider = {
  provider: "s3",

  async checkConnection(config) {
    const { endpoint, accessKey, secretKey, bucket, region } = config;
    if (!endpoint || !accessKey || !secretKey || !bucket) {
      return { success: false, error: "S3 配置不完整（需要 endpoint/accessKey/secretKey/bucket）" };
    }

    const start = Date.now();
    try {
      const url = `${endpoint.replace(/\/$/, "")}/${bucket}?location`;
      const date = new Date().toUTCString();
      const res = await fetch(url, {
        headers: {
          Authorization: `AWS ${accessKey}:${secretKey}`,
          "x-amz-date": date,
        },
      });
      return { success: res.ok, latencyMs: Date.now() - start, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },

  async upload(buffer, remotePath, contentType, config) {
    const { endpoint, accessKey, secretKey, bucket } = config;
    if (!endpoint || !accessKey || !secretKey || !bucket) {
      throw new Error("S3 配置不完整");
    }

    const url = `${endpoint.replace(/\/$/, "")}/${bucket}/${remotePath}`;
    const date = new Date().toUTCString();

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
        "x-amz-date": date,
        Authorization: `AWS ${accessKey}:${secretKey}`,
      },
      body: new Uint8Array(buffer),
    });

    if (!res.ok) {
      throw new Error(`S3 upload failed: HTTP ${res.status}`);
    }
    return url;
  },

  async listFiles(prefix, config) {
    const { endpoint, accessKey, secretKey, bucket } = config;
    if (!endpoint || !accessKey || !secretKey || !bucket) return [];

    const url = `${endpoint.replace(/\/$/, "")}/${bucket}?prefix=${encodeURIComponent(prefix)}`;
    const date = new Date().toUTCString();

    const res = await fetch(url, {
      headers: {
        "x-amz-date": date,
        Authorization: `AWS ${accessKey}:${secretKey}`,
      },
    });

    if (!res.ok) return [];
    const xml = await res.text();

    const keys: string[] = [];
    const keyRegex = /<Key>([^<]+)<\/Key>/g;
    let match;
    while ((match = keyRegex.exec(xml)) !== null) {
      keys.push(match[1]);
    }
    return keys;
  },
};
