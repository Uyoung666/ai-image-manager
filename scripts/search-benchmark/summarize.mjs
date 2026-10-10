import fs from "node:fs";
import path from "node:path";
import { measuredDistribution } from "./evaluate.mjs";

const BOM_PREFIX_RE = /^\uFEFF/;

const root = path.resolve(
  process.argv[2] ?? "reports/search-optimization/final-20261004"
);
const matrix = JSON.parse(
  fs.readFileSync(path.join(root, "matrix.json"), "utf8")
);
if (
  matrix.schemaVersion === 2 &&
  matrix.qualityPassed === false &&
  !matrix.qualityAssessment?.accepted
) {
  const gates = JSON.parse(
    fs.readFileSync(path.join(root, "quality-gate.json"), "utf8")
  );
  const summary = {
    schemaVersion: 2,
    matrix,
    qualityGates: gates,
    acceptance: {
      noQualityRegressionsAgainstHead: false,
      speedAcceptance: matrix.runs.some((run) => !run.qualityOnly)
        ? "blocked-by-quality-policy"
        : "not-started",
    },
  };
  const lines = [
    "# 搜索优化质量门禁",
    "",
    "质量策略未通过，当前不接受速度结果。旧开发集与验收集均作为回归集，平均指标改善不能覆盖逐条下降。",
    "",
    `HEAD：${gates[0].baselineCommit}。完整源码与查询定义指纹见 JSON。`,
    "",
    "| 查询 | HEAD / 当前 Recall@50 | 丢失相关图 | 新增前十干扰图 | 下降指标 / 状态 |",
    "| --- | ---: | --- | --- | --- |",
  ];
  for (const gate of gates) {
    for (const row of gate.regressions) {
      lines.push(
        `| ${row.query} | ${row.before.recallAt50 ?? "不适用"} / ${row.after.recallAt50 ?? "不适用"} | ${row.lostRelevant.join(", ") || "无"} | ${row.addedHardNegatives.join(", ") || "无"} | ${[...row.decreasedMetrics, ...(row.incomplete ? ["未完成"] : []), ...(row.newEmptyFalsePositive ? ["新增空查询误报"] : [])].join(", ") || "无"} |`
      );
    }
  }
  fs.writeFileSync(
    path.join(root, "summary.json"),
    JSON.stringify(summary, null, 2)
  );
  fs.writeFileSync(path.join(root, "summary.md"), `${lines.join("\n")}\n`);
  console.log(root);
  process.exit(0);
}
if (!matrix.finishedAt || matrix.runs.some((run) => run.exitCode !== 0)) {
  throw new Error("Matrix is incomplete");
}
const reports = Object.fromEntries(
  matrix.runs.map((run) => [
    run.name,
    JSON.parse(fs.readFileSync(path.join(run.output, "report.json"), "utf8")),
  ])
);
const readOptionalReport = (name) => {
  const file = path.join(root, name);
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8").replace(BOM_PREFIX_RE, ""))
    : null;
};
let electron = null;
if (process.argv[3]) {
  const directory = path.resolve(process.argv[3]);
  const build = JSON.parse(
    fs.readFileSync(path.join(directory, "build.json"), "utf8")
  );
  const fixtureRuntimeHashes = new Set(
    matrix.runs
      .filter(
        (run) =>
          ["baseline", "optimized"].includes(run.variant) &&
          reports[run.name].scope === "production-api-real-images"
      )
      .map((run) => reports[run.name].sourceTreeHash)
      .filter((hash) => typeof hash === "string" && hash.length > 0)
  );
  const variants = {};
  for (const variant of ["baseline", "optimized"]) {
    const results = path.join(directory, `e2e-${variant}`);
    const file = fs
      .readdirSync(results, { recursive: true })
      .find((name) => name.endsWith("semantic-chain-report.json"));
    if (!file) {
      throw new Error(`Missing Electron result for ${variant}`);
    }
    const report = JSON.parse(
      fs.readFileSync(path.join(results, file), "utf8")
    );
    const runtimeHashes = new Set(
      matrix.runs
        .filter((run) => run.variant === variant)
        .map((run) => reports[run.name].sourceTreeHash)
        .filter((hash) => typeof hash === "string" && hash.length > 0)
    );
    const [runtimeHash] = runtimeHashes;
    if (
      runtimeHashes.size !== 1 ||
      build.variants?.[variant]?.sourceTreeHash !== runtimeHash ||
      report.applicationRuntimeSourceHash !== runtimeHash ||
      !fixtureRuntimeHashes.has(report.fixtureRuntimeSourceHash)
    ) {
      throw new Error(
        `Electron runtime source does not match this matrix/build for ${variant}`
      );
    }
    if (report.databaseWrites !== undefined && report.databaseWrites !== null) {
      throw new Error(
        "Write-traced diagnostic runs cannot be speed comparisons"
      );
    }
    variants[variant] = {
      applicationSourceHash: report.applicationSourceHash,
      applicationRuntimeSourceHash: report.applicationRuntimeSourceHash,
      fixtureRuntimeSourceHash: report.fixtureRuntimeSourceHash,
      peakAppWorkingSetKB: report.peakAppWorkingSetKB,
      coldStart: report.coldStart,
      thumbnailPreparation: report.thumbnailPreparation ?? "未记录",
      backgroundPreparation: report.backgroundPreparation ?? "未记录",
      backgroundPreparationMs: report.backgroundPreparationMs ?? null,
      scenarios: Object.fromEntries(
        Object.entries(report.scenarios).map(([name, rows]) => [
          name,
          {
            count: rows.length,
            completeRatio:
              rows.filter((row) => row.completion === "complete").length /
              rows.length,
            partialRatio:
              rows.filter((row) => row.completion === "partial").length /
              rows.length,
            timeoutRatio:
              rows.filter((row) => row.incompleteReason === "deadline").length /
              rows.length,
            cacheHitRatio:
              rows.filter((row) => row.cacheHit).length / rows.length,
            ipc: measuredDistribution(rows.map((row) => row.timings.ipcMs)),
            firstPaint: measuredDistribution(
              rows.map((row) => row.timings.firstPaintMs)
            ),
            stages: Object.fromEntries(
              Object.keys(rows[0]?.timings ?? {}).map((phase) => [
                phase,
                measuredDistribution(rows.map((row) => row.timings[phase])),
              ])
            ),
          },
        ])
      ),
    };
  }
  electron = { directory, rendererHash: build.rendererHash, variants };
}
const quality = {};
const performance = {};
const finalQuality = {};
for (const split of ["development", "holdout"]) {
  const before = reports[`head-quality-${split}`] ?? reports[`before-${split}`];
  const baseline = reports[`baseline-${split}`];
  const optimized = reports[`optimized-${split}`];
  if (baseline.definitionHash !== optimized.definitionHash) {
    throw new Error("Query definitions differ");
  }
  quality[split] = {
    queryCount: optimized.queries.length,
    emptyQueryCount: optimized.quality.perQuery.filter(
      (row) => row.emptyFalsePositive !== null
    ).length,
    before: before.quality.metrics,
    baseline: baseline.quality.metrics,
    optimized: optimized.quality.metrics,
    metricsEqual:
      JSON.stringify(baseline.quality.metrics) ===
      JSON.stringify(optimized.quality.metrics),
    rankedResultsEqual: baseline.queries.every(
      (query) =>
        JSON.stringify(query.results) ===
        JSON.stringify(
          optimized.queries.find((row) => row.id === query.id)?.results
        )
    ),
  };
  if (process.argv[4]) {
    const latest = JSON.parse(
      fs.readFileSync(
        path.join(`${path.resolve(process.argv[4])}-${split}`, "report.json"),
        "utf8"
      )
    );
    finalQuality[split] = {
      sourceHash: latest.sourceHash,
      definitionHash: latest.definitionHash,
      metrics: latest.quality.metrics,
      metricsEqual:
        JSON.stringify(latest.quality.metrics) ===
        JSON.stringify(optimized.quality.metrics),
      rankedResultsEqual: latest.queries.every(
        (query) =>
          JSON.stringify(query.results) ===
          JSON.stringify(
            optimized.queries.find((row) => row.id === query.id)?.results
          )
      ),
    };
    if (
      !(
        finalQuality[split].metricsEqual &&
        finalQuality[split].rankedResultsEqual
      )
    ) {
      throw new Error(`Final source changed quality on ${split}`);
    }
  }
}
for (const scope of ["development", "holdout", "10000", "50000"]) {
  const baseline = reports[`baseline-${scope}`];
  const optimized = reports[`optimized-${scope}`];
  performance[scope] = Object.fromEntries(
    Object.keys(optimized.performance.scenarios).map((scenario) => {
      const b = baseline.performance.scenarios[scenario];
      const o = optimized.performance.scenarios[scenario];
      const reduction = b.p95 > 0 ? 1 - o.p95 / b.p95 : null;
      return [
        scenario,
        {
          baselineP50: b.p50,
          baselineP95: b.p95,
          optimizedP50: o.p50,
          optimizedP95: o.p95,
          p95Reduction: reduction,
          meets20Percent:
            reduction !== null &&
            reduction >= 0.2 &&
            b.partialRatio === 0 &&
            o.partialRatio === 0,
          baselineTimeoutRatio: b.timeoutRatio,
          optimizedTimeoutRatio: o.timeoutRatio,
          baselinePartialRatio: b.partialRatio,
          optimizedPartialRatio: o.partialRatio,
        },
      ];
    })
  );
}
const resources = Object.fromEntries(
  Object.entries(reports).map(([name, report]) => [
    name,
    {
      peakHostRssBytes: report.peakHostRssBytes,
      coldMs: report.performance.cold.elapsedMs,
      coldCompletion: report.performance.cold.completion,
      pagination: report.performance.pagination ?? null,
      semanticPagination: report.performance.semanticPagination ?? null,
    },
  ])
);
function electronMeetsTarget(scenario) {
  const baselineScene = electron?.variants.baseline.scenarios[scenario];
  const optimizedScene = electron?.variants.optimized.scenarios[scenario];
  const baseline = baselineScene?.firstPaint.p95;
  const optimized = optimizedScene?.firstPaint.p95;
  if (
    typeof baseline !== "number" ||
    baseline <= 0 ||
    typeof optimized !== "number"
  ) {
    return null;
  }
  return (
    1 - optimized / baseline >= 0.2 &&
    baselineScene.completeRatio === 1 &&
    optimizedScene.completeRatio === 1 &&
    baselineScene.partialRatio === 0 &&
    optimizedScene.partialRatio === 0 &&
    baselineScene.timeoutRatio === 0 &&
    optimizedScene.timeoutRatio === 0
  );
}
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  comparison:
    matrix.comparison ??
    "Reconstructed correctness-only comparator; same query planning, single-text encoding, bounded scoring, cancellation and image preprocessing; full ANN vector and candidate detail reads",
  matrix,
  quality,
  finalQuality,
  performance,
  resources,
  electron,
  validation: readOptionalReport("validation.json"),
  cleanup: readOptionalReport("cleanup.json"),
  acceptance: {
    qualityPolicy: matrix.qualityPolicy ?? "strict",
    qualityPolicyAccepted: matrix.qualityAssessment?.accepted ?? null,
    qualityWarnings: matrix.qualityAssessment?.warnings ?? [],
    noQualityRegressionsAgainstHead:
      matrix.schemaVersion === 2 ? matrix.qualityPassed : null,
    qualityMatchesCorrectnessBaseline:
      quality.holdout.metricsEqual && quality.holdout.rankedResultsEqual,
    hotP95Target: performance.holdout["warm-new-query"].meets20Percent,
    switchingP95Target: performance.holdout["continuous-switch"].meets20Percent,
    electronFirstPaintHotP95Target: electronMeetsTarget("warm-new-query"),
    electronFirstPaintSwitchingP95Target:
      electronMeetsTarget("continuous-switch"),
  },
};
fs.writeFileSync(
  path.join(root, "summary.json"),
  JSON.stringify(summary, null, 2)
);
const number = (value) =>
  typeof value === "number" ? value.toFixed(3) : "未测量";
const percent = (value) =>
  typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "未测量";
const lines = [
  "# 搜索优化实测报告",
  "",
  `质量策略：${matrix.qualityPolicy ?? "strict"}；相对 HEAD 无逐条下降：${summary.acceptance.noQualityRegressionsAgainstHead}。当前模型策略只将数值差异列为诊断，不证明模型上限，也不替代功能正确性验证。`,
  "",
  `生成时间：${summary.generatedAt}。查询定义、源码指纹、机器配置及逐次计时详见同目录 JSON。`,
  "",
  matrix.comparisonDescription ??
    "正确性对照只恢复 ANN 全向量返回和全部候选详情读取，保留最终查询规划、单文本编码、分批补分、取消及图片输入；它是重构的比较版本，并非历史发布版。正式矩阵各进程串行运行。每个热态场景为 30 次 × 3 轮。",
  "",
  "## 正确性与质量",
  "",
  "| 数据集 / 版本 | nDCG@10 | MRR | Recall@50 | 干扰图出现率@10 | 应为空误报率 | 判定覆盖率 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
];
for (const [split, versions] of Object.entries(quality)) {
  for (const version of ["before", "baseline", "optimized"]) {
    const q = versions[version];
    lines.push(
      `| ${split} / ${version} | ${number(q.ndcgAt10)} | ${number(q.mrr)} | ${number(q.recallAt50)} | ${percent(q.hardNegativeRateAt10)} | ${percent(q.emptyFalsePositiveRate)} | ${percent(q.judgmentCoverage)} |`
    );
  }
}
if (summary.acceptance.qualityWarnings.length) {
  lines.push(
    "",
    "当前模型策略保留的逐条质量差异（不能据此认定全部属于模型上限）：",
    "",
    "| 查询 | 丢失相关图 | 新增前十干扰图 | 下降指标 |",
    "| --- | --- | --- | --- |",
    ...summary.acceptance.qualityWarnings.map(
      (row) =>
        `| ${row.query} | ${row.lostRelevant.join(", ") || "无"} | ${row.addedHardNegatives.join(", ") || "无"} | ${row.decreasedMetrics.join(", ") || "无"} |`
    )
  );
}
lines.push(
  "",
  `历史 holdout 回归集提速前后指标相同：${quality.holdout.metricsEqual}；逐查询结果及顺序相同：${quality.holdout.rankedResultsEqual}。`,
  `应为空查询分母：development ${quality.development.emptyQueryCount} 条，holdout ${quality.holdout.emptyQueryCount} 条。该误报率样本很少，不能推断全图库误报概率。`,
  `附加最终源码质量复测：${
    Object.keys(finalQuality).length
      ? Object.entries(finalQuality)
          .map(
            ([split, row]) =>
              `${split} 指标及排序一致=${row.metricsEqual && row.rankedResultsEqual}`
          )
          .join("；")
      : "未另行提供；本矩阵的固定查询结果见上表"
  }。`,
  "",
  "## 速度变化",
  "",
  "| 范围 / 场景 | 基线 P50 / P95 (ms) | 优化 P50 / P95 (ms) | P95 降幅 | 优化超时比例 | 优化部分结果比例 |",
  "| --- | ---: | ---: | ---: | ---: | ---: |"
);
for (const [scope, scenarios] of Object.entries(performance)) {
  for (const [scenario, row] of Object.entries(scenarios)) {
    lines.push(
      `| ${scope} / ${scenario} | ${number(row.baselineP50)} / ${number(row.baselineP95)} | ${number(row.optimizedP50)} / ${number(row.optimizedP95)} | ${percent(row.p95Reduction)} | ${percent(row.optimizedTimeoutRatio)} | ${percent(row.optimizedPartialRatio)} |`
    );
  }
}
lines.push(
  "",
  `历史性能目标记录：热态新查询 ≥20% 降幅：${summary.acceptance.hotP95Target}；连续切换 ≥20% 降幅：${summary.acceptance.switchingP95Target}。这两组已查看查询不再称为独立验收集。`,
  "",
  "## 资源和规模",
  "",
  "| 运行 | 宿主 RSS 峰值 (MiB) | 冷请求 (ms) | 冷请求状态 | 分页返回 / 去重后 |",
  "| --- | ---: | ---: | --- | ---: |"
);
for (const [name, row] of Object.entries(resources)) {
  lines.push(
    `| ${name} | ${number(row.peakHostRssBytes / 1024 / 1024)} | ${number(row.coldMs)} | ${row.coldCompletion} | ${row.pagination ? `${row.pagination.returned} / ${row.pagination.unique}` : "不适用"} |`
  );
}
lines.push(
  "",
  "## 限制和后续瓶颈",
  "",
  "- 模型仍存在应为空查询的语义误报；本轮未调整模型、阈值或默认排序参数。开发集 Recall 的变化必须与正确性修复后的基线区分，不能声称所有旧版质量指标都提高。",
  "- 索引批次重叠时的版本变化会明确返回部分状态；上表单列部分比例，不能把它隐藏为正常成功。该场景未模拟图像编码竞争。",
  "- 合成集用于验证规模和分页，不代表真实语义质量。nprobes、refineFactor、深度实验仅列于各合成报告的 experiments，不修改生产默认值。",
  electron
    ? "- 命令行报告的 ipcMs 和 firstPaintMs 保持未测量；真实 Electron 链路报告位于本报告 JSON 的 electron.directory 所指目录。"
    : "- 命令行报告的 ipcMs 和 firstPaintMs 保持未测量；本报告尚未合并真实 Electron 链路结果，首屏速度目标待验证。",
  "- RSS 是宿主峰值，不能当作包括所有 Worker 的总峰值；Electron 工作集采样另行报告。",
  resources["baseline-50000"].semanticPagination &&
    resources["optimized-50000"].semanticPagination
    ? "- 本矩阵两版 5 万条运行都包含性能采样后的原生语义分页与参数实验；宿主 RSS 峰值包括这些附加检查的开销，不能当作稳态常驻内存。"
    : "- 两版 5 万条运行的附加分页检查范围不完全相同；宿主 RSS 峰值包括附加检查，不能直接推断稳态内存差异。",
  "- 冷请求以新进程测量，但素材准备已触及文件系统缓存；没有重启操作系统或清空页缓存。",
  "- 单机结果不代表其他 CPU、GPU、存储或百万级图库；任何未达到的性能目标保留原值。",
  ""
);
if (electron) {
  lines.push(
    "## 真实 Electron 首屏对照",
    "",
    "两版使用相同 Vite 主进程构建配置和相同最终渲染页面，隔离数据库；完整运行源码指纹已与本矩阵和 build.json 校验，每场景 30 次 × 3 轮。首屏包含 RPC 和 React 提交后两帧，不等于缩略图全部解码。20% 首屏目标要求两版全部完成且无超时或部分结果。",
    "",
    "| 场景 | 基线首屏 P50 / P95 (ms) | 优化首屏 P50 / P95 (ms) | P95 降幅 | 基线 / 优化部分比例 | 基线 / 优化缓存命中比例 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const [scenario, row] of Object.entries(
    electron.variants.optimized.scenarios
  )) {
    const before = electron.variants.baseline.scenarios[scenario];
    lines.push(
      `| ${scenario} | ${number(before.firstPaint.p50)} / ${number(before.firstPaint.p95)} | ${number(row.firstPaint.p50)} / ${number(row.firstPaint.p95)} | ${percent(1 - row.firstPaint.p95 / before.firstPaint.p95)} | ${percent(before.partialRatio)} / ${percent(row.partialRatio)} | ${percent(before.cacheHitRatio)} / ${percent(row.cacheHitRatio)} |`
    );
  }
  lines.push(
    "",
    ...Object.entries(electron.variants).map(
      ([name, row]) =>
        `- ${name}：可见进程工作集采样峰值 ${number(row.peakAppWorkingSetKB / 1024)} MiB；不含未报告子进程。缩略图准备：${row.thumbnailPreparation}。`
    ),
    `完整应用首屏目标：热态新查询 ≥20% 降幅=${summary.acceptance.electronFirstPaintHotP95Target}；连续切换 ≥20% 降幅=${summary.acceptance.electronFirstPaintSwitchingP95Target}。`,
    "冷请求和 RPC、各阶段分布见 JSON；服务层提速不能替代首屏提速结论。",
    `优化版普通热查询的 P50：文本编码 ${number(electron.variants.optimized.scenarios["warm-new-query"].stages.textEncodingMs.p50)} ms，服务总耗时 ${number(electron.variants.optimized.scenarios["warm-new-query"].stages.serviceMs.p50)} ms，RPC 往返 ${number(electron.variants.optimized.scenarios["warm-new-query"].stages.ipcMs.p50)} ms，首屏 ${number(electron.variants.optimized.scenarios["warm-new-query"].firstPaint.p50)} ms。这些包含关系和重叠阶段不能相加。`,
    ...Object.entries(electron.variants).map(
      ([name, row]) =>
        `${name} 启动补全等待 ${number(row.backgroundPreparationMs)} ms；冷请求位于等待前，其状态与分段耗时保留在 JSON。稳态查询位于实际补全完成且数据库版本稳定之后。`
    ),
    ""
  );
}
if (summary.validation) {
  lines.push(
    "## 验证记录",
    "",
    "验证命令、退出码、数量与日志路径见本矩阵目录 validation.json；质量与速度比较使用上方固定数据。",
    "",
    "| 检查 | 退出码 | 结果 |",
    "| --- | ---: | --- |",
    ...summary.validation.checks.map(
      (row) => `| ${row.command} | ${row.exitCode} | ${row.result} |`
    ),
    "",
    "未验证范围：万张真实图库（规模集为合成数据）、图像编码与搜索同时运行的资源竞争、多机器结果，以及清空操作系统页缓存后的冷启动。",
    ""
  );
}
if (summary.cleanup) {
  lines.push(
    "## 产物清理",
    "",
    `清理 ${summary.cleanup.removed.length} 个本轮生成目录，回收约 ${number(summary.cleanup.removedBytes / 1024 ** 3)} GiB 磁盘空间。逐项路径、字节数和保留检查见本矩阵目录 cleanup.json。`,
    "保留代码、原始照片、模型、源码对照、查询定义、向量复现缓存和原始报告；保留 CSV/XLSX、Temp 与其他既有发布产物。隔离数据库和可再生成的构建包已移除，重复验证需先执行 README 中的建库或打包步骤。",
    ""
  );
}
fs.writeFileSync(path.join(root, "summary.md"), lines.join("\n"));
console.log(JSON.stringify(summary.acceptance));
