import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock electron globally — CI installs with --ignore-scripts (no Electron binary),
// and any module that transitively imports electron will crash if the real module
// is loaded. This mock must be in setup so it intercepts all import chains before
// any test file's transitive dependencies can trigger a real electron require.
vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getLocale: () => "zh-CN",
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

// Mock react-i18next to avoid the need for full i18n initialization in tests
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        appName: "AI 图片管理器",
        sidebarAllPhotos: "全部照片",
        sidebarAddFolder: "添加文件夹",
        sidebarFolders: "文件夹",
        sidebarNoFolders: "尚未添加文件夹",
        customizeFolderAppearance: "自定义外观",
        folderAppearanceTitle: "自定义文件夹外观",
        folderAppearanceDescription: "为文件夹选择易于识别的图标和颜色。",
        folderAppearancePreview: "侧栏预览",
        folderAppearanceIcon: "图标",
        folderAppearanceInitial: "使用名称首字",
        folderAppearanceIconOption: "使用 {{icon}} 图标",
        folderAppearanceColor: "颜色",
        folderAppearanceInvalidColor: "请输入 #RRGGBB 格式的颜色。",
        folderAppearanceReset: "恢复自动样式",
        folderAppearanceSaved: "文件夹外观已保存",
        folderAppearanceSaveFailed: "保存文件夹外观失败",
        rightClickFolderActions: "右键管理文件夹",
        sidebarDashboard: "仪表盘",
        sidebarSettings: "设置",
        searchPlaceholder: "试试搜索“去年秋天的红叶”",
        searchModeImage: "以图搜图",
        imageSearchTitle: "以图搜图 — 选择参考图片寻找相似照片",
        imageSearchToken: "[以图搜图]",
        searchSuggestions: "搜索建议",
        recentSearches: "最近搜索",
        clearAll: "清除全部",
        searchStarterTitle: "试试这样搜索",
        searchStarterDescription: "直接描述画面、场景或拍摄时间",
        searchStarterWildcardHint: "也支持文件名和通配符，例如 *.jpg、DSC_*",
        searchStarterAiUnavailable: "请先完成 AI 索引，再使用语义搜索示例",
        searchExampleAutumnLeaves: "去年秋天的红叶",
        searchExampleSeasideSunset: "海边的日落",
        searchExampleCuteCat: "可爱的猫咪",
        searchExampleNightCity: "夜晚的城市街道",
        photosCount: "{{count}} 张照片",
        photosSelected: " · {{count}} 张已选",
        scanningComplete: "扫描完成，共索引 {{count}} 张照片",
        scanningSkipped:
          "扫描完成，共索引 {{count}} 张照片，{{skipped}} 个文件被跳过（非有效图片）",
        scanningPath: "路径: {{path}}",
        noPhotos: "还没有照片，请先添加文件夹",
        photoDetail: "照片详情",
        photoInfo: "基本信息",
        exifInfo: "EXIF 信息",
        camera: "相机",
        lens: "镜头",
        focalLength: "焦段",
        aperture: "光圈",
        shutter: "快门",
        iso: "ISO",
        dateTaken: "拍摄日期",
        dimensions: "尺寸",
        fileSize: "文件大小",
        filePath: "文件路径",
        noExifData: "无 EXIF 数据",
        openInExplorer: "在资源管理器中打开",
        dashboardTitle: "数据仪表盘",
        totalPhotos: "照片总数",
        aiProcessed: "AI 已处理",
        dateRange: "日期范围",
        avgIso: "平均 ISO",
        cameraUsage: "相机使用统计",
        focalDistribution: "焦段分布",
        noCameraData: "暂无相机数据",
        noFocalData: "暂无焦段信息",
        shutterDistribution: "快门速度分布",
        yearlyDistribution: "年度拍摄趋势",
        monthlyDistribution: "月度拍摄分布",
        geoMap: "拍摄地点分布",
        noGeoData: "暂无 GPS 地理数据",
        settingsTitle: "设置",
        sidebarTags: "标签",
        tagSearchPlaceholder: "搜索标签...",
        tagBatchGenerate: "批量生成 AI 标签",
        tagWaitingForIndex: "AI 索引完成后将自动生成标签",
        tagGeneratingProgress: "正在生成 AI 标签 {{processed}}/{{total}}",
        tagUpdating: "正在为新照片更新标签…",
        tagAnalysisIndexing: "AI 索引中，完成后可分析",
        tagAnalysisRunning: "正在自动分析此照片",
        tagAnalysisBusy: "AI 标签任务正在运行，完成后可分析",
        tagDropHint: "松手添加",
        tagDeleteTitle: "删除标签",
        tagDeleteDescription: "确定要删除标签「{{name}}」吗？该操作不可撤销。",
        tagCreateChild: "创建子标签",
        toastUndo: "撤销",
        toastFavoriteAdded: "已收藏",
        toastFavoriteRemoved: "已取消收藏",
        toastFavoriteAddedCount: "已收藏 {{count}} 张",
        toastPhotosIndexed: "已索引 {{count}} 张照片",
        toastPhotosIndexedSkipped:
          "已索引 {{count}} 张照片，跳过 {{skipped}} 张",
        toastImportQueued: "已加入后台导入队列，请留意顶部状态栏",
        toastImportQueuedMultiple: "已加入 {{count}} 个文件夹到后台队列",
        semanticSearchPartial:
          "AI 已索引 {{indexed}}/{{total}} 张照片，当前结果可能不完整；索引完成后将自动刷新。",
        semanticSearchUnavailable:
          "AI 语义搜索暂不可用，当前仅显示文件名、标签和人名匹配。",
        toastScanFolderFailed: "扫描文件夹失败",
        toastFolderRemoved: "已移除文件夹",
        toastDeleteFolderFailed: "删除文件夹失败",
        toastSearchFailed: "搜索失败",
        toastDeletedCount: "已删除 {{count}} 张照片",
        toastDeleteFailed: "删除照片失败",
        toastRenameCount: "已重命名 {{count}} 张照片",
        toastRenamePartial: "已重命名 {{count}} 张，{{errors}} 张失败",
        toastRenameFailed: "重命名失败",
        toastConvertedCount: "已转换 {{count}} 张照片",
        toastConvertFailed: "格式转换失败",
        toastImageSearchFailed: "以图搜图失败",
        toastAddToAlbumSuccess: "已添加 {{count}} 张照片到「{{album}}」",
        toastAddFailed: "添加失败",
        emptySearchTitle: "未找到匹配的照片",
        emptySearchDescription: "试试换个关键词，或使用 EXIF 筛选器缩小范围",
        emptyFavoritesTitle: "还没有收藏的照片",
        emptyFavoritesDescription:
          "浏览照片时点击星标即可收藏，收藏的照片会出现在这里",
        albumAddTitle: "添加到相册",
        albumNoAlbumsCreate: "还没有相册，创建一个吧",
        albumNamePlaceholder: "相册名称...",
        albumCreate: "创建",
        albumNew: "新建相册",
        confirmDeleteTitle: "确认删除",
        confirmDeleteAction: "删除",
        confirmDeleteDescription:
          "将{{target}}移到系统回收站，可从回收站恢复。",
        confirmDeleteTargetPhoto: "该照片",
        confirmDeleteTargetPhotos: " {{count}} 张照片",
        done: "完成",
        close: "关闭",
        save: "保存",
        saving: "保存中...",
        test: "测试",
        loading: "加载中…",
        backToHome: "返回主页",
      };
      const translated = translations[key];
      if (!translated) {
        return key;
      }
      if (options) {
        return Object.entries(options).reduce(
          (text, [name, value]) =>
            text.replace(new RegExp(`{{${name}}}`, "g"), String(value)),
          translated
        );
      }
      return translated;
    },
    i18n: {
      changeLanguage: () => new Promise(() => {}),
      language: "zh",
    },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
