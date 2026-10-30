import { describe, expect, it } from "vitest";
import {
  createWindowsAppDetails,
  getWindowsAppId,
  WINDOWS_APP_ID,
} from "@/utils/windows-app-details";

describe("Windows taskbar identity", () => {
  it("keeps installed shortcut identity and separates development windows", () => {
    expect(getWindowsAppId(true)).toBe(WINDOWS_APP_ID);
    expect(getWindowsAppId(false)).not.toBe(WINDOWS_APP_ID);
  });

  it.each([
    true,
    false,
  ])("sets the taskbar icon and a valid relaunch command (packaged=%s)", (isPackaged) => {
    const details = createWindowsAppDetails({
      isPackaged,
      executablePath: "C:\\应用目录\\electron.exe",
      appPath: "D:\\My App",
      iconPath: "D:\\My App\\assets\\icon.ico",
    });
    expect(details).toMatchObject({
      appId: getWindowsAppId(isPackaged),
      appIconPath: "D:\\My App\\assets\\icon.ico",
      appIconIndex: 0,
      relaunchDisplayName: "AI Image Manager",
    });
    expect(details.relaunchCommand).toBe(
      isPackaged
        ? '"C:\\应用目录\\electron.exe"'
        : '"C:\\应用目录\\electron.exe" "D:\\My App"'
    );
  });
});
