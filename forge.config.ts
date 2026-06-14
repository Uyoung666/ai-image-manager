import fs from "node:fs";
import path from "node:path";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const packageTempSuffix = process.env.AIM_PACKAGE_TEMP_SUFFIX;

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

// 清理 node_modules 中的非 Windows 平台二进制和开发文件
// 需要在 afterCopy、afterPrune、postPackage 三个阶段都调用，
// 因为 Electron Packager 的 prune 步骤会重新恢复被删文件
function cleanBuildNodeModules(buildPath: string) {
  const nmPath = path.join(buildPath, "node_modules");
  if (!fs.existsSync(nmPath)) {
    return;
  }

  // 删除 onnxruntime 非 Windows 平台二进制
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
      const pd = path.join(onnxDir, platform);
      if (fs.existsSync(pd)) {
        fs.rmSync(pd, { recursive: true, force: true });
        console.log(`[cleanup] removed ${pd}`);
      }
    }
    const arm64Dir = path.join(onnxDir, "win32", "arm64");
    if (fs.existsSync(arm64Dir)) {
      fs.rmSync(arm64Dir, { recursive: true, force: true });
      console.log(`[cleanup] removed ${arm64Dir}`);
    }
  }

  // 删除开发文件
  for (const ext of [".map", ".ts", ".tsx", ".md", ".c", ".h", ".cc", ".cpp"]) {
    removeFilesByExt(nmPath, ext, ext);
  }

  // 删除嵌套 sharp 的非 Windows vendor 二进制
  const nestedSharpVendor = path.join(
    nmPath,
    "@xenova",
    "transformers",
    "node_modules",
    "sharp",
    "vendor"
  );
  if (fs.existsSync(nestedSharpVendor)) {
    const entries = fs.readdirSync(nestedSharpVendor, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith("win32")) {
        const vp = path.join(nestedSharpVendor, entry.name);
        fs.rmSync(vp, { recursive: true, force: true });
        console.log(`[cleanup] removed sharp vendor ${vp}`);
      }
    }
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    ...(packageTempSuffix
      ? { out: path.join("out", `package-${packageTempSuffix}`) }
      : {}),
    asar: {
      unpack:
        "**/{better-sqlite3,sharp,@lancedb,@lancedb/lancedb-win32-x64-msvc,@lancedb/lancedb-win32-arm64-msvc,@img,node-*,detect-libc,semver,scripts,@xenova,@huggingface,onnxruntime-node,onnxruntime-common,onnxruntime-web,color,color-convert,color-name,color-string,simple-swizzle,is-arrayish,exiftool-vendored,exiftool-vendored.exe}/**",
    },
    extraResource: ["models", "drizzle", "assets/icon.png"],
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
    new MakerSquirrel({ name: "ai-image-manager" }),
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
          entry: "src/main.ts",
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
    postPackage: async (_forgeConfig, packageResult) => {
      for (const outputPath of packageResult.outputPaths) {
        cleanBuildNodeModules(
          path.join(outputPath, "resources", "app.asar.unpacked")
        );
        cleanBuildNodeModules(path.join(outputPath, "resources", "app"));
      }
    },
  },
};

export default config;
