// Diagnose which images failed to index and why
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const TEST_DIR = "D:/8806/ai-image-manager测试用例";
const files = fs.readdirSync(TEST_DIR).filter((f) => /\.jpe?g$/i.test(f));

console.log(`Total image files: ${files.length}`);

const failures = [];
for (const f of files) {
  const fp = path.join(TEST_DIR, f);
  const stat = fs.statSync(fp);

  try {
    const meta = await sharp(fp).metadata();
    if (!(meta.width && meta.height && meta.format)) {
      failures.push({
        file: f,
        size: stat.size,
        reason: `Incomplete metadata: ${JSON.stringify(meta)}`,
      });
    }
  } catch (err) {
    failures.push({
      file: f,
      size: stat.size,
      reason: err.message?.slice(0, 100),
    });
  }
}

console.log(`Successfully readable: ${files.length - failures.length}`);
console.log(`Failed: ${failures.length}`);

if (failures.length > 0) {
  console.log("\nFailed files:");
  for (const f of failures) {
    console.log(`  ${f.file} (${(f.size / 1024).toFixed(1)}KB): ${f.reason}`);
  }
}

// Also show file size distribution
const sizes = files.map((f) => fs.statSync(path.join(TEST_DIR, f)).size);
sizes.sort((a, b) => a - b);
console.log(
  `\nFile size range: ${sizes[0]} - ${sizes[sizes.length - 1]} bytes`
);
console.log(`Files < 1KB: ${sizes.filter((s) => s < 1024).length}`);
console.log(
  `Files 1KB-100KB: ${sizes.filter((s) => s >= 1024 && s < 102_400).length}`
);
console.log(
  `Files 100KB-1MB: ${sizes.filter((s) => s >= 102_400 && s < 1_048_576).length}`
);
console.log(`Files > 1MB: ${sizes.filter((s) => s >= 1_048_576).length}`);
