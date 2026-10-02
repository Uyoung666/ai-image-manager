# 测试目录管理

`test-runtime.ts` 管理仓库中的 `.test-runtime` 和 `.cache` 测试夹具。目录通过归属标记记录创建时间、测试名称和运行进程；不处理无标记的旧目录。

E2E 测试从 `../e2e/helpers/test-runtime` 导入 `test`、`createTestRuntime` 和 `launchTestApp`。使用这套 `test` 创建的 worker 会在结束时关闭应用、等待进程及日志流关闭，将日志和诊断保存到 Playwright 输出目录，最后删除模型副本和隔离配置。初始化失败也会走收尾逻辑；失败用例的诊断会附在报告中。

设置 `AIM_KEEP_TEST_RUNTIME=1` 可保留完整现场，控制台会打印保留路径。保留标记会写入目录，后续清理命令也会跳过它。诊断保存或清理失败时保留目录并让测试报错，不覆盖原始断言失败。

单元测试可直接创建 `TestRuntime`，在收尾阶段先关闭数据库，再调用 `cleanup()`。

- `npm run test:runtime:cleanup`：预览超过 24 小时且相关进程均已退出的、有合法标记的目录。
- `npm run test:runtime:cleanup -- --apply`：重新核验并清理符合条件的目录。
- `npm run test:runtime:lifecycle`：通过原生 Node 启动 Playwright，验证成功、断言失败和初始化失败后的清理及诊断保留。

所有删除操作拒绝越界路径、链接以及包含 CSV、XLSX 或 Temp 目录的目标。Windows 文件占用只做有限重试；部分删除失败时尽量保留归属标记，以便后续识别。

开发服务器忽略 `.cache` 和 `.test-runtime`，避免 Windows 目录监听句柄阻碍清理。修改监听规则后，已启动的开发环境需要重启才能生效。
