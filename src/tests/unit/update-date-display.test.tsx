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
  { locale: "zh", label: "最近成功检查：" },
  { locale: "en", label: "Last successful check: " },
  { locale: "ja-JP", label: "最終確認成功：" },
].flatMap((entry) => [false, true].map((compact) => ({ ...entry, compact })));

beforeEach(() => localStorage.clear());

it.each(
  CASES
)("shows check times in settings and hides them in the popup in $locale with compact=$compact", async ({
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
    lastCheckAttemptAt: "2026-11-17T11:00:00.000Z",
  });
  fixture.render(
    <I18nextProvider i18n={translations}>
      <UpdateTaskCard compact={compact} />
    </I18nextProvider>
  );
  const time = new Date(CHECKED_AT).toLocaleString(locale);
  expect(time).toContain("/");
  const lastAttempt = translations.t("updateLastAttempt", {
    time: new Date("2026-11-17T11:00:00.000Z").toLocaleString(locale),
    interpolation: { escapeValue: false },
  });
  const card = await screen.findByTestId("update-task-card");
  if (compact) {
    expect(card).not.toHaveTextContent(`${label}${time}`);
    expect(card).not.toHaveTextContent(lastAttempt);
    return;
  }
  expect(await screen.findByText(`${label}${time}`)).toBeVisible();
  expect(screen.getByText(lastAttempt)).toBeVisible();
  expect(screen.getByTestId("update-task-card")).not.toHaveTextContent(
    "&#x2F;"
  );
});
