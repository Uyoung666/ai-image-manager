import { readFileSync } from "node:fs";
import path from "node:path";
import { screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateTaskCard } from "@/components/update-task-card";
import i18n from "@/localization/i18n";
import { updateUiFixture } from "../helpers/update-ui";

vi.unmock("react-i18next");
vi.mock("@/ipc/manager", () => ({ ipc: { client: {} } }));

const CHECKED_AT = "2026-10-03T10:45:06.000Z";
const japanese = JSON.parse(
  readFileSync(
    path.resolve(
      "external-plugins/japanese-locale/locales/ja-JP/renderer.json"
    ),
    "utf8"
  )
);
const CASES = [
  { locale: "zh", label: "上次检查：" },
  { locale: "en", label: "Last checked: " },
  { locale: "ja-JP", label: "最終確認：" },
].flatMap((entry) => [false, true].map((compact) => ({ ...entry, compact })));

beforeEach(() => localStorage.clear());

it.each(
  CASES
)("renders date separators as text in $locale with compact=$compact", async ({
  locale,
  label,
  compact,
}) => {
  const translations = createInstance();
  await translations.init({
    lng: locale,
    resources: {
      [locale]: {
        translation:
          locale === "ja-JP"
            ? japanese
            : i18n.getResourceBundle(locale, "translation"),
      },
    },
  });
  const fixture = updateUiFixture({
    phase: "error",
    message: "NETWORK_ERROR",
    lastCheckedAt: CHECKED_AT,
  });
  fixture.render(
    <I18nextProvider i18n={translations}>
      <UpdateTaskCard compact={compact} />
    </I18nextProvider>
  );
  const time = new Date(CHECKED_AT).toLocaleString(locale);
  expect(time).toContain("/");
  expect(await screen.findByText(`${label}${time}`)).toBeVisible();
  expect(screen.getByTestId("update-task-card")).not.toHaveTextContent(
    "&#x2F;"
  );
});
