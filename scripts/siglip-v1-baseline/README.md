# SigLIP v1 可重复验收基线

本目录只提交稳定的评测定义、schema 和工具说明。图片及具体机器生成的结果不进入 Git；运行结果统一写入已忽略的 `reports/`。

## 定义

- `manifest.v1.json` 固定 21 个本地样本的稳定 ID、文件名和错误类别。
- `queries.v1.json` 固定最终 prompt、相关样本和 hard negative。一个查询可以声明多个相关样本。
- runner 会拒绝未知 ID、相关样本与 hard negative 重叠、重复 ID/文件名，以及不完整的 21 样本数据集。
- 数据集、查询定义和 query plan 分别使用 canonical JSON SHA-256 指纹。

## Node 22 重复运行

```powershell
node scripts/run-siglip-v1-baseline.mjs `
  --dataset-root "D:\path\to\21-image-set" `
  --model-root "D:\path\to\models" `
  --mode all `
  --profile all `
  --trials 3
```

`--trials` 只能取 3～5。每次 trial 都重新启动生产 image/text worker，并记录 PID、执行顺序、内存、温度状态、Node 与硬件信息。三档按轮次旋转顺序，减少固定顺序偏差。

- 低配：固定 1 worker × 1 thread。
- 标准：读取生产自动配置，是“标准设备基线”，不是所有产品设备的固定配置。
- 高性能：最多 2 workers × 4 threads，低核心设备自动降级。
- 产品实际运行继续由硬件检测自动选择，低端设备允许降级到 1×1。
- 如果标准和高性能得到相同实际配置，报告标记为 `same-configuration-repeat`，禁止作性能优劣结论。

温度传感器不可读时记录 `unavailable` 和原因，不写伪造的零值。

## 指标语义

性能阶段分别记录模型加载、首张图片、热态单图、批量吞吐、文本编码和进程峰值内存。模型加载表示新 worker 的加载墙钟时间，但不会清除操作系统文件缓存。

质量指标包括 Hit@1/3/5/10、MRR、Recall@5/10、fixed-cutoff Precision@5/10/20/50、nDCG@50、返回数量分布、空结果比例、错误类别，以及文本编码、打分、过滤、排序和端到端基准搜索延迟。

`hardNegativeFalsePositiveRateAtK` 的分母是至少声明了一个 hard negative 的查询数。如果查询的 Top-K 结果中出现任意一个已声明的“相似但不相关”样本，该查询记为一次 false positive；该指标越低越好。例如 `@1 = 0.143` 表示 14.3% 的合格查询在第一名返回了 hard negative，`@3 = 0.762` 表示 76.2% 的合格查询在前三名内至少返回了一个 hard negative。

旧 Precision@20/50 仅为兼容保留，分母为 `min(K, returnedCount)`，并标记为 `legacy-nonstandard`。标准 fixed-cutoff Precision 始终以 K 为分母。

文本编码延迟仅包含生产文本 worker 请求。端到端基准搜索延迟包含文本编码、内存余弦打分、候选阈值过滤和排序，不包含 query planning、翻译、向量数据库 I/O 或 renderer IPC。不同指标定义或运行条件下的历史数值不能与最终 Node 22 重复基线直接比较。

## 质量结论边界

21 样本结果只能说明 SigLIP v1 在当前基线数据集上的召回和排序表现，不能推广为适合所有用户图片库。真实用户图库仍需后续合规抽样验证。

## JSON 唯一事实来源

每次运行创建 `reports/siglip-v1-baseline/<run-id>/`：

- `trials/*.json`：每次新 worker 的原始结果。
- `performance-*.json`、`quality-standard.json`：从 raw trial 自动聚合，包含 P5、median、P95、max 和 range。
- `run-index.json`：模型身份、定义指纹、轮次、执行顺序及原始文件索引。
- `summary.json`：机器可读决策汇总。
- `summary.md`：由 `summary.json` 自动生成，禁止手抄指标。

事实链为 `raw trial JSON → aggregate JSON/run-index.json → summary.json → summary.md`。

```powershell
node scripts/validate-siglip-v1-baseline-reports.mjs `
  reports\siglip-v1-baseline\<run-id>

node scripts/summarize-siglip-v1-baseline.mjs `
  reports\siglip-v1-baseline\<run-id> `
  --verify-reproducible
```

第二条命令连续重建两次并验证 raw 未变化、所有生成文件逐字节一致。

## 遗留验证

- 当前三档只在报告记录的单台主机上运行；真实低配、办公和高性能设备覆盖仍待完成。
- 500 张压力测试不能证明无内存泄漏。后续应运行 1000～5000 张、重复 3 次，并分别分析主进程和 worker RSS。
- 长时间索引结果由独立的 `run-ai-index-stress.mjs` 报告记录，不与本基准的短时峰值内存混为同一指标。

工具逻辑自测：

```powershell
node --test scripts/siglip-v1-baseline/baseline.test.mjs
```
