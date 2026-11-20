import { execFileSync } from "node:child_process";
import type { ElectronApplication, Page } from "@playwright/test";

// ClientToScreen maps CSS points via the native client area, including at
// Windows DPI settings that differ from Electron's forced test scale.
const nativeDrag = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class WindowDrag {
  [StructLayout(LayoutKind.Sequential)]
  private struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref Point p);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(
    IntPtr window, uint message, UIntPtr wParam, IntPtr lParam,
    uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] private static extern void mouse_event(
    uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

  public static int Run(long handle, double relativeX, double relativeY, bool move) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    IntPtr window = new IntPtr(handle);
    Rect client;
    if (!GetClientRect(window, out client))
      throw new InvalidOperationException("Cannot read the test window's client area.");
    Point point = new Point {
      X = (int)Math.Round(relativeX * client.Right),
      Y = (int)Math.Round(relativeY * client.Bottom)
    };
    if (!ClientToScreen(window, ref point))
      throw new InvalidOperationException("Cannot map the drag point to the desktop.");
    int x = point.X, y = point.Y;
    IntPtr hit;
    IntPtr position = new IntPtr(unchecked((int)(((uint)y << 16) | ((uint)x & 0xffff))));
    if (SendMessageTimeout(window, 0x84, UIntPtr.Zero, position, 2, 2000, out hit) == IntPtr.Zero)
      throw new InvalidOperationException("WM_NCHITTEST timed out.");
    if (!move || hit.ToInt32() != 2)
      return hit.ToInt32();

    IntPtr owner = GetAncestor(WindowFromPoint(point), 2);
    if (owner != window)
      throw new InvalidOperationException(String.Format(
        "Window {0} owns the drag point ({1}, {2}); expected test window {3}.",
        owner, x, y, window));

    Point saved;
    if (!GetCursorPos(out saved) || !SetCursorPos(x, y))
      throw new InvalidOperationException("Cannot position the system cursor.");
    try {
      mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(120);
      for (int step = 1; step <= 4; step++) {
        SetCursorPos(x + step * 12, y + step * 8);
        Thread.Sleep(45);
      }
    } finally {
      mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(80);
      SetCursorPos(saved.X, saved.Y);
    }
    return hit.ToInt32();
  }
}
'@
[WindowDrag]::Run(
  [long]$env:AIM_DRAG_HANDLE, [double]$env:AIM_DRAG_X, [double]$env:AIM_DRAG_Y,
  $env:AIM_DRAG_MOVE -eq '1')
`;

export async function probeWindowsWindowDrag(
  app: ElectronApplication,
  page: Page,
  point: { x: number; y: number },
  move: boolean,
  env: Record<string, string>
) {
  const window = await app.browserWindow(page);
  const [target, viewport] = await Promise.all([
    window.evaluate((win) => ({
      bounds: win.getBounds(),
      hwnd: win.getNativeWindowHandle().readBigUInt64LE().toString(),
    })),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  const hit = Number(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", nativeDrag],
      {
        encoding: "utf8",
        env: {
          ...env,
          AIM_DRAG_HANDLE: target.hwnd,
          AIM_DRAG_MOVE: move ? "1" : "0",
          AIM_DRAG_X: String(point.x / viewport.width),
          AIM_DRAG_Y: String(point.y / viewport.height),
        },
        timeout: 10_000,
        windowsHide: true,
      }
    ).trim()
  );
  return { before: target.bounds, hit, window };
}
