import type { AppDetailsOptions } from "electron";

export const WINDOWS_APP_ID = "com.squirrel.ai-image-manager.ai-image-manager";

export function getWindowsAppId(isPackaged: boolean): string {
  return isPackaged ? WINDOWS_APP_ID : `${WINDOWS_APP_ID}.development`;
}

export function createWindowsAppDetails(options: {
  isPackaged: boolean;
  executablePath: string;
  appPath: string;
  iconPath: string;
}): AppDetailsOptions {
  const executable = `"${options.executablePath}"`;
  return {
    appId: getWindowsAppId(options.isPackaged),
    appIconPath: options.iconPath,
    appIconIndex: 0,
    relaunchCommand: options.isPackaged
      ? executable
      : `${executable} "${options.appPath}"`,
    relaunchDisplayName: "AI Image Manager",
  };
}
