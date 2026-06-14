import crypto from "node:crypto";
import type { CloudProvider } from "./abstract-provider";

function getDate() {
  return new Date().toUTCString();
}

function hmacSha1(key: string, data: string): string {
  return crypto.createHmac("sha1", key).update(data, "utf-8").digest("base64");
}

/** OSS native Signature V1 */
function ossSign(
  method: string,
  contentType: string,
  date: string,
  resource: string,
  secretKey: string
): string {
  // VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + CanonicalizedResource
  const stringToSign =
    method + "\n\n" + contentType + "\n" + date + "\n" + resource;
  return hmacSha1(secretKey, stringToSign);
}

function isOss(endpoint: string) {
  return endpoint.includes("aliyuncs.com") && !endpoint.includes("s3.oss-");
}

/**
 * Build URL and canonicalized resource.
 * Alibaba OSS requires virtual-hosted style URL: https://{bucket}.{host}/{path}
 * BUT the CanonicalizedResource always includes /{bucket}/ regardless of URL style.
 * Others use path-style for both URL and resource.
 */
function buildRequest(
  endpoint: string,
  bucket: string,
  objectPath?: string,
  query?: string
) {
  const host = endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  // CanonicalizedResource ALWAYS starts with /{bucket} for OSS
  const ossResource = objectPath
    ? `/${bucket}/${objectPath}` + (query ? `?${query}` : "")
    : `/${bucket}/` + (query ? `?${query}` : "");

  if (isOss(endpoint)) {
    const base = `https://${bucket}.${host}`;
    const path = objectPath ?? "";
    const url = query ? `${base}/${path}?${query}` : `${base}/${path}`;
    return { url, resource: ossResource };
  }

  const base = `https://${host}`;
  const path = objectPath ? `/${bucket}/${objectPath}` : `/${bucket}`;
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  return { url, resource: ossResource };
}

export const s3Provider: CloudProvider = {
  provider: "s3",

  async checkConnection(config) {
    const { endpoint, accessKey, secretKey, bucket } = config;
    if (!(endpoint && accessKey && secretKey && bucket)) {
      return {
        success: false,
        error: "S3 配置不完整（需要 endpoint/accessKey/secretKey/bucket）",
      };
    }

    const start = Date.now();
    try {
      const { url, resource } = buildRequest(endpoint, bucket);
      const date = getDate();
      const authPfx = isOss(endpoint) ? "OSS" : "AWS";
      const signature = ossSign("GET", "", date, resource, secretKey);

      const res = await fetch(url, {
        method: "GET",
        headers: {
          Date: date,
          Authorization: `${authPfx} ${accessKey}:${signature}`,
        },
      });
      if (res.ok) {
        return { success: true, latencyMs: Date.now() - start };
      }
      let errBody = "";
      try {
        errBody = await res.text();
      } catch {
        /* ignore */
      }
      return {
        success: false,
        error: `HTTP ${res.status}: ${errBody.slice(0, 200)}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },

  async upload(buffer, remotePath, contentType, config) {
    const { endpoint, accessKey, secretKey, bucket } = config;
    if (!(endpoint && accessKey && secretKey && bucket)) {
      throw new Error("S3 配置不完整");
    }

    const { url, resource } = buildRequest(endpoint, bucket, remotePath);
    const date = getDate();
    const authPfx = isOss(endpoint) ? "OSS" : "AWS";
    const signature = ossSign("PUT", contentType, date, resource, secretKey);

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        "Content-Length": String(buffer.byteLength),
        Date: date,
        Authorization: `${authPfx} ${accessKey}:${signature}`,
      },
      body: new Uint8Array(buffer),
    });

    if (!res.ok) {
      throw new Error(`S3 upload failed: HTTP ${res.status}`);
    }

    if (isOss(endpoint)) {
      const publicBase = config.publicBase?.replace(/\/$/, "");
      if (publicBase) {
        return `${publicBase}/${remotePath}`;
      }
      const host = endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return `https://${bucket}.${host}/${remotePath}`;
    }
    const baseUrl = endpoint.replace(/\/$/, "");
    return `${baseUrl}/${bucket}/${remotePath}`;
  },

  async listFiles(prefix, config) {
    const { endpoint, accessKey, secretKey, bucket } = config;
    if (!(endpoint && accessKey && secretKey && bucket)) {
      return [];
    }

    const { url, resource } = buildRequest(
      endpoint,
      bucket,
      undefined,
      `prefix=${encodeURIComponent(prefix)}`
    );
    const date = getDate();
    const authPfx = isOss(endpoint) ? "OSS" : "AWS";
    const signature = ossSign("GET", "", date, resource, secretKey);

    const res = await fetch(url, {
      headers: {
        Date: date,
        Authorization: `${authPfx} ${accessKey}:${signature}`,
      },
    });

    if (!res.ok) {
      return [];
    }
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
