import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_DIR = 'D:/8806/ai-image-manager测试用例';
const TOTAL = 500;
const CONCURRENCY = 15;

// 多样化尺寸模拟真实场景
const SIZES = [
  [800, 600], [1200, 800], [600, 900], [1024, 768],
  [1920, 1080], [640, 480], [1600, 900], [900, 1200],
  [1280, 720], [800, 1200], [1500, 1000], [1080, 1350],
  [720, 1280], [1000, 750], [1400, 1050],
];

function downloadOne(id, size) {
  return new Promise((resolve, reject) => {
    const [w, h] = size;
    const url = `https://picsum.photos/id/${id}/${w}/${h}`;
    const file = path.join(TARGET_DIR, `test-image-${String(id).padStart(4, '0')}.jpg`);

    if (fs.existsSync(file)) {
      resolve({ id, status: 'skipped' });
      return;
    }

    const req = https.get(url, { timeout: 30000 }, (res) => {
      // Picsum redirects to the actual image
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, { timeout: 30000 }, (imgRes) => {
          const chunks = [];
          imgRes.on('data', (c) => chunks.push(c));
          imgRes.on('end', () => {
            fs.writeFileSync(file, Buffer.concat(chunks));
            resolve({ id, status: 'ok' });
          });
          imgRes.on('error', reject);
        }).on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(file, Buffer.concat(chunks));
        resolve({ id, status: 'ok' });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  // 使用 ID 0-499（Picsum 大约有 1000+ 张图片），超出范围则用随机 ID
  const ids = Array.from({ length: TOTAL }, (_, i) => i);
  const tasks = ids.map((id, idx) => ({
    id,
    size: SIZES[idx % SIZES.length],
  }));

  let completed = 0;
  let failed = 0;

  // 分批并发执行
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((t) => downloadOne(t.id, t.size))
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.status === 'ok') completed++;
        else completed++;
      } else {
        failed++;
      }
    }

    const pct = Math.round((i + batch.length) / TOTAL * 100);
    process.stdout.write(`\r进度: ${pct}% (${Math.min(i + batch.length, TOTAL)}/${TOTAL}) 成功: ${completed} 失败: ${failed}`);
  }

  console.log(`\n\n完成! 共 ${completed} 张图片下载到: ${TARGET_DIR}`);
}

main().catch((e) => {
  console.error('下载脚本出错:', e);
  process.exit(1);
});
