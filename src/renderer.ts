import { createElement, Profiler, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { initializeAppLanguage } from "@/actions/language";
import App from "@/app";
import i18n from "@/localization/i18n";
import { isGalleryPerfEnabled, recordGalleryPerf } from "@/utils/gallery-perf";
import { createRendererBootstrap } from "@/utils/renderer-bootstrap";

const container = document.getElementById("app");
if (!container) {
  throw new Error('Root element with id "app" not found');
}
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

const bootstrap = createRendererBootstrap(
  container,
  import.meta.hot?.data.root as Root | undefined
);
if (import.meta.hot) {
  import.meta.hot.data.root = bootstrap.root;
  import.meta.hot.dispose(() => bootstrap.dispose());
}

// Resolve the signed locale before rendering the first frame.
const content = createElement(StrictMode, null, createElement(App));
bootstrap
  .renderAfterInitialization(
    () => initializeAppLanguage(i18n),
    isGalleryPerfEnabled()
      ? createElement(
          Profiler,
          {
            // The bundled profiling renderer supplies effect timings in addition
            // to onRender. Ordinary production React leaves these hooks dormant.
            ...{
              onCommit: (_id: string, _phase: string, duration: number) =>
                recordGalleryPerf("reactCommitEffectsMs", duration),
              onPostCommit: (_id: string, _phase: string, duration: number) =>
                recordGalleryPerf("reactPassiveEffectsMs", duration),
            },
            id: "gallery-application",
            onRender: (_id, _phase, duration, _base, start, commit) => {
              recordGalleryPerf("reactRenderMs", duration);
              recordGalleryPerf("reactRenderToCommitMs", commit - start);
            },
          },
          content
        )
      : content
  )
  .catch(() => undefined);
