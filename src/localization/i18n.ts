import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  fallbackLng: "zh",
  lng: "zh",
  resources: {
    zh: {
      translation: {
        appName: "AI 图片管理器",
        titleHomePage: "照片浏览",
        titleDashboard: "仪表盘",
        titleSettings: "设置",

        // Sidebar
        sidebarAllPhotos: "全部照片",
        sidebarAddFolder: "添加文件夹",
        sidebarAiIndex: "AI 智能索引",
        sidebarFolders: "文件夹",
        sidebarNoFolders: "尚未添加文件夹",
        sidebarDashboard: "仪表盘",
        sidebarSettings: "设置",

        // Search
        searchPlaceholder: "搜索照片… (例如: 去年秋天的红叶)",
        searchShortcut: "Ctrl+K",

        // PhotoGrid
        photosCount: "{{count}} 张照片",
        photosSelected: " · {{count}} 张已选",
        noPhotos: "还没有照片，请先添加文件夹",
        loadingPhotos: "正在加载照片…",

        // Welcome / Onboarding
        welcomeTitle: "欢迎使用 AI 图片管理器",
        welcomeStep1: "1. 点击左侧「添加文件夹」选择你的照片目录",
        welcomeStep2: "2. 等待扫描完成，照片将出现在这里",
        welcomeStep3: "3. 点击「AI 智能索引」启用自然语言搜索",
        welcomeTip: "💡 提示: 所有处理都在本地完成，不会上传任何数据",

        // Folder scanning
        scanningTitle: "正在扫描文件夹",
        scanningPath: "路径: {{path}}",
        scanningProgress: "已扫描 {{scanned}} / {{total}} 张",
        scanningComplete: "扫描完成，共索引 {{count}} 张照片",
        aiIndexingStarted: "AI 索引已启动...",
        aiIndexedCount: "已 AI 索引 {{count}} 张照片",

        // Photo detail
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

        // Dashboard
        dashboardTitle: "数据仪表盘",
        totalPhotos: "照片总数",
        aiProcessed: "AI 已处理",
        dateRange: "日期范围",
        avgIso: "平均 ISO",
        cameraUsage: "相机使用统计",
        focalDistribution: "焦段分布",
        noCameraData: "暂无相机数据，请先索引带有 EXIF 信息的照片",
        noFocalData: "暂无焦段信息",

        // Settings
        settingsTitle: "设置",
        settingsAppearance: "外观",
        settingsTheme: "主题",
        settingsLanguage: "语言",
        settingsIndexing: "索引",
        settingsThumbnailCache: "缩略图缓存",
        settingsThumbnailCacheHint: "清除缓存以释放磁盘空间",
        settingsClear: "清除",
        settingsClearing: "清除中...",
        settingsCleared: "缓存已清除!",
        settingsAbout: "关于",
        settingsVersion: "版本",
        settingsLicense: "许可证",
        settingsAuthor: "作者",

        // Actions
        openInExplorer: "在资源管理器中打开",
        deletePhoto: "删除照片",
        backToHome: "返回主页",

        // Common
        loading: "加载中…",
        error: "出错了",
        empty: "暂无数据",
        confirm: "确定",
        cancel: "取消",
      },
    },
    en: {
      translation: {
        appName: "AI Image Manager",
        titleHomePage: "Photo Browser",
        titleDashboard: "Dashboard",
        titleSettings: "Settings",

        sidebarAllPhotos: "All Photos",
        sidebarAddFolder: "Add Folder",
        sidebarAiIndex: "AI Smart Index",
        sidebarFolders: "Folders",
        sidebarNoFolders: "No folders yet",
        sidebarDashboard: "Dashboard",
        sidebarSettings: "Settings",

        searchPlaceholder: "Search photos... (e.g. autumn leaves last year)",
        searchShortcut: "Ctrl+K",

        photosCount: "{{count}} photos",
        photosSelected: " · {{count}} selected",
        noPhotos: "No photos yet. Add a folder to get started.",
        loadingPhotos: "Loading photos...",

        welcomeTitle: "Welcome to AI Image Manager",
        welcomeStep1: "1. Click 'Add Folder' to select your photo directory",
        welcomeStep2: "2. Wait for scanning to complete, photos will appear here",
        welcomeStep3: "3. Click 'AI Smart Index' to enable natural language search",
        welcomeTip: "Tip: All processing is done locally. No data is ever uploaded.",

        scanningTitle: "Scanning Folder",
        scanningPath: "Path: {{path}}",
        scanningProgress: "Scanned {{scanned}} / {{total}}",
        scanningComplete: "Scan complete, {{count}} photos indexed",
        aiIndexingStarted: "AI indexing started...",
        aiIndexedCount: "AI indexed {{count}} photos",

        photoDetail: "Photo Detail",
        photoInfo: "Basic Info",
        exifInfo: "EXIF Info",
        camera: "Camera",
        lens: "Lens",
        focalLength: "Focal Length",
        aperture: "Aperture",
        shutter: "Shutter",
        iso: "ISO",
        dateTaken: "Date Taken",
        dimensions: "Dimensions",
        fileSize: "File Size",
        filePath: "File Path",
        noExifData: "No EXIF data",

        dashboardTitle: "Dashboard",
        totalPhotos: "Total Photos",
        aiProcessed: "AI Processed",
        dateRange: "Date Range",
        avgIso: "Avg ISO",
        cameraUsage: "Camera Usage",
        focalDistribution: "Focal Length Distribution",
        noCameraData: "No camera data yet. Index photos with EXIF data.",
        noFocalData: "No focal length data yet.",

        settingsTitle: "Settings",
        settingsAppearance: "Appearance",
        settingsTheme: "Theme",
        settingsLanguage: "Language",
        settingsIndexing: "Indexing",
        settingsThumbnailCache: "Thumbnail Cache",
        settingsThumbnailCacheHint: "Clear cached thumbnails to free disk space",
        settingsClear: "Clear",
        settingsClearing: "Clearing...",
        settingsCleared: "Cache cleared!",
        settingsAbout: "About",
        settingsVersion: "Version",
        settingsLicense: "License",
        settingsAuthor: "Author",

        openInExplorer: "Open in Explorer",
        deletePhoto: "Delete Photo",
        backToHome: "Back to Home",

        loading: "Loading...",
        error: "Error",
        empty: "No data",
        confirm: "Confirm",
        cancel: "Cancel",
      },
    },
  },
});
