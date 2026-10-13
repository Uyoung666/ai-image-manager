# 首页与搜索栏维护边界

本次拆分保持原有功能、DOM、请求和存储语义。首页负责跨领域组合，搜索栏保留原受控接口；领域模块位于 `src/features/home/` 和 `src/features/search-bar/`，不参与文件路由扫描。

## 状态归属

| 职责 | 维护入口 | 约定 |
| --- | --- | --- |
| 搜索草稿、已应用条件 | `SidebarFilterContext` | 唯一条件来源，不在搜索栏复制状态 |
| 搜索结果与请求生命周期 | `useHomeSearch` | 首次查询、图搜、重试、分页共用代次保护；复用 `usePhotoSearch` 取消 |
| 搜索参数转换 | `buildHomeSearchParams` | 首次查询与分页使用同一转换，保留本地日期边界及游标语义 |
| 序列范围与结果 | `useHomeSequenceQuery` | 浏览查询完整过滤图库；搜索按已确认结果及代次追加成员 |
| 序列详情、展开及缓存 | `useHomeSequenceDetails` | 保留独立请求标识、完整详情与匹配成员详情 |
| 序列写操作与确认状态 | `useHomeSequenceActions` | 通过现有 actions 执行，保留预检、确认、刷新顺序 |
| 可选集合及预览照片 | `useHomeSelection` | 复用通用选择及序列成员解析 hooks，归属确认后才裁剪选择 |
| 批量收藏 | `useHomeBatchFavorite` | 解析完成后核对操作范围和选择；失败不使用不完整成员执行操作 |
| 照片操作与对话框状态 | `useHomePhotoActions` | 保留操作目标、动画、缓存失效及失败提示 |
| 搜索栏候选、历史、浮层 | 各自的 `use-search-*` hook | 候选请求经 actions；保留历史键与上限、标签竞态保护、Portal 例外及焦点行为 |

`HomeToolbar`、`HomeDetailPanel`、`HomeActionDialogs` 及搜索栏三个面板只负责展示和转发回调，不拥有查询、文件系统或数据库副作用。

## 后续修改方式

- 每次需求优先修改所属领域，再在入口组装；不要把入口的完整状态或所有 setter 打包传给一个通用 controller。
- 展示拆分保持根节点、class、ref、条件挂载和 Portal 宿主不变。工具栏根节点参与高度测量；详情的照片层保持挂载，序列层按条件挂载。
- 首页的序列范围和追加机制不同于 `useCollectionSequences`，不能直接替换。统一公共能力需要单独验证完整图库发现、分页、模式滚动与会话恢复。
- `BrowseSessionContext` 的 `home-search` 键及字段继续兼容；滚动恢复、图库快照和跨领域收藏状态同步由首页协调。
- 新增 IPC 调用先提供 typed action wrapper。模块单向依赖组件、共享 hooks、actions 和 types，不反向导入首页路由。

## 回归要求

相关回归包括搜索栏与预设、搜索取消和元数据、首页查询竞态、首页序列范围与追加、批量收藏范围、通用选择和浏览恢复测试。使用仓库的 Electron/Vitest 包装器运行，避免原生依赖 ABI 差异。

页面改动还需运行 Electron E2E 的 `720×480`、`900×600`、`1280×800` 矩阵，关注搜索浮层、工具栏高度、详情焦点、瀑布流布局、序列切换和返回定位。真实图搜与语义链测试需要 `AIM_SEARCH_BENCHMARK_PROFILE`；跳过不能记录为通过。

既有自定义 memo 比较、resetVersion 等行为未在结构拆分中调整；如果修改其语义，应另立修复并增加对应回归。

## 已记录的验证问题

`gallery-separation.spec.ts` 的快速模式切换用例在共享图库会话下曾期望滚动位置 `700`、实际读到 `1200`。拆分前的首页与搜索栏隔离构建也复现了相同位置差异；独立会话复跑该项及随后七项用例全部通过。本次保留原滚动恢复实现，后续应单独检查恢复完成与程序设置滚动位置之间的时序。

Windows 环境中，查询解析测试在清理 `reports/search-optimization/unit-query-parser` 下的临时目录时出现 `EPERM`，完整单测因此为 `2029/2030`。保持测试内容和当前源码一致，将该测试副本放在开发服务器忽略的 `.cache` 目录后，全部 36 项通过。打包复制也曾被同类报告目录访问错误阻断；编译及 Electron 行为验证已另行完成，未修改解析器、测试断言或打包配置。
