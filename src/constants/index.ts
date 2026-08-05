export const LOCAL_STORAGE_KEYS = {
  LANGUAGE: "lang",
  THEME: "theme",
};

export const IPC_CHANNELS = {
  START_ORPC_SERVER: "start-orpc-server",
  FILE_CHANGE: "file-change",
  NATIVE_FILE_DRAG: "native-file-drag",
  WANDER_LIFECYCLE: "wander:lifecycle",
};

export type WanderLifecycleReason =
  | "initial"
  | "system-lock"
  | "system-resume"
  | "system-suspend"
  | "system-unlock"
  | "window-blur"
  | "window-focus"
  | "window-hide"
  | "window-minimize"
  | "window-restore"
  | "window-show";

export interface WanderLifecycleState {
  channel: typeof IPC_CHANNELS.WANDER_LIFECYCLE;
  eligible: boolean;
  focused: boolean;
  locked: boolean;
  minimized: boolean;
  reason: WanderLifecycleReason;
  suspended: boolean;
  visible: boolean;
}

export const ENVIRONMENT_VARIABLES = {
  NODE_ENV: process.env.NODE_ENV,
};

export const inDevelopment = ENVIRONMENT_VARIABLES.NODE_ENV === "development";
