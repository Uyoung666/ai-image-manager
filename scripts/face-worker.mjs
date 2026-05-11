/**
 * Face detection worker.
 *
 * Runs as a child process via fork(). Uses sharp for image preprocessing
 * and basic face region detection (skin-color heuristics + geometric filtering).
 *
 * IPC Protocol:
 *   Parent sends: { type: "detect", photos: [{ id, path }, ...] }
 *   Worker sends: { type: "result", results: [{ id, faces: [{ bbox: {x,y,width,height} }] }] }
 *   Then worker exits with code 0.
 *
 * Future: swap in ONNX face detection model (e.g., UltraFace) for better accuracy.
 */

import path from "node:path";
import sharp from "sharp";

// --- Skin color range in RGB ---
// Approximate range for common skin tones
const SKIN_R_MIN = 80;
const SKIN_R_MAX = 255;
const SKIN_G_MIN = 40;
const SKIN_G_MAX = 220;
const SKIN_B_MIN = 20;
const SKIN_B_MAX = 180;

function isSkinPixel(r, g, b) {
  return (
    r >= SKIN_R_MIN && r <= SKIN_R_MAX &&
    g >= SKIN_G_MIN && g <= SKIN_G_MAX &&
    b >= SKIN_B_MIN && b <= SKIN_B_MAX &&
    r > g && r > b
  );
}

/**
 * Scan a downsampled image for skin-colored regions, then compute geometric
 * bounding boxes of likely face candidates.
 */
async function detectFaces(filePath) {
  const SCALE = 4; // downscale factor for speed
  const targetW = 320; // analyze at ~320px wide

  try {
    const meta = await sharp(filePath, { failOn: "none" }).metadata();
    const imgW = meta.width || 0;
    const imgH = meta.height || 0;
    if (imgW < 64 || imgH < 64) return [];

    const analyzeW = Math.min(targetW, Math.floor(imgW / SCALE));
    const analyzeH = Math.floor(analyzeW * (imgH / imgW));

    const { data, info } = await sharp(filePath, { failOn: "none" })
      .resize(analyzeW, analyzeH, { fit: "inside" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    // Build skin mask
    const skinMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 3;
        if (isSkinPixel(rgb[idx], rgb[idx + 1], rgb[idx + 2])) {
          skinMask[y * width + x] = 1;
        }
      }
    }

    // Find connected skin regions via simple flood-fill scan
    const visited = new Uint8Array(width * height);
    const regions = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!skinMask[idx] || visited[idx]) continue;

        // BFS to find connected region
        const stack = [[x, y]];
        let minX = x, maxX = x, minY = y, maxY = y, count = 0;

        while (stack.length > 0 && count < 5000) {
          const [cx, cy] = stack.pop();
          const ci = cy * width + cx;
          if (
            cx < 0 || cx >= width || cy < 0 || cy >= height ||
            !skinMask[ci] || visited[ci]
          ) continue;

          visited[ci] = 1;
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          stack.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]);
        }

        const rw = maxX - minX + 1;
        const rh = maxY - minY + 1;
        const aspectRatio = rw / Math.max(rh, 1);

        // Face-like region: reasonable size and aspect ratio
        if (count >= 20 && rw >= 5 && rh >= 5 && aspectRatio >= 0.3 && aspectRatio <= 3.0) {
          regions.push({ minX, minY, maxX, maxY, count, aspectRatio });
        }
      }
    }

    // Scale back to original image coordinates
    const scaleX = imgW / width;
    const scaleY = imgH / height;

    // Filter: keep only regions that are face-like (roughly round/square aspect ratio)
    // Merge nearby regions that might be parts of the same face
    const faceCandidates = regions
      .filter((r) => r.aspectRatio >= 0.5 && r.aspectRatio <= 2.0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // max 20 faces

    // Merge overlapping regions
    const merged = [];
    const used = new Set();
    for (let i = 0; i < faceCandidates.length; i++) {
      if (used.has(i)) continue;
      let merged_r = faceCandidates[i];
      for (let j = i + 1; j < faceCandidates.length; j++) {
        if (used.has(j)) continue;
        const a = merged_r;
        const b = faceCandidates[j];
        const overlapX = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
        const overlapY = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
        const areaA = (a.maxX - a.minX) * (a.maxY - a.minY);
        const areaB = (b.maxX - b.minX) * (b.maxY - b.minY);
        const overlap = (overlapX * overlapY) / Math.min(areaA, areaB);
        if (overlap > 0.3) {
          merged_r = {
            minX: Math.min(merged_r.minX, b.minX),
            minY: Math.min(merged_r.minY, b.minY),
            maxX: Math.max(merged_r.maxX, b.maxX),
            maxY: Math.max(merged_r.maxY, b.maxY),
            count: merged_r.count + b.count,
            aspectRatio: merged_r.aspectRatio,
          };
          used.add(j);
        }
      }
      merged.push(merged_r);
      used.add(i);
    }

    return merged
      .filter((r) => {
        const rw = r.maxX - r.minX;
        const rh = r.maxY - r.minY;
        // Must be at least 2% of image size
        return rw > imgW * 0.02 && rh > imgH * 0.02;
      })
      .map((r, idx) => ({
        faceIndex: idx,
        bbox: {
          x: Math.round(r.minX * scaleX),
          y: Math.round(r.minY * scaleY),
          width: Math.round((r.maxX - r.minX) * scaleX),
          height: Math.round((r.maxY - r.minY) * scaleY),
        },
      }));
  } catch (err) {
    console.error(`[FaceWorker] Error processing ${path.basename(filePath)}: ${err.message}`);
    return [];
  }
}

// --- Wait for parent message ---
process.on("message", async (msg) => {
  if (msg.type !== "detect") {
    process.exit(1);
  }

  const { photos } = msg;
  if (!photos?.length) {
    process.send?.({ type: "result", results: [] });
    process.exit(0);
  }

  console.error(`[FaceWorker] Detecting faces in ${photos.length} photos`);

  const results = [];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    try {
      const faces = await detectFaces(photo.path);
      results.push({ id: photo.id, faces });
      if (faces.length > 0) {
        console.error(
          `[FaceWorker] ${i + 1}/${photos.length}: ${path.basename(photo.path)} — ${faces.length} face(s)`
        );
      }
    } catch (err) {
      console.error(
        `[FaceWorker] ${i + 1}/${photos.length} FAIL: ${photo.path} — ${err.message}`
      );
      results.push({ id: photo.id, faces: [] });
    }
  }

  const totalFaces = results.reduce((s, r) => s + r.faces.length, 0);
  console.error(
    `[FaceWorker] Done: ${totalFaces} faces found in ${results.length} photos`
  );

  process.send?.({ type: "result", results });
  process.exit(0);
});
