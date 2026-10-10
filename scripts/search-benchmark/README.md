# 搜索质量与速度评测

`queries.v1.json` 为独立整句审核的 60 条查询，历史开发集、历史验收集各 30 条。两组结果均已检查，今后全部作为固定回归集，不再称为未用于调参的验收集。素材来自本地 `audit/tag-benchmark-v2/manifest.v2.json` 的 320 图，沿用近重复分组隔离；不把标签直接作为整句答案。原有 `scripts/siglip-v1-baseline/` 21 图基准保留。

运行结果、源码快照、SQLite、LanceDB 和图片向量缓存均写入忽略目录 `reports/search-optimization/`；不要复用已有输出目录进行重新建库。真实图库素材只读，所有数据库与向量写入均使用隔离副本。素材未随代码分发，缺少素材时评测会报错。

```powershell
# 校验并评估真实图片；调用生产 oRPC searchCompound
node scripts/run-search-benchmark.mjs --split holdout

# 只测语义质量
node scripts/run-search-benchmark.mjs --split development --quality-only

# 质量诊断，保存改写、译文、Prompt、相关图与干扰图的余弦分数
node scripts/run-search-benchmark.mjs --split development --quality-only --trace-quality

# 指定另外冻结的查询定义；相对路径从仓库根解析
node scripts/run-search-benchmark.mjs --definition scripts/search-benchmark/queries.v2-calibration.json --split holdout --quality-only --trace-quality

# 原始 HEAD 的稳态速度对照，跳过该版本不支持的写入竞争场景
node scripts/run-search-benchmark.mjs --source '<冻结 HEAD>/src' --label head --split holdout --steady-state-only

# 规模测试，确定性合成向量不作为语义质量证据
node scripts/run-search-benchmark.mjs --synthetic 10000
node scripts/run-search-benchmark.mjs --synthetic 50000

# 先冻结真实 HEAD 与工作区，逐查询质量门禁通过后才启动速度矩阵
node scripts/search-benchmark/run-matrix.mjs run-<唯一编号>
node scripts/search-benchmark/run-matrix.mjs run-<唯一编号> --resume
# 当前模型验收：保留数值差异作为诊断，未完成状态仍阻止测速
node scripts/search-benchmark/run-matrix.mjs run-<唯一编号> --quality-policy current-model
node scripts/search-benchmark/summarize.mjs reports/search-optimization/run-<唯一编号>

# 完整 Electron 应用链路；复制已完成评测的隔离 profile
$env:AIM_SEARCH_BENCHMARK_PROFILE = '<实图评测输出绝对路径>\profile'
npm run test:e2e -- src/tests/e2e/search-semantic-chain.spec.ts src/tests/e2e/search-optimization.spec.ts src/tests/e2e/tag-search-refresh.spec.ts --workers=1

# 成功以图搜图与部分文本结果之间的模式切换，不采样性能
npm run test:e2e -- --no-build src/tests/e2e/search-image-transition.spec.ts --workers=1

# 打包成功后，构建两个隔离主进程版本，共用同一最终渲染页面
node scripts/search-benchmark/build-electron-comparison.mjs reports/search-optimization/run-<唯一编号>
# 前端本身有修改时，可为 baseline 指定已保存的旧版构建产物
node scripts/search-benchmark/build-electron-comparison.mjs reports/search-optimization/run-<唯一编号> --baseline-renderer '<旧构建>/.vite/renderer'
# 按生成的 build.json 设置每个版本的 application/source，分别运行；不要并行采样
$env:AIM_SEARCH_APPLICATION_ROOT = '<application>'
$env:AIM_SEARCH_APPLICATION_SOURCE = '<source>'
npm run test:e2e -- --no-build src/tests/e2e/search-semantic-chain.spec.ts --workers=1 --output '<对照目录>/e2e-<版本>'
# 可选第二个参数合并两个 Electron 报告，第三个参数检查最终补修的质量复测
node scripts/search-benchmark/summarize.mjs reports/search-optimization/run-<唯一编号> '<对照目录>' '<最终质量复测输出前缀>'
```

矩阵通过 `git archive` 保存 HEAD 的 `src/`、生产 `scripts/`、数据库迁移、构建配置、`package.json` 和 `package-lock.json`；工作区采用相同范围冻结，不修改 Git index。模型配置与 tokenizer 同时冻结，未被 Git 跟踪的本地 ONNX 作为各版本共同只读资源单独记录 SHA-256，不声称具有历史 HEAD 模型来源。运行器在冻结配置旁为共同 ONNX 创建硬链接，图像、文本和翻译均从这个模型根解析，避免翻译另查工作目录时缺失权重。运行时从对应快照解析 Worker 和迁移，验证冻结配置；安装依赖与快照 lockfile 是否一致单独记录。每组保存提交 SHA、完整运行源码指纹与查询定义指纹。`quality-gate.json` 逐条检查已标注相关图的 Recall@50、nDCG@10、MRR、新增前十干扰图、新增空查询误报与完成状态；默认严格策略在下降时结束矩阵。可用以下命令单独检查报告（基线必须带冻结 HEAD 元数据）：

```powershell
node scripts/search-benchmark/regression-gate.mjs <HEAD-report.json> <candidate-report.json>
```

历史 HEAD 接口若没有完成状态字段，报告保留 `legacy`（未知），门禁只在已验证的 HEAD 快照中允许其用于结果质量比较；不得当作正常完成搜索的速度证据。当前工作区必须明确返回 `complete`。

`--steady-state-only` 另存历史 HEAD 的热态请求、缓存命中和连续切换耗时，仍执行实际查询并保存质量结果。它不证明旧请求处理完整：旧接口的 `completionMeasured=false`，超时与部分比例为 `null`。当前版本必须明确完成；不能将旧版未知比例解释为零。该选项仅用于实图，不替代规模正确性或索引、缩略图竞争测试。

默认 `strict` 保留原有逐条不下降的门禁。`--quality-policy current-model` 用于以现有模型能力为边界的优化：Recall、nDCG、MRR 与干扰图差异全部保留为警告，不再单独阻止速度采样；未完成状态、缺失报告、定义不同或非 HEAD 基线仍拒绝。严格比较的 `qualityPassed` 不会改成通过，策略决定另存为 `qualityAssessment`。数值下降不自动归因于模型上限；查询改写、翻译条件、候选覆盖、整句评分、过滤、分页、取消与状态一致性必须通过代码审查和功能测试验证。性能数字不证明提交已获批准。生产模型、硬过滤阈值和固定判断不因选择此策略而改变。

门禁通过后，`create-correctness-baseline.mjs` 从完整工作区快照生成**重构的正确性对照**：只恢复 ANN 全向量和全候选详情读取，保留固定单文本编码、分批标量补分、取消、队列逻辑和同一图片预处理。补丁未匹配时直接报错，不生成表面成功的对照。它只用于解释这两项读取优化，不能代替 HEAD 质量基线。续跑保留冻结源码和原始报告；源码有新改动必须使用新的矩阵编号，旧版仅含 `src/` 的快照不能继续用于新评测。

真实质量采用 nDCG@10、MRR、Recall@50、前十位含指定干扰图的查询比例、应为空误报比例。未判定项从质量分母排除，单列判定覆盖率；旧版非标准 Precision 不用于选参。继续调参前，必须另外冻结未使用的新查询与人工判断作为验收集；禁止修改旧判断追回门禁，也禁止恢复辅助分数冒充整句分数或放宽硬过滤。当前固定 60 条回归查询通过不代表新验收集通过。

诊断中的余弦分数使用与当前交互搜索一致的固定单文本编码，覆盖正向与负向概念，并记录文本顺序与批大小；实际生产过滤阈值和返回结果另存于 `qualityTrace.semantic`。诊断不得混入性能采样，运行器会拒绝同时开启计时轮次与质量跟踪。

`--trace-quality` 同时保存该组全部图片的分数和人工判断，供不改标签的阈值重放核对；未判定图片仍不得被当作负例。运行器记录自身 SHA、定义路径与定义指纹。SSR 驱动关闭文件监听及开发依赖发现，避免测量进程执行无关后台工作；这种驱动设置不代表生产应用的内存优化。

`queries.v2-calibration.json` 的另外 60 条整句查询和判断在首次查分前封存，沿用已有图片，不能称为新图片泛化验证。首次开发组/验证组结果分开保留。随后已用两组结果诊断解析器问题，因此后续复测全部作为固定回归，不再用于宣称独立验收；不得修改标签追回指标。

每个热态场景为 30 次 × 3 轮；冷请求使用新进程，但数据准备已经触及操作系统页缓存。各进程串行运行，采样时不要同时构建或跑其他测试。`index-batch-write` 使用真实向量批次写入，不包含图像编码竞争；版本变化返回部分状态，部分比例和超时比例分别报告。

真实图片运行增加 `thumbnail-backfill`：90 张不同图片分别调用生产缩略图服务，与新文本查询并行；生成后写入隔离数据库的 `thumbnail_path`，要求搜索完整完成。记录生成工作耗时及写入是否在搜索结束前完成。该场景只模拟一次生成请求的竞争，不代表首页全部缩略图解码或大批量导入；合成数据不参与此场景。

命令行运行器在 Electron-as-Node 中使用真实 SQLite、LanceDB 和模型，`ipcMs`、`firstPaintMs` 为未测量的 `null`。真实 Electron E2E 关联准备、排队、翻译、编码、向量、SQLite、排序、RPC 往返和首屏；RPC 往返包括服务耗时，首屏是 React 提交后两次动画帧，不保证图片解码完成。并行阶段不可相加作为总耗时。

Electron 稳态夹具按生产 v4 缓存规则预生成缩略图，冷请求之后等待实际的颜色与高级 EXIF 启动补全结束，再测热态场景。测试断言稳态请求完成、重复查询全部命中候选缓存。启动补全等待时间、冷请求以及索引期间的部分结果分别报告。

Electron 构建记录每个版本的完整渲染产物指纹，拒绝链接和变化中的输入。默认共用同一页面，只比较后端；使用 `--baseline-renderer` 后分别记录两套产物，共同 `rendererHash` 为 `null`。旧页面必须来自真实已保存构建，不能用当前页面冒充前端基线。

需要定位数据库写入时可设置 `AIM_SEARCH_TRACE_WRITES=1`，仅在隔离副本添加诊断触发器。带触发器的报告不用于速度对照，汇总器会拒绝混入这种运行。

宿主 RSS 峰值不含所有 Worker。Electron E2E 另行采样 `app.getAppMetrics()` 可见进程工作集总和，不含未报告子进程。两者不可混用。

合成集完整遍历精确检索与语义检索分页，检查全部精确结果可达、语义 `100/200` 两种页长的集合一致、硬筛选、去重、最终总数及完成状态。证据记录在报告 `correctness` 和矩阵 `correctnessAssessment`，数值质量警告不能覆盖这项独立功能门禁；它不替代查询解析、取消和前端状态回归测试。`nprobes`、`refineFactor`、候选深度实验只作用于隔离表，不修改生产默认值。性能目标为热态新查询和连续切换 P95 各降低至少 20%；未达标保留实测值，不靠缩减召回或忽略部分结果达标。

2026-10-08 后续阶段按用户要求取消必须达到 20% 的验收条件，改为与真实原版比较并如实报告改善、倒退和测量局限。历史 20% 目标及未达结果保留，不覆盖原报告；质量和完成状态不会因降低速度目标而放宽。
