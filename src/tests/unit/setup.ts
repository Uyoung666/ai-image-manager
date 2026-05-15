import "@testing-library/jest-dom";
import { vi } from "vitest";

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
        sidebarDashboard: "仪表盘",
        sidebarSettings: "设置",
        searchPlaceholder: "搜索照片… (例如: 去年秋天的红叶)",
        photosCount: `{{count}} 张照片`,
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
        tagDropHint: "松手添加",
        tagDeleteTitle: "删除标签",
        tagDeleteDescription:
          "确定要删除标签「{{name}}」吗？该操作不可撤销。",
        tagCreateChild: "创建子标签",
        loading: "加载中…",
        backToHome: "返回主页",
      };
      const translated = translations[key];
      if (!translated) return key;
      if (options?.count !== undefined) {
        return translated.replace("{{count}}", String(options.count));
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
