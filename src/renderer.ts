import { createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { initializeAppLanguage } from "@/actions/language";
import App from "@/app";
import i18n from "@/localization/i18n";
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
bootstrap
  .renderAfterInitialization(
    () => initializeAppLanguage(i18n),
    createElement(StrictMode, null, createElement(App))
  )
  .catch(() => undefined);
