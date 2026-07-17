# AI Image Manager

<div align="center">

**面向 Windows 的本地优先 AI 图片管理工具**

无需上传照片，即可完成就地索引、自然语言搜索、人物整理、智能选片、重复检测与专业影像分析。

[![Latest Release](https://img.shields.io/github/v/release/Uyoung666/ai-image-manager?display_name=tag&style=flat-square)](https://github.com/Uyoung666/ai-image-manager/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?style=flat-square&logo=windows11&logoColor=white)](#系统要求)
[![License](https://img.shields.io/github/license/Uyoung666/ai-image-manager?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-41-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)

[官方网站](https://ai-image-manager.uyoungvision.cn) · [下载最新版本](https://github.com/Uyoung666/ai-image-manager/releases/latest) · [使用指南](GUIDE.md) · [English](README.en.md)

</div>

---

## 项目简介

AI Image Manager 为本地照片库提供从导入、检索、整理到筛选和分享的一体化工作流。应用直接索引原始文件夹，不要求迁移照片；缩略图、元数据、向量索引和 AI 推理均保存在本机。

核心图片管理与 AI 能力可离线使用。只有在用户主动配置 WebDAV 或 S3 并执行上传、分享操作时，数据才会发送至相应的云存储服务。

![AI Image Manager 首页](screenshots/01-home.png)

## 为什么选择 AI Image Manager

- **本地优先**：照片、EXIF、向量索引和人脸特征默认不离开设备，无遥测与后台上传。
- **理解图片内容**：使用中英文自然语言描述画面，也可通过参考图片查找视觉相似内容。
- **覆盖摄影工作流**：从快速浏览、批量整理到 PK 选片、EXIF 分析和导出分享集中完成。
- **适合大型图库**：虚拟化瀑布流、增量索引与独立 AI Worker 面向大规模照片库设计。
- **兼容常用与 RAW 格式**：支持 JPEG、PNG、WebP、AVIF、HEIC、TIFF、GIF、BMP 及主流相机 RAW 文件。

## 快速开始

### 下载与安装

前往 [GitHub Releases](https://github.com/Uyoung666/ai-image-manager/releases/latest) 获取最新版本：

- **安装版（推荐）**：提供系统安装、快捷方式和自动更新。
- **便携版**：解压后直接运行，适合免安装场景。

首次启动时，向导会协助完成数据目录、DirectML GPU 加速和界面语言设置。安装包已包含 AI 模型，无需在首次使用时额外下载。

> 完整操作说明、快捷键与常见问题请参阅 [《使用指南》](GUIDE.md)。

### 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（64 位） |
| 处理器 | x64 处理器 |
| 内存 | 建议 8 GB 及以上；大型图库建议 16 GB 及以上 |
| 存储 | 建议使用 SSD，并为缩略图、索引和 AI 模型预留空间 |
| GPU | 可选；兼容 DirectML 时可加速人脸检测，不支持时自动回退 CPU |

## 核心能力

### AI 检索与智能整理

- 中英文自然语言语义搜索，例如“去年秋天在海边拍的日落”
- 以图搜图、文件名通配符搜索，以及时间、标签、EXIF 组合筛选
- `Ctrl+K` 全局聚光灯搜索，覆盖照片、标签、相册、人物和页面导航
- AI 自动标签与基于日期、EXIF、标签、AND/OR 规则的智能相册

### 高效浏览与照片管理

- 虚拟化瀑布流、时间线分组和层级文件夹树
- 快速预览、全屏灯箱、幻灯片、EXIF 详情与滚动位置恢复
- 拖放导入、框选、多选、收藏、批量重命名、格式转换、缩放和水印
- 软删除与 30 天回收站，支持恢复和集中清理

| 快速预览 | 照片详情 |
| :---: | :---: |
| ![快速预览](screenshots/04-lightbox-preview.png) | ![EXIF 详情](screenshots/05-photo-detail.png) |

### 专业选片

- **PK 模式**：使用 Elo 评分进行两两对比，提供快速、标准和精细三种强度
- **甄选模式**：通过键盘快速完成单张照片的保留、淘汰与跳过
- **结果视图**：按评分查看排序，支持 Top-N、多选、加入相册和批量导出

| PK 对比 | 甄选模式 | 排名结果 |
| :---: | :---: | :---: |
| ![PK 对比](screenshots/11-culling-pk.png) | ![甄选模式](screenshots/12-culling-curate.png) | ![选片结果](screenshots/13-culling-result.png) |

### 人物、重复照片与影像分析

- ONNX 人脸检测与特征提取，自动聚类人物并支持重命名、合并和拆分
- DirectML GPU 加速与 CPU 自动回退；RAW 文件可通过内嵌预览参与处理
- pHash 预筛选结合 CLIP 相似度排序，辅助批量处理重复或高度相似照片
- EXIF 仪表盘展示相机、镜头、焦段、光圈、快门、ISO、拍摄时间、色彩和 GPS 分布
- 图表支持下钻，可直接跳转到符合条件的照片

| 人物整理 | 重复检测 | 数据仪表盘 |
| :---: | :---: | :---: |
| ![人物识别](screenshots/06-face-detection.png) | ![重复照片检测](screenshots/03-duplicate-detection.png) | ![数据仪表盘](screenshots/07-dashboard.png) |

### 导出、分享与系统集成

- 批量导出原图或压缩后的 ZIP 文件
- 生成包含缩略图、EXIF 和标签的独立 HTML 分享页
- 按需配置 WebDAV 或 S3 兼容存储，手动上传照片和分享页面
- 支持系统托盘、开机自启、全局快捷键和 Windows“发送到”集成

## 工作方式

```text
本地照片文件夹
      │
      ├── 扫描与增量监听 ──► SQLite 元数据 / EXIF
      ├── 缩略图与感知哈希 ─► 浏览、预览与重复检测
      └── AI Worker ───────► CLIP 向量 / 人脸特征 ─► LanceDB
                                      │
                                      └── 语义搜索、以图搜图、人物聚类
```

应用不会复制或接管原始照片库。索引器读取用户选择的文件夹，并将派生数据写入可配置的应用数据目录；后续文件变化通过增量监听同步到索引。

## 支持的图片格式

| 类型 | 格式 |
| --- | --- |
| 常用格式 | JPEG、PNG、WebP、AVIF、TIFF、HEIC / HEIF、GIF、BMP、ICO |
| 相机 RAW | CR2、CR3、NEF、NRW、ARW、SRF、SR2、DNG、ORF、RW2、RAF、PEF、RWL、3FR、RAW |

RAW 文件主要通过提取内嵌 JPEG 预览完成缩略图、预览和 AI 分析；具体效果取决于相机文件是否包含可用预览。

## 性能参考

以下数据来自 Windows 11、Ryzen 7、16 GB 内存、NVMe SSD 与量化 CLIP ViT-B/32 模型环境，仅用于说明量级；实际耗时会受图片格式、分辨率、磁盘性能和硬件配置影响。

| 照片数量 | 扫描、EXIF 与缩略图 | AI 向量嵌入 | 总耗时 |
| ---: | ---: | ---: | ---: |
| 1,000 | 约 1 分钟 | 约 1.5 分钟 | **约 2.5 分钟** |
| 10,000 | 约 7 分钟 | 约 15 分钟 | **约 22 分钟** |
| 100,000 | 约 70 分钟 | 约 40 分钟 | **约 1.8 小时** |

首次全量索引完成后，日常新增或变更照片采用增量处理。

## 本地开发

### 环境准备

- Windows 10 / 11
- [Node.js 22](https://nodejs.org/)（与 CI 环境保持一致）
- npm
- 原生依赖编译所需的 Windows C++ 构建环境

### 启动项目

```bash
git clone https://github.com/Uyoung666/ai-image-manager.git
cd ai-image-manager
npm ci
npm run dev
```

`npm ci` 完成后会为 Electron 重建 `better-sqlite3`、LanceDB 和 Transformers.js 等原生依赖。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Electron 开发环境与 Vite 热更新 |
| `npm test` | 单次运行 Vitest 测试 |
| `npm run test:e2e` | 运行 Playwright E2E 测试 |
| `npm run check` | 检查格式与 lint 规则 |
| `npm run fix` | 应用安全的自动格式化与修复 |
| `npm run make` | 构建 Windows 分发包 |
| `npm run db:generate` | 生成 Drizzle 数据库迁移 |
| `npm run db:migrate` | 应用待执行的数据库迁移 |

## 技术架构

| 层级 | 主要技术 |
| --- | --- |
| 桌面运行时 | Electron 41、Electron Forge |
| 渲染进程 | React 19、TypeScript、TanStack Router / Query |
| UI 与样式 | Tailwind CSS 4、shadcn/ui、Radix UI |
| 类型化通信 | oRPC |
| 数据与索引 | SQLite、better-sqlite3、Drizzle ORM、LanceDB |
| 图片与元数据 | sharp、ExifTool、exifr |
| AI 推理 | Transformers.js、ONNX Runtime、DirectML |
| 工程与测试 | Vite 8、Vitest、Playwright、Biome / Ultracite |

主要目录：

```text
src/
├── routes/       # React 页面与路由
├── components/   # UI 组件
├── actions/      # 渲染进程 IPC 封装
├── ipc/          # 类型化 IPC 路由与处理器
├── services/     # 索引、缩略图、AI、人脸、云同步等服务
├── db/           # 数据库 schema 与访问层
└── tests/        # 单元、集成与 E2E 测试
```

## 隐私说明

AI Image Manager 的核心工作流默认在本地完成：不包含遥测、行为分析或未经用户操作的照片上传。若启用云端分享，应用只会在用户配置服务并明确触发上传后，与指定的 WebDAV 或 S3 服务通信。云服务的可用性、权限和隐私政策由对应服务提供方决定。

## 相关文档

- [中文使用指南](GUIDE.md)
- [English User Guide](GUIDE.en.md)
- [English README](README.en.md)
- [版本发布与下载](https://github.com/Uyoung666/ai-image-manager/releases)

## 许可证

本项目基于 [MIT License](LICENSE) 发布，Copyright © Uyoung。

项目初始模板基于 [electron-shadcn](https://github.com/LuanRoger/electron-shadcn)。
