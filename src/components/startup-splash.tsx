import { useTranslation } from "react-i18next";

interface StartupSplashProps {
  exiting?: boolean;
}

export function HamsterWheelLoader({ label }: { label: string }) {
  return (
    <div aria-label={label} className="wheel-and-hamster" role="img">
      <div className="wheel" />
      <div className="hamster">
        <div className="hamster__body">
          <div className="hamster__head">
            <div className="hamster__ear" />
            <div className="hamster__eye" />
            <div className="hamster__nose" />
          </div>
          <div className="hamster__limb hamster__limb--fr" />
          <div className="hamster__limb hamster__limb--fl" />
          <div className="hamster__limb hamster__limb--br" />
          <div className="hamster__limb hamster__limb--bl" />
          <div className="hamster__tail" />
        </div>
      </div>
      <div className="spoke" />
    </div>
  );
}

export function StartupSplash({ exiting = false }: StartupSplashProps) {
  const { t } = useTranslation();
  const splashClassName = [
    "bg-background",
    "startup-splash",
    exiting ? "is-exiting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      aria-label={t("startupLoading")}
      aria-live="polite"
      className={splashClassName}
      role="status"
    >
      <HamsterWheelLoader label={t("startupLoading")} />
    </div>
  );
}
