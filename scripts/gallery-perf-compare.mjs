import fs from "node:fs";
import path from "node:path";

const firstMetric = process.argv[5] ?? "firstViewport80Ms";
const densityComparison = process.argv[6] === "density";
const stopMetric = process.argv[7] ?? "scrollStop95Ms";
if (!["scrollStop95Ms", "scriptedScrollStop95Ms"].includes(stopMetric)) {
  throw new Error(`Unsupported scroll-stop metric: ${stopMetric}`);
}
if (!["firstViewport80Ms", "entryFirstViewport80Ms"].includes(firstMetric)) {
  throw new Error(`Unsupported first-viewport metric: ${firstMetric}`);
}

const quantile = (values, ratio) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
    : null;
};
function assertFinalViewport(run, file) {
  if (
    run.scrollProtocol?.endsWith("absolute-final-stop-v2") &&
    run.pattern === "scroll" &&
    !(
      Number.isFinite(run.scrollPosition?.top) &&
      Number.isFinite(run.scrollPosition?.target) &&
      Math.abs(run.scrollPosition.top - run.scrollPosition.target) <= 2
    )
  ) {
    throw new Error(`Final viewport missed its fixed scroll target: ${file}`);
  }
}

function read(file) {
  const input = JSON.parse(fs.readFileSync(file, "utf8"));
  const runs = input.results ?? [input];
  if (runs.length < 5) {
    throw new Error(
      "A major comparison requires at least five valid runs per build"
    );
  }
  if (new Set(runs.map((run) => run.bundleHash)).size !== 1) {
    throw new Error("A comparison group contains different compiled builds");
  }
  for (const run of runs) {
    assertFinalViewport(run, file);
    if (run.cpuProfiling) {
      throw new Error(
        "CPU diagnostic recordings cannot be used for acceptance comparisons"
      );
    }
    if (
      !(
        run.datasetCount > 0 &&
        run.loaded > 0 &&
        run.galleryPerf?.[firstMetric]?.count > 0 &&
        run.galleryPerf?.[stopMetric]?.count > 0 &&
        run.galleryPerf?.frameIntervalMs?.count > 0 &&
        run.galleryPerf[firstMetric].total > 0 &&
        run.galleryPerf[stopMetric].total > 0 &&
        run.galleryPerf.frameIntervalMs.total > 0
      )
    ) {
      throw new Error(`Invalid gallery sample: ${file}`);
    }
  }
  const max = (key) => {
    const values = runs.flatMap((run) =>
      run.galleryPerf[key] ? run.galleryPerf[key].max : []
    );
    return values.length ? Math.max(...values) : null;
  };
  const first = runs.map((run) => run.galleryPerf[firstMetric].max);
  const stop = runs.map((run) => run.galleryPerf[stopMetric].max);
  return {
    file: path.resolve(file),
    runs: runs.length,
    datasetCount: runs[0].datasetCount,
    gridColumnWidth: runs[0].gridColumnWidth ?? 220,
    fixtureEdge: runs[0].fixtureEdge ?? 0,
    variantCache: runs[0].variantCache ?? "retain",
    viewport: runs[0].viewport,
    cache: runs[0].cache,
    view: runs[0].view,
    albumKind: runs[0].albumKind ?? "ordinary",
    durationSeconds: runs[0].durationSeconds ?? null,
    scrollProtocol: runs[0].scrollProtocol ?? "time-budget-v1",
    finalScrollTarget: runs[0].scrollPosition?.target ?? null,
    pattern: runs[0].pattern,
    bundleHash: runs[0].bundleHash,
    buildKind: runs[0].buildKind ?? "production-bundle",
    profiling: Boolean(runs[0].profiling),
    entryDefinition: runs[0].entryDefinition ?? null,
    sourceCommit: runs[0].sourceCommit,
    buildManifest: runs[0].buildManifest,
    cpu: runs[0].runtime.cpu,
    firstMedianMs: quantile(first, 0.5),
    firstP95Ms: quantile(first, 0.95),
    stopMedianMs: quantile(stop, 0.5),
    stopP95Ms: quantile(stop, 0.95),
    first,
    stop,
    frameP95Ms: quantile(
      runs.flatMap((run) => run.galleryPerf.frameIntervalMs.samples ?? []),
      0.95
    ),
    pages: max("galleryResidentPages"),
    photos: max("galleryResidentPhotos"),
    bytes: max("galleryResidentPhotoBytes"),
    images: max("imageActive"),
    prefetch: max("imagePrefetchActive"),
    sqlMaxMs: max("gallerySqlMs"),
  };
}
const [beforeFile, afterFile, output = "reports/gallery-comparison"] =
  process.argv.slice(2);
if (!(beforeFile && afterFile)) {
  throw new Error(
    "Usage: node scripts/gallery-perf-compare.mjs baseline-summary optimized-summary [output-prefix]"
  );
}
const baseline = read(beforeFile);
const optimized = read(afterFile);
if (
  firstMetric === "entryFirstViewport80Ms" &&
  (!baseline.entryDefinition ||
    baseline.entryDefinition !== optimized.entryDefinition)
) {
  throw new Error("Gallery entry definitions differ or are missing");
}
for (const key of [
  "datasetCount",
  "gridColumnWidth",
  "fixtureEdge",
  "variantCache",
  "viewport",
  "cache",
  "view",
  "albumKind",
  "durationSeconds",
  "scrollProtocol",
  "finalScrollTarget",
  "pattern",
  "cpu",
  "buildKind",
  "profiling",
]) {
  if (JSON.stringify(baseline[key]) !== JSON.stringify(optimized[key])) {
    throw new Error(`Comparison conditions differ: ${key}`);
  }
}
const change = (key) => (optimized[key] / baseline[key] - 1) * 100;
const result = {
  firstMetric,
  stopMetric,
  generatedAt: new Date().toISOString(),
  baseline,
  optimized,
  changePercent: {
    firstMedian: change("firstMedianMs"),
    firstP95: change("firstP95Ms"),
    stopMedian: change("stopMedianMs"),
    stopP95: change("stopP95Ms"),
  },
  targets: {
    smallGalleryRegression:
      baseline.datasetCount <= 1000 || densityComparison
        ? [
            "firstMedianMs",
            "firstP95Ms",
            "stopMedianMs",
            "stopP95Ms",
            "frameP95Ms",
          ].every(
            (key) =>
              optimized[key] <=
              baseline[key] + Math.max(20, baseline[key] * 0.1)
          )
        : null,
    first:
      baseline.datasetCount > 1000 &&
      (!densityComparison || baseline.gridColumnWidth === 140)
        ? optimized.firstMedianMs <=
          baseline.firstMedianMs * (densityComparison ? 0.9 : 0.8)
        : null,
    stop:
      baseline.datasetCount > 1000 &&
      (!densityComparison || baseline.gridColumnWidth === 140)
        ? optimized.stopP95Ms <=
          baseline.stopP95Ms * (densityComparison ? 0.8 : 0.7)
        : null,
  },
  budgets: {
    pages: optimized.pages !== null && optimized.pages <= 20,
    records: optimized.photos !== null && optimized.photos <= 2000,
    bytes: optimized.bytes !== null && optimized.bytes <= 16 * 1024 * 1024,
    images: optimized.images !== null && optimized.images <= 6,
    prefetch: optimized.prefetch !== null && optimized.prefetch <= 2,
  },
};
const f = (value) => (value === null ? "未采集" : value.toFixed(1));
const targetLabel = (value) => {
  if (value === null) {
    return "不适用";
  }
  return value ? "达到" : "未达到";
};
const rows = [
  ["首屏 80% 中位数", "firstMedianMs", "firstMedian"],
  ["首屏 80% P95", "firstP95Ms", "firstP95"],
  ["停止后 95% 中位数", "stopMedianMs", "stopMedian"],
  ["停止后 95% P95", "stopP95Ms", "stopP95"],
].map(
  ([label, key, changeKey]) =>
    `| ${label} | ${f(baseline[key])} | ${f(optimized[key])} | ${f(result.changePercent[changeKey])}% |`
);
const markdown = [
  "# 图库性能对比",
  "",
  firstMetric === "entryFirstViewport80Ms"
    ? `首屏起点：${optimized.entryDefinition}。包含图库工具栏挂载后的查询与布局准备；不是整个应用的启动耗时。`
    : "首屏起点：瀑布流容器挂载；前置查询与布局准备不计入这个图片加载阶段指标。",
  "",
  `数据量 ${baseline.datasetCount}，${baseline.viewport.width}×${baseline.viewport.height}，DPR ${baseline.viewport.dpr}，${baseline.cache}，每构建 ${baseline.runs} 次。`,
  `网格参考宽度 ${baseline.gridColumnWidth}，来源长边设置 ${baseline.fixtureEdge}，磁盘变体条件 ${baseline.variantCache}。`,
  "",
  "| 指标（ms） | 基线 | 优化 | 变化 |",
  "| --- | ---: | ---: | ---: |",
  ...rows,
  "",
  "P95 使用最近秩法；停止补齐先取每次运行的最慢有效样本。五次运行的 P95 是五次中的最大值，不能据此推断全部硬件或真实图库的尾延迟。",
  stopMetric === "scriptedScrollStop95Ms"
    ? "停止指标采用固定操作数后的最后一次主动停止，不把连续滚动间的自动化命令停顿当作验收样本。原有 scrollStop95Ms 继续保留用于诊断。"
    : "停止指标包括采集期间所有有效滚动停顿。",
  "",
  `实际帧间隔 P95：${f(baseline.frameP95Ms)} → ${f(optimized.frameP95Ms)} ms。`,
  "",
  `优化缓存峰值：${optimized.pages} 页／${optimized.photos} 条／${optimized.bytes} 估算字节；图片并发 ${optimized.images}，非可见预取 ${optimized.prefetch}。`,
  "",
  `基线产物 ${baseline.bundleHash}；优化产物 ${optimized.bundleHash}。`,
  "",
  `无退化目标 ${targetLabel(result.targets.smallGalleryRegression)}，首屏收益目标 ${targetLabel(result.targets.first)}，停止补齐收益目标 ${targetLabel(result.targets.stop)}。正确性、交互回归和完整矩阵需要结合验证记录，不能由本报告代替。`,
  "",
].join("\n");
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(`${output}.json`, `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(`${output}.md`, markdown);
console.log(JSON.stringify(result, null, 2));
