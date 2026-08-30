import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerWix } from "@electron-forge/maker-wix";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MODEL_MANIFEST } from "./src/services/model-downloader";

const packageTempSuffix = process.env.AIM_PACKAGE_TEMP_SUFFIX;
// Squirrel always emits the full package.  A stable RELEASES feed is optional
// and is only used while publishing to derive a delta package from that
// baseline.  Keeping the value out of normal local builds also prevents a
// developer build from accidentally contacting the release bucket.
const squirrelRemoteReleases = process.env.AIM_SQUIRREL_REMOTE_RELEASES?.trim();
const RELEASE_MODELS_DIR = path.resolve("models-release");
const SQUIRREL_SETUP_ICON_PATH = path.resolve("assets/icon.ico");
const SQUIRREL_RCEDIT_PATH = path.resolve(
  "node_modules/electron-winstaller/vendor/rcedit.exe"
);
const SQUIRREL_SETUP_ARTIFACT_PATTERN = /Setup\.exe$/i;
const WIX_PACKAGE_ELEMENT_PATTERN = /<Package InstallerVersion="405"/;
const WIX_PRODUCT_LANGUAGE_PATTERN = /Language="\{\{Language\}\}">/;
const WIX_START_MENU_WORKING_DIRECTORY_PATTERN =
  /WorkingDirectory="APPLICATIONROOTDIRECTORY">\r?\n(<!-- \{\{ShortcutProperties\}\} -->)/;
const WIX_DESKTOP_WORKING_DIRECTORY_PATTERN =
  /WorkingDirectory="APPLICATIONROOTDIRECTORY"\/>/;
const LOCAL_WIX_DIRECTORY = process.env.LOCALAPPDATA
  ? path.join(
      process.env.LOCALAPPDATA,
      "AIImageManagerBuildTools",
      "wix-3.14.0"
    )
  : null;

if (
  process.platform === "win32" &&
  LOCAL_WIX_DIRECTORY &&
  fs.existsSync(path.join(LOCAL_WIX_DIRECTORY, "candle.exe")) &&
  fs.existsSync(path.join(LOCAL_WIX_DIRECTORY, "light.exe"))
) {
  process.env.PATH = [LOCAL_WIX_DIRECTORY, process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);
}

/**
 * Build the exact model payload that is allowed into a release.  The source
 * models directory is intentionally ignored; never pass that directory
 * directly to Electron Forge.
 */
function stageReleaseModels(): void {
  fs.rmSync(RELEASE_MODELS_DIR, { recursive: true, force: true });
  let stagedCount = 0;
  for (const entry of MODEL_MANIFEST) {
    if (entry.bundled === false) {
      continue;
    }
    const source = path.join("models", entry.subPath, entry.fileName);
    const target = path.join(RELEASE_MODELS_DIR, entry.subPath, entry.fileName);
    if (!fs.existsSync(source)) {
      if (entry.required) {
        throw new Error(`Required release model is missing: ${source}`);
      }
      console.warn(`[release-models] skipped optional model: ${source}`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    stagedCount += 1;
  }
  console.log(`[release-models] staged ${stagedCount} model files`);
}

function cleanSourceModelCaches(): void {
  for (const cacheDir of [
    path.join("node_modules", "@xenova", "transformers", ".cache"),
    path.join("node_modules", "@huggingface", ".cache"),
  ]) {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log(`[cleanup] removed source model cache ${cacheDir}`);
    }
  }
}

cleanSourceModelCaches();
stageReleaseModels();

// 递归删除 node_modules 中指定后缀的开发文件
function removeFilesByExt(dir: string, ext: string, label: string) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const files: string[] = [];
  function walk(d: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(ext)) {
        files.push(full);
      }
    }
  }
  walk(dir);
  for (const f of files) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
  if (files.length > 0) {
    console.log(`[cleanup] removed ${files.length} ${label} files`);
  }
}

function cleanModelCaches(nmPath: string): void {
  for (const cacheDir of [
    path.join(nmPath, "@xenova", "transformers", ".cache"),
    path.join(nmPath, "@huggingface", ".cache"),
  ]) {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log(`[cleanup] removed model cache ${cacheDir}`);
    }
  }
}

function cleanNonWindowsOnnxBinaries(nmPath: string): void {
  const onnxPlatforms = [
    path.join(nmPath, "onnxruntime-node", "bin", "napi-v6"),
    path.join(
      nmPath,
      "@xenova",
      "transformers",
      "node_modules",
      "onnxruntime-node",
      "bin",
      "napi-v3"
    ),
  ];
  for (const onnxDir of onnxPlatforms) {
    if (!fs.existsSync(onnxDir)) {
      continue;
    }
    for (const platform of ["darwin", "linux"]) {
      const platformDir = path.join(onnxDir, platform);
      if (fs.existsSync(platformDir)) {
        fs.rmSync(platformDir, { recursive: true, force: true });
        console.log(`[cleanup] removed ${platformDir}`);
      }
    }
    const arm64Dir = path.join(onnxDir, "win32", "arm64");
    if (fs.existsSync(arm64Dir)) {
      fs.rmSync(arm64Dir, { recursive: true, force: true });
      console.log(`[cleanup] removed ${arm64Dir}`);
    }
  }
}

function cleanNestedSharpVendor(nmPath: string): void {
  const nestedSharpVendor = path.join(
    nmPath,
    "@xenova",
    "transformers",
    "node_modules",
    "sharp",
    "vendor"
  );
  if (!fs.existsSync(nestedSharpVendor)) {
    return;
  }
  const entries = fs.readdirSync(nestedSharpVendor, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith("win32")) {
      const vendorPath = path.join(nestedSharpVendor, entry.name);
      fs.rmSync(vendorPath, { recursive: true, force: true });
      console.log(`[cleanup] removed sharp vendor ${vendorPath}`);
    }
  }
}

// 清理 node_modules 中的非 Windows 平台二进制和开发文件
// 需要在 afterCopy、afterPrune、postPackage 三个阶段都调用，
// 因为 Electron Packager 的 prune 步骤会重新恢复被删文件
function cleanBuildNodeModules(buildPath: string) {
  const nmPath = path.join(buildPath, "node_modules");
  if (!fs.existsSync(nmPath)) {
    return;
  }

  cleanModelCaches(nmPath);
  cleanNonWindowsOnnxBinaries(nmPath);

  // 删除开发文件
  for (const ext of [".map", ".ts", ".tsx", ".md", ".c", ".h", ".cc", ".cpp"]) {
    removeFilesByExt(nmPath, ext, ext);
  }

  cleanNestedSharpVendor(nmPath);
}

const config: ForgeConfig = {
  packagerConfig: {
    ...(packageTempSuffix
      ? { out: path.join("out", `package-${packageTempSuffix}`) }
      : {}),
    asar: {
      unpack:
        "**/{better-sqlite3,sharp,@lancedb,@lancedb/lancedb-win32-x64-msvc,@lancedb/lancedb-win32-arm64-msvc,@img,node-*,detect-libc,semver,scripts,@xenova,@huggingface,onnxruntime-node,onnxruntime-common,onnxruntime-web,color,color-convert,color-name,color-string,simple-swizzle,is-arrayish,exifr,exiftool-vendored,exiftool-vendored.exe}/**",
    },
    extraResource: [
      "models-release",
      "drizzle",
      "assets/icon.png",
      "THIRD_PARTY_NOTICES.md",
      "THIRD_PARTY_MODEL_NOTICES.md",
      "licenses",
    ],
    name: "AI Image Manager",
    executableName: "ai-image-manager",
    appBundleId: "com.uyoung.ai-image-manager",
    icon: "assets/icon",

    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, done) => {
        try {
          const cwd = process.cwd();
          const nmDest = path.join(buildPath, "node_modules");

          // 逐个复制模块，避免 cpSync 在深层原生模块树上触发 EIO 错误
          function copyDir(src: string, dst: string) {
            if (!fs.existsSync(src)) {
              return;
            }
            fs.mkdirSync(dst, { recursive: true });
            const entries = fs.readdirSync(src, { withFileTypes: true });
            for (const entry of entries) {
              const srcPath = path.join(src, entry.name);
              const dstPath = path.join(dst, entry.name);
              if (entry.isDirectory()) {
                copyDir(srcPath, dstPath);
              } else if (entry.isSymbolicLink()) {
                try {
                  const target = fs.readlinkSync(srcPath);
                  fs.symlinkSync(target, dstPath);
                } catch {
                  // ignore symlink errors
                }
              } else {
                fs.copyFileSync(srcPath, dstPath);
              }
            }
          }

          const modules = [
            "better-sqlite3",
            "bindings",
            "file-uri-to-path",
            "sharp",
            "@lancedb",
            "@lancedb/lancedb-win32-x64-msvc",
            "@lancedb/lancedb-win32-arm64-msvc",
            "@img",
            "detect-libc",
            "semver",
            "apache-arrow",
            "flatbuffers",
            "tslib",
            "reflect-metadata",
            "@xenova",
            "color",
            "color-convert",
            "color-name",
            "color-string",
            "simple-swizzle",
            "is-arrayish",
            "exifr",
            "exiftool-vendored",
            "exiftool-vendored.exe",
            "onnxruntime-node",
            "onnxruntime-common",
            "onnxruntime-web",
            "@huggingface",
          ];

          for (const mod of modules) {
            const src = path.join(cwd, "node_modules", mod);
            const dst = path.join(nmDest, mod);
            if (!fs.existsSync(src)) {
              continue;
            }
            if (fs.existsSync(dst)) {
              fs.rmSync(dst, { recursive: true, force: true });
            }
            copyDir(src, dst);
          }

          // 复制 worker 脚本
          const scriptsSrc = path.join(cwd, "scripts");
          const scriptsDst = path.join(buildPath, "scripts");
          copyDir(scriptsSrc, scriptsDst);

          cleanBuildNodeModules(buildPath);
          done();
        } catch (err) {
          console.error("[afterCopy] Error:", err);
          done(err as Error);
        }
      },
    ],

    afterPrune: [
      (buildPath, _electronVersion, _platform, _arch, done) => {
        try {
          // prune 步骤会恢复被删文件，必须再次清理
          cleanBuildNodeModules(buildPath);
          done();
        } catch (err) {
          console.error("[afterPrune] Error:", err);
          done(err as Error);
        }
      },
    ],
  },

  rebuildConfig: {},

  makers: [
    new MakerSquirrel({
      name: "ai-image-manager",
      // Authenticode is intentionally not configured yet. The release
      // pipeline records hashes/provenance and documents the SmartScreen risk;
      // if signing is added later, sign only after all icon edits are done.
      // `noDelta: false` documents the intended default explicitly: the full
      // package is always produced, and a delta is added only when the remote
      // stable baseline above is available.
      noDelta: false,
      ...(squirrelRemoteReleases
        ? { remoteReleases: squirrelRemoteReleases }
        : {}),
    }),
    new MakerWix({
      appUserModelId: "com.squirrel.ai-image-manager.ai-image-manager",
      beforeCreate: (creator) => {
        creator.wixTemplate = creator.wixTemplate
          .replace(
            WIX_PRODUCT_LANGUAGE_PATTERN,
            'Language="{{Language}}" Codepage="936">'
          )
          .replace(
            WIX_PACKAGE_ELEMENT_PATTERN,
            '<Package InstallerVersion="405" SummaryCodepage="936"'
          )
          .replace(
            'Name = "{{ApplicationName}} (Machine - MSI)"',
            'Name="{{ApplicationName}} 安装程序"'
          )
          .replace(
            'Description="The complete package."',
            'Description="安装 AI Image Manager 及所选功能。"'
          )
          .replace('Title="Main Application"', 'Title="主程序"')
          .replace(
            'Description="The main components to run the applications."',
            'Description="运行 AI Image Manager 所需的核心文件。"'
          )
          .replace(
            "<!-- {{Icon}}-->",
            `<Icon Id="ApplicationIcon" SourceFile="${path.resolve(
              "assets/icon.ico"
            )}" />
    <Property Id="ARPPRODUCTICON" Value="ApplicationIcon" />`
          )
          .replace(
            WIX_START_MENU_WORKING_DIRECTORY_PATTERN,
            'WorkingDirectory="APPLICATIONROOTDIRECTORY" Icon="ApplicationIcon" IconIndex="0">\n$1'
          )
          .replace(
            WIX_DESKTOP_WORKING_DIRECTORY_PATTERN,
            'WorkingDirectory="APPLICATIONROOTDIRECTORY" Icon="ApplicationIcon" IconIndex="0"/>'
          );
        creator.updaterTemplate = creator.updaterTemplate
          .replace('Title="Auto Update"', 'Title="自动更新"')
          .replace(
            'Description="Installs an auto-updater component and sets necesssary file system permissions."',
            'Description="安装自动更新组件，并设置所需的文件夹权限。"'
          );
      },
      cultures: "zh-cn",
      // A custom directory can live on any fixed volume. Run the transaction
      // elevated so Windows Installer can create and secure that volume's
      // Config.Msi rollback store during install, upgrade, and uninstall.
      // Disabling rollback is not safe and causes MSI 2502/2503 failures.
      defaultInstallMode: "perMachine",
      exe: "ai-image-manager.exe",
      features: { autoLaunch: false, autoUpdate: true },
      icon: "assets/icon.ico",
      installLevel: 3,
      language: 2052,
      manufacturer: "Uyoung",
      programFilesFolderName: "AI Image Manager",
      shortName: "AIImageManager",
      shortcutName: "AI Image Manager",
      ui: {
        chooseDirectory: true,
        images: {
          background: path.resolve("assets/installers/wix-dialog.jpg"),
          banner: path.resolve("assets/installers/wix-banner.jpg"),
        },
      },
      upgradeCode: "57daa2e0-55c6-4398-b52b-4eb0b052ad8c",
    }),
    new MakerZIP({}),
    new MakerRpm({}),
    new MakerDeb({}),
  ],

  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "Uyoung666",
          name: "ai-image-manager",
        },
        draft: true,
        prerelease: false,
      },
    },
  ],

  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/bootstrap.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
    }),

    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],

  // asar 打包后再清理一次 app.asar.unpacked，确保最终输出干净
  hooks: {
    postPackage: (_forgeConfig, packageResult) => {
      for (const outputPath of packageResult.outputPaths) {
        cleanBuildNodeModules(
          path.join(outputPath, "resources", "app.asar.unpacked")
        );
        cleanBuildNodeModules(path.join(outputPath, "resources", "app"));
      }
      return Promise.resolve();
    },
    postMake: (_forgeConfig, makeResults) => {
      if (
        process.platform !== "win32" ||
        !fs.existsSync(SQUIRREL_SETUP_ICON_PATH) ||
        !fs.existsSync(SQUIRREL_RCEDIT_PATH)
      ) {
        return Promise.resolve();
      }

      for (const artifact of makeResults.flatMap(
        (result) => result.artifacts
      )) {
        if (!SQUIRREL_SETUP_ARTIFACT_PATTERN.test(artifact)) {
          continue;
        }

        const result = spawnSync(
          SQUIRREL_RCEDIT_PATH,
          [artifact, "--set-icon", SQUIRREL_SETUP_ICON_PATH],
          { stdio: "pipe", windowsHide: true }
        );
        if (result.error || result.status !== 0) {
          const details = result.error?.message ?? result.stderr?.toString();
          throw new Error(
            `Unable to apply the application icon to Squirrel Setup.exe${
              details ? `: ${details}` : ""
            }`
          );
        }
      }
      return Promise.resolve();
    },
  },
};

export default config;
