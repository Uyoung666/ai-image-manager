# AI Image Manager v2.0.0

## 首版发布说明 / First Public Release Line

v2.0.0 是 AI Image Manager 当前产品线的全新公开起点。本文只说明 v2.0.0 的实际能力、使用边界和已记录的性能观测，不提供历史版本对比，也不对历史版本作升级兼容或数据格式承诺。

v2.0.0 is the new public starting point for the current AI Image Manager product line. These notes describe the actual capabilities, boundaries, and recorded performance observation of v2.0.0 only. They do not compare historical releases or promise upgrade and data-format compatibility with them.

## 版本亮点 / Highlights

- **本地优先的图库工作流 / Local-first library workflow**：就地索引现有照片文件夹，在本机生成缩略图、EXIF、AI 向量和人物特征，不要求迁移原始照片。
- **AI 搜索 / AI search**：支持中文和英文自然语言搜索、以图搜图、文件名通配符、EXIF 筛选和 `Ctrl+K` 全局搜索。
- **智能整理 / Smart organization**：支持 AI 标签建议、人物检测与聚类、普通相册、智能相册、连拍/延时序列识别和漫游。
- **专业选片 / Professional culling**：提供 PK / Duel 两两比较、Curate 逐张甄选、Elo 排名、Top-N 结果处理和批量导出。
- **图库清理与分析 / Library cleanup and analysis**：支持完全重复、视觉相同和视觉相似照片检测，以及可下钻的 EXIF、器材、曝光、时间、地点和色彩仪表盘。
- **输出与分享 / Output and sharing**：支持批量重命名、格式转换、ZIP 导出、HTML 分享页和文字/图片水印。
- **可选云存储 / Optional cloud storage**：支持 WebDAV 和 Amazon S3 / S3 兼容存储的用户主动上传与分享。
- **Windows 集成 / Windows integration**：支持托盘、开机启动、全局快捷键、Windows Send To 和应用内更新管理。

## 隐私与网络边界 / Privacy and Network Boundaries

v2.0.0 的照片管理和 AI 处理默认在本机完成。应用不会自动上传照片内容；照片、数据库、EXIF、人脸/向量数据和搜索词不会作为诊断包内容。

Photo management and AI processing run locally by default in v2.0.0. The app does not automatically upload photo content, and photos, databases, EXIF, face/vector data, and search terms are not included in diagnostic bundles.

以下场景可能产生网络访问：

The following scenarios may access the network:

- 启用自动更新或手动检查更新 / Automatic updates or manual update checks.
- 模型缺失或校验失败后的恢复获取 / Model recovery after missing or failed verification.
- 用户配置 WebDAV/S3 后主动上传照片或分享页面 / User-configured and user-initiated WebDAV/S3 uploads or share publication.
- 用户主动打开反馈页面并提交诊断包 / User-initiated feedback submission with an attached diagnostic bundle.

诊断包默认在本地生成并严格脱敏，只有用户主动导出或附加到 Issue 时才会离开设备。原生崩溃转储默认关闭。

Diagnostic bundles are created locally and strictly redacted by default. They leave the device only when the user exports them or attaches them to an Issue. Native crash dumps are disabled by default.

## 性能观测 / Performance Observation

当前版本已记录以下实际观测值：

The current release has the following recorded observations:

| 工作量 / Workload | 导入 / Import | AI 嵌入 / AI embedding | 总耗时 / Total |
| ---: | ---: | ---: | ---: |
| 1,000 张照片 / 1,000 photos | 30 秒 / 30 seconds | 32 秒 / 32 seconds | **62 秒 / 62 seconds** |
| 单日 10,000 张 JPG / 10,000 JPG photos in one day | 约 340 秒 / about 340 seconds | 约 746 秒 / about 746 seconds | **约 1,086 秒 / about 1,086 seconds** |

单日 10,000 张观测包含导入、缩略图/EXIF/哈希准备和 SigLIP 嵌入，测试后的派生数据已清理。该结果仅作为 v2.0.0 的一次性能观测，不代表所有设备、图片类型或图库规模，也不承诺固定耗时。

The one-day 10,000-photo observation included import, thumbnail/EXIF/hash preparation, and SigLIP embedding; derived test data was removed afterward. It is a single v2.0.0 observation, not a guarantee for every computer, image type, or library size.

## 使用与兼容性说明 / Usage and Compatibility Notes

- 支持 Windows 10 / 11 64 位 / Windows 10 or 11, 64-bit.
- 安装版适合长期使用，便携版可解压运行 / Installer and portable builds are available.
- 发布包包含当前版本所需 AI 模型 / Required AI model assets are included in the release package.
- DirectML GPU 加速为可选能力，失败时自动回退 CPU / DirectML GPU acceleration is optional, with CPU fallback on failure.
- RAW 预览主要依赖文件内嵌 JPEG / RAW previews primarily depend on embedded JPEG previews.
- 视觉相似不等于文件重复；清理前应人工确认 / Visual similarity is not proof of a duplicate; review before cleanup.
- 应用回收站默认保留 30 天，之后移动到 Windows 系统回收站 / The app trash keeps items for 30 days before moving them to the Windows system recycle bin.

## 已知限制 / Known Limitations

- AI 搜索、以图搜图和视觉重复检测需要相应索引完成。
- 人物聚类、AI 标签和视觉相似分组属于辅助结果，建议人工复核。
- RAW 文件没有可用内嵌预览时，预览和 AI 分析能力可能受限。
- 性能会因 CPU、GPU、磁盘、图片格式、分辨率和系统负载发生变化。
- 云存储的权限、访问控制、可用性和隐私政策由用户选择的服务提供商负责。

The corresponding limitations are:

- AI search, image search, and visual duplicate detection require their indexes to be ready.
- People clustering, AI tags, and visual-similarity groups are assistive results and should be reviewed.
- RAW files without a usable embedded preview may have limited preview and AI support.
- Performance varies with CPU, GPU, storage, image format, resolution, and system load.
- Cloud-provider permissions, access controls, availability, and privacy terms are controlled by the selected provider.

## 模型与第三方许可 / Models and Third-Party Licenses

当前发布包包含以下本地模型资产。它们的职责彼此独立：

| 模型 / Model | 能力 / Capability | 边界 / Boundary |
| --- | --- | --- |
| **SigLIP Base Patch16-224** | 图像和文本嵌入；文本搜图、以图搜图、AI 标签建议、视觉重复检测 / Image and text embeddings; text-to-image search, image-to-image search, AI tag suggestions, and visual duplicate detection | 不负责生成、修图、OCR 或人脸识别 / Not for generation, editing, OCR, or face recognition |
| **OPUS-MT Chinese to English** | 本地将中文查询翻译为英文，接入 SigLIP 文本搜图 / Locally translates Chinese queries to English before SigLIP text search | 不负责图像或人脸特征，也不是通用翻译服务 / Not for image or face features, and not a general-purpose translation service |
| **YuNet** | 本地人脸检测和 5 点关键点定位 / Local face detection and five-point facial landmarks | 不判断人物身份，不负责语义搜索 / Does not identify people or provide semantic search |
| **SFace** | 本地 128 维人脸特征嵌入，用于相似度和人物聚类 / Local 128-dimensional face embeddings for similarity and people clustering | 不负责人脸检测或通用图像嵌入 / Does not detect faces or provide general image embeddings |

The release package includes these local models with separate responsibilities. Full sources, versions, purposes, copyright, and license information are available in:

- [第三方模型声明 / Third-party model notices](THIRD_PARTY_MODEL_NOTICES.md)
- [`licenses/`](licenses)

## 下载与反馈 / Download and Feedback

- [下载 v2.0.0 / Download v2.0.0](https://github.com/Uyoung666/ai-image-manager/releases/latest)
- [中文 README](README.md)
- [English README](README.en.md)
- [中文使用指南 / Chinese User Guide](GUIDE.md)
- [English User Guide](GUIDE.en.md)
- [提交问题 / Report an issue](https://github.com/Uyoung666/ai-image-manager/issues)

报告问题时，请优先从 **设置 → 帮助与诊断** 生成并检查脱敏诊断包。请勿公开私密照片、GPS 信息、云端密码或访问密钥。

When reporting a problem, use **Settings → Help & Diagnostics** to create and inspect a redacted diagnostic bundle first. Do not publish private photos, GPS data, cloud passwords, or access keys.
