# AI Image Manager

**100% 本地 AI 图片管理器** — 用自然语言搜索你的图片库，无需上传到云端。

双击即用，就地索引文件夹（不复制原始文件），CLIP 语义搜索、智能去重、自动标签、人脸识别、云端分享。

[![Version](https://img.shields.io/badge/version-1.0.0--beta-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d7)](#)

---

## 应用截图

| | | |
|:---:|:---:|:---:|
| **首页浏览** | **快捷键面板** | **重复照片检测** |
| ![首页](screenshots/01-home.png) | ![快捷键](screenshots/02-keyboard-shortcuts.png) | ![重复检测](screenshots/03-duplicate-detection.png) |
| **全屏预览** | **照片详情** | |
| ![预览](screenshots/04-lightbox-preview.png) | ![详情](screenshots/05-photo-detail.png) | |

## 下载与安装

从 [Releases](https://github.com/Uyoung666/ai-image-manager/releases) 页面下载最新版本。Release 中包含操作演示视频。

### 方式一：安装版（推荐）

下载 `AI Image Manager-1.0.0-beta Setup.exe`，双击运行安装向导。

- 安装到系统默认位置（`%LocalAppData%\AI Image Manager`）
- 自动创建桌面快捷方式和开始菜单条目
- 支持自动更新

### 方式二：便携版

下载 `AI Image Manager-win32-x64-1.0.0-beta.zip`，解压到任意目录，运行 `AI Image Manager.exe` 即可。

- 不写注册表，不创建快捷方式
- 可将整个目录放在 U 盘或移动硬盘中随身使用
- 数据存储在解压目录下的 `data/` 文件夹中

---

## 首次启动说明

### 国内用户

应用已自动配置国内镜像（hf-mirror.com），首次启动会自动下载 AI 模型（约 150MB）。

**如果下载失败：**

1. **方法一：在设置中配置镜像**
   - 启动应用后进入「设置」→「AI 模型镜像设置」
   - 选择其他镜像源或输入自定义地址
   - 保存后重新启动 AI 索引

2. **方法二：手动下载模型**
   ```powershell
   cd ai-image-manager
   .\scripts\download-model.ps1
   ```

3. **方法三：手动放置模型文件**
   - 从 [hf-mirror.com](https://hf-mirror.com/Xenova/clip-vit-base-patch32/tree/main) 下载模型文件
   - 放置到：`%APPDATA%\AI Image Manager\models\Xenova\clip-vit-base-patch32\`

### 国际用户

应用会自动从 HuggingFace 官方下载模型，首次启动需要稳定的网络连接。

---

## 功能一览

### 核心浏览
- **文件夹就地索引** — 不复制、不移动原始文件
- **瀑布流虚拟滚动** — 10 万+ 图片 60fps 流畅浏览
- **三级缩略图缓存** — 内存 LRU → 磁盘 → 按需生成
- **时间线分组** — 按年/月/日组织照片
- **文件夹树侧边栏** — 拖拽导航、文件夹监听自动同步
- **快速预览 (Space)** — 类 macOS QuickLook
- **全屏灯箱** — 可调间隔的自动幻灯片播放

### AI 搜索
- **自然语言搜索** — 支持中文和英文，如"去年秋天在海边拍的日落"
- **以图搜图** — 拖入参考图找相似照片
- **复合搜索** — 关键词 + 时间范围 + EXIF 条件组合筛选

### EXIF 仪表盘
- 相机/镜头使用频率统计
- 焦段分布直方图
- 光圈/快门/ISO 偏好分析
- 拍摄时间热力图
- 色彩分布分析（色相/饱和度/明度）
- GPS 地点地图

### 智能去重
- pHash 感知哈希快速筛选
- CLIP 向量相似度精排
- 并排对比 + 批量清理

### 标签系统
- **AI 自动标签** — 136 个候选标签，覆盖 9 大类别（场景/人物/动物/物体/活动/光影/风格/色彩/天气）
- **标签层级管理** — 父子标签树形展示
- **手动标签** — 增删改、确认/驳回 AI 建议

### 人脸识别
- ONNX 人脸检测 + 特征提取
- 自动聚类身份
- 身份合并与管理

### 批量处理
- 批量重命名（基于 EXIF 模板）
- 格式转换（WebP/AVIF/JPG/PNG/TIFF）
- 尺寸调整 + 压缩
- 文字水印添加

### 相册
- **智能相册** — 基于规则引擎自动聚合（日期/EXIF/标签/AND/OR）
- **手动相册** — 拖拽排序

### 云端分享
- **WebDAV / S3 兼容** — 配置云存储后一键上传
- **分享页面生成** — 生成独立 HTML 页面，内嵌缩略图 + EXIF + 标签，支持搜索和灯箱浏览

### 系统集成
- 系统托盘驻留 + 右键菜单
- 开机自启动（可选）
- 全局快捷键（Ctrl+Shift+F 搜索、Ctrl+Shift+H 隐藏/显示）
- Windows "发送到" 集成
- 软删除 + 回收站恢复

### 其他
- Light/Dark/System 三档主题，Linear Dark 设计系统
- 中/英文国际化
- 键盘友好操作（按 `?` 查看全部快捷键）

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 41 |
| 前端 | React 19 + TypeScript 6 (strict) |
| 构建 | Vite 8 + Tailwind CSS 4 |
| UI 组件 | shadcn/ui + Radix UI |
| 路由 | TanStack Router (文件路由) |
| IPC | oRPC (类型安全) |
| 状态管理 | TanStack Query |
| 数据库 | better-sqlite3 + Drizzle ORM |
| 图片处理 | sharp |
| AI 推理 | Transformers.js (ONNX Runtime) |
| 向量存储 | LanceDB |
| 测试 | Vitest + Playwright |
| 打包 | Electron Forge + Squirrel (Windows) |

---

## 开发

### 环境要求
- Node.js 22+
- Windows 10/11（目前仅支持 Windows 平台）
- Git

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/Uyoung666/ai-image-manager.git
cd ai-image-manager

# 安装依赖
npm install

# 启动开发模式
npm run dev
```

### 常用命令

```bash
npm run dev           # 启动开发模式（Vite HMR + Electron）
npm run make          # 打包 Windows 安装包
npm run test          # 运行单元测试
npm run test:e2e      # 运行端到端测试
npm run check         # 代码检查
npm run fix           # 自动修复
npm run db:generate   # 生成数据库迁移
npm run db:migrate    # 执行数据库迁移
```

---

## 架构

```
Main Process（主进程）
  ├── 数据库：better-sqlite3 + Drizzle ORM
  ├── 图片处理：sharp
  ├── AI 推理：Transformers.js + LanceDB
  ├── 文件监听：chokidar
  ├── 缩略图：三级缓存（内存 LRU → 磁盘 → 按需）
  └── IPC Server：oRPC MessagePort

AI Workers（独立进程，避免 ONNX/sharp 冲突）
  ├── 嵌入向量生成 (CLIP)
  └── 人脸检测 + 特征提取

Renderer Process（渲染进程）
  ├── React 19 + TanStack Router
  ├── shadcn/ui 组件
  └── oRPC Client（类型安全 IPC 调用）
```

---

## 隐私

- **100% 本地处理** — 图片从不离开你的电脑
- **零数据上传** — 无遥测、无统计、无后台上传
- **云端功能需主动配置** — 上传/分享仅在用户手动配置云存储后才会触发
- **AI 模型本地运行** — CLIP、人脸检测等模型通过 ONNX Runtime 在本地推理

---

## License

MIT © Uyoung

---

## 致谢

本项目基于 [electron-shadcn](https://github.com/LuanRoger/electron-shadcn) 模板搭建。
