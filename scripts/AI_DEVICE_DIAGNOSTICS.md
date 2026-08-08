# AI 设备诊断报告

`npm run diagnostics:ai -- --input <测试图片目录>` 在当前设备上轮转运行三种配置：

- `1×1`：显式限制为 1 worker、1 thread；
- `automatic`：不设置覆盖变量，使用产品的自动硬件配置；
- `2×4`：显式限制为 2 workers、每 worker 4 threads。

默认每档使用 1000 个逻辑图片任务并启动 3 个全新进程 trial。每次运行包含临时 LanceDB 写入/读回、成功后指纹发布、中途暂停/恢复、分段吞吐和内存采样。若进程被中断，可以用同一个 `--output-dir` 续跑；已有完整 raw report 不会重复执行，半完成目录不会被当作成功。

输出位于 `reports/ai-device-diagnostics/<timestamp>/`：

- 每个子目录保存一份原始 `ai-index-stress.json`；
- `device-diagnostics.json` 聚合吞吐和预热后的 combined/parent/worker RSS；
- 报告记录 CPU、逻辑核心、总内存、系统和 Node 版本；
- 报告不包含图片内容或图片路径，可以由测试用户主动反馈。

示例：

```powershell
npm run diagnostics:ai -- `
  --input "D:\path\to\test-images" `
  --count 1000 `
  --trials 3
```

该工具只能在同一台机器上模拟并发配置，不能模拟真实低端 CPU 性能、内存带宽或热降频。`2×4` 是标准设备基线，不是产品固定配置；产品运行继续以自动硬件选择为准。

内存趋势也不是泄漏证明。若出现稳态增长，应扩大到 1000～5000 张、重复运行，并结合更长时间观测。设备诊断编排器每个 trial 最多 1000 项；专项定位可直接运行 `run-ai-index-stress.mjs --count 3000`，并用 `--restart-worker-after 1500` 观察 worker 重启前后的内存回落。

专项报告会额外记录：

- 主进程 `rss / heapUsed / external / arrayBuffers`；
- 每个 worker 的 PID 和 RSS；
- worker 重启前、停止后、重新加载后的快照；
- 最终停止 worker 和关闭 LanceDB 后的快照；
- 每个 worker generation 独立的趋势，避免把重启断点当作连续曲线。

从原始压力 JSON 生成不含图片路径的定位摘要：

```powershell
npm run diagnostics:ai:memory-summary -- `
  reports\ai-memory-localization\<run>\ai-index-stress.json
```

外部 RSS 可以区分主进程、worker 生命周期和 LanceDB 关闭前后变化，但不能严格区分 worker 内部的图片解码缓冲与 ONNX Runtime arena；若要进一步拆分，必须增加 worker 内部遥测，不能仅凭 RSS 推断。
