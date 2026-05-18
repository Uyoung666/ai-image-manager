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

const config: ForgeConfig = {
  packagerConfig: {
    ...(packageTempSuffix
      ? { out: path.join("out", `package-${packageTempSuffix}`) }
      : {}),
    asar: {
      unpack:
        "**/{better-sqlite3,sharp,@lancedb,@img,node-*,detect-libc,semver,scripts,@xenova,@huggingface,onnxruntime-node,onnxruntime-common,onnxruntime-web,color,color-convert,color-name,color-string,simple-swizzle,is-arrayish}/**",
    },
    extraResource: ["models", "drizzle", "assets/icon.png"],
    name: "AI Image Manager",
    executableName: "ai-image-manager",
    appBundleId: "com.uyoung.ai-image-manager",
    icon: "assets/icon",
    // Vite plugin only copies build output + package.json — node_modules
    // must be copied manually for native addons.
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, done) => {
        try {
          const cwd = process.cwd();
          const nmDest = path.join(buildPath, "node_modules");

          // Copy one module at a time, using simple file copy to avoid EIO errors
          // that occur with fs.cpSync on deeply nested native module trees.
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
                // Skip symlinks on Windows — sharp/libvips install uses them
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
            "@img",
            "detect-libc",
            "semver",
            "apache-arrow",
            "flatbuffers",
            "tslib",
            "reflect-metadata",
            // === 防漏网依赖 ===
            "@xenova", // @xenova/transformers 的底层目录（已在 vite external 中）
            "color", // 嵌套 sharp (v0.32) 的纯 JS 依赖
            "color-convert",
            "color-name",
            "color-string",
            "simple-swizzle",
            "is-arrayish",
            // face-worker.mjs 通过 createRequire 加载 onnxruntime-node（原生
            // ONNX 推理）跑 UltraFace + ArcFace，必须显式复制到 packaged
            // node_modules，否则 face-worker 启动时 require 失败 → 进 catch
            // 分支返回 faces:[]，UI 显示"检测完成 0 张脸"
            "onnxruntime-node",
            "onnxruntime-common",
            // onnxruntime-web is statically imported by
            // @xenova/transformers/src/backends/onnx.js — even though we
            // route the forked embed-worker to onnxruntime-node by leaving
            // process.release.name = "node", the main process still loads
            // transformers for the text encoder (WASM). Without this copy,
            // the static `import * as ONNX_WEB from 'onnxruntime-web'`
            // throws at module load → CLIP "AI 模型加载失败".
            "onnxruntime-web",
            // @huggingface/jinja is a runtime dep of @xenova/transformers
            // (statically imported by transformers/src/tokenizers.js).
            // Without it, `await import("@xenova/transformers")` throws
            // ERR_MODULE_NOT_FOUND in the packaged worker.
            "@huggingface",
          ];

          for (const mod of modules) {
            const src = path.join(cwd, "node_modules", mod);
            const dst = path.join(nmDest, mod);
            if (!fs.existsSync(src)) {
              continue;
            }
            // Forge's prePackage prune may have left a partial directory
            // (e.g. only nested node_modules/ for unbundled packages like
            // @xenova/transformers). Wipe the destination first so copyDir
            // produces a complete copy.
            if (fs.existsSync(dst)) {
              fs.rmSync(dst, { recursive: true, force: true });
            }
            copyDir(src, dst);
          }

          // === 保留嵌套 sharp，确保其纯 JS 依赖可解析 ===
          // @xenova/transformers 的 package.json 声明了 "sharp": "^0.32.0"，
          // electron-rebuild 会反复恢复嵌套 sharp。无法删除也无法 stub。
          // 解法：把嵌套 sharp 需要的纯 JS 依赖也复制到 build node_modules，
          // 并加入 asar unpack 通配符，确保 native require 能沿 node_modules
          // 树向上找到它们（不会被锁在 app.asar 里）。
          const nestedSharpDir = path.join(
            nmDest,
            "@xenova",
            "transformers",
            "node_modules",
            "sharp"
          );
          if (fs.existsSync(nestedSharpDir)) {
            console.log(
              "[afterCopy] nested sharp detected — ensuring color deps are unpacked"
            );
          }

          // Copy worker scripts to <buildPath>/scripts/ so that, after asar
          // packaging with `unpack: scripts/*.mjs`, they end up at
          // resources/app.asar.unpacked/scripts/*.mjs — i.e. siblings of
          // resources/app.asar.unpacked/node_modules/. This is required for
          // ESM static `import sharp from "sharp"` inside the worker to
          // resolve via Node's normal node_modules lookup.
          const scriptsSrc = path.join(cwd, "scripts");
          const scriptsDst = path.join(buildPath, "scripts");
          copyDir(scriptsSrc, scriptsDst);

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
          // Check that color deps are still accessible for nested sharp.
          const nestedSharpDir2 = path.join(
            buildPath,
            "node_modules",
            "@xenova",
            "transformers",
            "node_modules",
            "sharp"
          );
          if (fs.existsSync(nestedSharpDir2)) {
            console.log(
              "[afterPrune] nested sharp still present (expected)"
            );
          }
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
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
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
};

export default config;
