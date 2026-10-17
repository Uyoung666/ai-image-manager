import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createUpdateUiStore, UpdateUiProvider } from "@/hooks/use-update-ui";
import type { UpdateStatus } from "@/types/update";

export function updateUiFixture(initial: UpdateStatus = { phase: "idle" }) {
  let serverStatus = initial;
  const dependencies = {
    getStatus: vi.fn(async () => serverStatus),
    getVersion: vi.fn().mockResolvedValue("2.2.3"),
    getPreferences: vi
      .fn()
      .mockResolvedValue({ updateAutoUpdate: true, updateReminder: true }),
    savePreference: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({ ok: true }),
    resume: vi.fn().mockResolvedValue({ ok: true }),
    full: vi.fn().mockResolvedValue({ ok: true }),
    install: vi.fn().mockResolvedValue({ ok: true }),
    manual: vi.fn().mockResolvedValue(undefined),
    storage: vi.fn(() => window.localStorage),
  };
  const store = createUpdateUiStore(dependencies);
  return {
    dependencies,
    store,
    setServerStatus: (status: UpdateStatus) => {
      serverStatus = status;
    },
    emit: (status: UpdateStatus) => {
      serverStatus = status;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: "update:status", ...status },
        })
      );
    },
    render: (children: ReactNode) =>
      render(
        <UpdateUiProvider store={store}>
          <TooltipProvider>{children}</TooltipProvider>
        </UpdateUiProvider>
      ),
  };
}

export function translateUpdate(key: string, values?: Record<string, unknown>) {
  return values ? `${key} ${Object.values(values).join(" ")}` : key;
}
