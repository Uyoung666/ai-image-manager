import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.0.0",
  date: "2026-08-10",
  title: {
    zh: "把整套照片工作流，放回你的本地图库。",
    en: "A complete photo workflow for your local library.",
  },
  summary: {
    zh: "v2.0.0 是 AI Image Manager 的首个公开基线：从导入、浏览、搜索，到 AI 索引、人物整理、序列管理、选片、清理和分享，所有主要步骤都围绕你现有的 Windows 文件夹展开。标准版模型随包提供，照片索引和 AI 推理默认在本机完成；涉及更新、云存储和诊断提交的网络边界也保持清晰可见。",
    en: "v2.0.0 is AI Image Manager's first public baseline. It brings importing, browsing, search, AI indexing, people organization, sequence management, culling, cleanup, and sharing together around the Windows folders you already use. The standard model set ships with the release, photo indexing and AI inference run locally by default, and the network boundaries for updates, cloud storage, and diagnostics remain explicit.",
  },
  highlights: [
    {
      icon: "image",
      title: {
        zh: "从真实文件夹开始导入，不搬动原始照片",
        en: "Import from real folders without moving originals",
      },
      description: {
        zh: "直接选择或拖入照片文件夹即可开始工作。应用扫描文件、读取 EXIF、生成缩略图并建立增量索引，原始照片仍保留在用户选择的文件夹中；导入和索引在后台执行，期间可以继续浏览已经可用的照片。",
        en: "Choose or drop in a photo folder to begin. The app scans files, reads EXIF, generates thumbnails, and builds an incremental index while originals remain in the folders selected by the user. Import and indexing run in the background, so already available photos can still be browsed while new content is processed.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "覆盖常见照片和相机 RAW 格式",
        en: "Support common photo and camera RAW formats",
      },
      description: {
        zh: "图库支持 JPG、JPEG、PNG、WebP、AVIF、TIFF、TIF、HEIC、HEIF、GIF、BMP、ICO 以及常见相机 RAW 扩展名。RAW 文件的缩略图、预览和 AI 分析主要依赖文件内可用的嵌入 JPEG；如果文件没有可用预览，相关能力可能受限，这不是 RAW 解码能力的固定保证。",
        en: "The library supports JPG, JPEG, PNG, WebP, AVIF, TIFF, TIF, HEIC, HEIF, GIF, BMP, ICO, and common camera RAW extensions. RAW thumbnails, previews, and AI analysis primarily depend on an available embedded JPEG. When a file has no usable preview, those capabilities may be limited; this is not a promise of full RAW decoding for every camera format.",
      },
    },
    {
      icon: "image",
      title: {
        zh: "大图库浏览、灯箱预览与照片详情",
        en: "Large-library browsing, lightbox preview, and photo details",
      },
      description: {
        zh: "使用虚拟化瀑布流、时间分组和真实文件夹树浏览图库；通过详情面板查看原始路径、EXIF、标签、地点和收藏状态。支持单选、多选、框选、范围选择、滚动位置恢复、Space 快速预览、双击灯箱、全屏、缩放、平移、旋转、幻灯片和缩略图导航，浏览与整理不必在多个工具之间来回切换。",
        en: "Explore the library with a virtualized masonry grid, time grouping, and the real folder tree. The details panel exposes the original path, EXIF, tags, location, and favorite state. Single selection, multi-selection, box and range selection, scroll-position restoration, Space quick preview, double-click lightbox, fullscreen, zoom, pan, rotation, slideshow, and thumbnail navigation keep browsing and organizing in one place.",
      },
    },
    {
      icon: "search",
      title: {
        zh: "自然语言、以图搜图和文件名搜索并行工作",
        en: "Use language, image search, and filename search together",
      },
      description: {
        zh: "支持中文和英文语义搜索、以图搜图、文件名通配符，以及日期、相机、镜头、焦距、光圈、ISO、格式和标签的组合筛选。`Ctrl+K` 打开全局搜索，可查找照片、标签、相册、人物、设置和页面导航；AI 索引尚未完成时，文件名、标签、人物和 EXIF 检索仍然可用。",
        en: "Use Chinese and English semantic search, image-to-image search, filename wildcards, and combined filters for date, camera, lens, focal length, aperture, ISO, format, and tags. Press `Ctrl+K` to search photos, tags, albums, people, settings, and navigation. Filename, tag, people, and EXIF search remain available while AI indexing is still incomplete.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "标准版 SigLIP：图像与文本进入同一向量空间",
        en: "Standard SigLIP: image and text in one vector space",
      },
      description: {
        zh: "标准版使用 SigLIP Base Patch16-224 生成图像和文本嵌入，输出 768 维、L2 归一化向量，用于语义搜索、以图搜图、AI 标签建议和视觉相似候选分组。它负责图像/文本相似度，不负责图片生成、修图、OCR 或人脸识别；OPUS-MT Chinese to English 在本地把中文查询转换为英文后交给 SigLIP，它不是通用翻译服务。索引任务支持查看进度、暂停、恢复、取消和增量处理新照片。",
        en: "The standard build uses SigLIP Base Patch16-224 for image and text embeddings in a shared 768-dimensional, L2-normalized vector space. It powers semantic search, image-to-image search, AI tag suggestions, and visual-similarity candidate groups. It does not generate or edit images, perform OCR, or recognize faces. OPUS-MT Chinese to English locally translates Chinese queries before SigLIP text embedding; it is not a general translation service. Indexing exposes progress and supports pause, resume, cancellation, and incremental processing of new photos.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "YuNet + SFace：本地人物识别与聚类",
        en: "YuNet + SFace: local people detection and clustering",
      },
      description: {
        zh: "YuNet 在本机负责检测人脸并定位五点关键点，SFace 负责生成 128 维人脸特征；两者共同支持人物聚类、命名、合并、隐藏、拆分和重新聚类。结果会受到光线、角度、遮挡、脸部大小和图像质量影响，人物聚类是辅助整理结果，命名、合并和批量清理前应由用户复核。",
        en: "YuNet detects faces and five facial landmarks locally, while SFace produces 128-dimensional face features. Together they support people clustering, naming, merging, hiding, splitting, and reclustering. Results are affected by lighting, angle, occlusion, face size, and image quality. People clustering is an organizational aid, so review it before naming, merging, or performing batch cleanup.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "语义标签建议与人工整理保持分开",
        en: "Keep semantic tag suggestions separate from manual organization",
      },
      description: {
        zh: "SigLIP 可为照片提供语义标签建议，用户可以结合自己的标签树、父子标签层级和图库上下文进行采纳或调整。AI 标签、人物聚类和视觉相似分组都属于辅助结果，不会替代人工判断，也不会因为模型给出建议就自动把不确定内容当作事实。当前标准版不开放外部模型导入或运行时切换。",
        en: "SigLIP can suggest semantic tags for photos, while users remain in control of accepting or adjusting those suggestions within their own tag tree and parent-child hierarchy. AI tags, people clusters, and visual-similarity groups are assistive results, not replacements for human review, and uncertain suggestions are not silently treated as facts. The standard build does not expose external model import or runtime switching.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "相册、智能相册、连拍和延时序列",
        en: "Albums, smart albums, bursts, and timelapse sequences",
      },
      description: {
        zh: "普通相册支持手动添加、移除和设置封面；智能相册可按日期、相机、镜头、标签、焦距、光圈、ISO 和格式等规则匹配。应用可识别连拍和延时摄影序列，并按严格、平衡、宽松或自定义规则分组；进入序列后可浏览、播放、选择代表帧、调整顺序和拆分序列，便于把拍摄时形成的组重新整理成可用内容。",
        en: "Regular albums support manual adding, removal, and cover selection. Smart albums match rules such as date, camera, lens, tags, focal length, aperture, ISO, and format. The app can identify burst and timelapse sequences using strict, balanced, relaxed, or custom rules; inside a sequence, browse or play frames, choose a representative photo, reorder them, or split the sequence so groups created during shooting become easier to manage.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "漫游、仪表盘与专业选片连接发现和决策",
        en: "Wander, dashboards, and professional culling connect discovery and decisions",
      },
      description: {
        zh: "漫游模式可在应用空闲时通过时间胶囊、主题放映或图库遗珠重新发现照片，并可将一轮漫游保存为相册。仪表盘按概览、器材、曝光、拍摄技术、时间、地点和色彩展示统计，支持全部、今年、近 12 个月和自定义日期范围，并可从图表钻取回照片。PK / Duel 逐对比较并使用 Elo 评分排序；Curate 逐张决定保留、淘汰或跳过相似项，结果支持排名、Top-N、多选、加入相册、导出和移入回收站。",
        en: "Wander resurfaces photos during idle time through time capsules, themed playback, or library discoveries, and a session can be saved as an album. The dashboard summarizes the library by overview, equipment, exposure, photographic technique, time, location, and color. It supports all-time, this-year, last-12-months, and custom date ranges, with drill-down from charts back to photos. PK / Duel compares pairs and ranks them with Elo; Curate makes keep, reject, or skip-similar decisions one photo at a time. Results support ranking, Top-N selection, multi-selection, album membership, export, and trash actions.",
      },
    },
    {
      icon: "search",
      title: {
        zh: "重复检测区分相同、视觉相同和视觉相似",
        en: "Distinguish exact, visually identical, and visually similar photos",
      },
      description: {
        zh: "重复检测结合文件哈希、感知哈希和 AI 向量，将候选项区分为文件内容完全相同、视觉上相同和视觉上相似的组。视觉相似不等于文件重复，也不等于照片应该删除；清理前应比较清晰度、EXIF、构图、用途和备份状态，确认保留项后再进行批量操作。",
        en: "Duplicate detection combines file hashes, perceptual hashes, and AI vectors to separate exact file duplicates, visually identical candidates, and visually similar groups. Visual similarity is not proof of a duplicate and does not mean a photo should be deleted. Before cleanup, compare sharpness, EXIF, composition, intended use, and backup status, then choose keepers before applying batch actions.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "批量处理、ZIP 导出和 HTML 分享",
        en: "Batch operations, ZIP export, and HTML sharing",
      },
      description: {
        zh: "多选后可批量收藏、加标签、加入相册、重命名、格式转换、压缩和添加文字或图片水印。可将原图或压缩版本导出为 ZIP，也可生成包含缩略图、EXIF 和标签的 HTML 分享页；导出前可以检查选择范围和输出设置，避免把不应分享的原始信息一起带出。",
        en: "After selecting multiple photos, batch favorite, tag, add to albums, rename, convert formats, compress, or apply text and image watermarks. Export originals or compressed copies as a ZIP, or generate an HTML share page with thumbnails, EXIF, and tags. Review the selection scope and output settings before exporting so private originals or metadata are not shared unintentionally.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "WebDAV/S3、回收站、诊断与模型许可边界",
        en: "Clear boundaries for WebDAV/S3, trash, diagnostics, and model licenses",
      },
      description: {
        zh: "WebDAV 与 Amazon S3 / S3 兼容存储需要用户自行配置，只有主动上传或发布分享页时才发送内容，保存配置不会自动上传图库。应用内删除默认进入 30 天回收站，可恢复、提前移入 Windows 系统回收站或清空。照片扫描、缩略图、EXIF、向量、人物特征和搜索处理默认在本机完成，不会自动上传照片内容；自动更新或模型恢复可能访问相应服务。诊断包默认在本地生成并脱敏，不包含照片、数据库、EXIF、人脸/向量数据、搜索词或云凭据，只有用户主动导出或提交时才离开设备。标准安装包包含 SigLIP、OPUS-MT、YuNet 和 SFace 模型，许可证分别为 Apache License 2.0、CC BY 4.0、MIT 和 Apache License 2.0；当前仅保留适配器扩展基础设施，不提供外部模型导入、切换、运行时下载或把自定义模型放入安装目录即用的入口。",
        en: "WebDAV and Amazon S3 / S3-compatible storage require user configuration; content is sent only when the user initiates an upload or publishes a share page, and saving a configuration does not upload the library. App deletion first moves items to a 30-day in-app trash, where they can be restored, moved to the Windows recycle bin early, or emptied. Photo scanning, thumbnails, EXIF, vectors, face features, and search processing run locally by default, with no automatic photo upload; automatic updates or model recovery may contact their services. Diagnostic bundles are generated locally and redacted by default, excluding photos, databases, EXIF, face/vector data, search terms, and cloud credentials; they leave the device only when the user exports or submits them. The standard installer includes SigLIP, OPUS-MT, YuNet, and SFace under Apache License 2.0, CC BY 4.0, MIT, and Apache License 2.0 respectively. v2.0.0 keeps adapter infrastructure for future extension, but provides no product entry for external model import, switching, runtime downloads, or using a custom model simply by placing files in the installation directory.",
      },
    },
  ],
};

export default changelog;
