import englishMain from "./english-main.json";
import englishRenderer from "./english-renderer.json";

/** Pure data shared by the host and release checks; never initializes i18next. */
export const HOST_LOCALE_CATALOG = {
  main: englishMain,
  renderer: englishRenderer,
};
