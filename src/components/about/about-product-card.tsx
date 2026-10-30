import { Check, Copy, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
export function AboutProductCard({
  version,
  easterEggFound,
  onVersionClick,
}: {
  version: string;
  easterEggFound: boolean;
  onVersionClick: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`AI Image Manager ${version}`);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("copyFailed"));
    }
  }
  return (
    <section
      aria-label={t("aboutProductName")}
      className="about-product"
      data-testid="about-product"
    >
      <h3 className="about-product-name">{t("aboutProductName")}</h3>
      <p className="about-product-tagline">{t("aboutProductTagline")}</p>
      <div className="about-product-meta">
        <span>{t("settingsVersion")}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("settingsVersion")}
              className="about-product-version"
              onClick={onVersionClick}
              type="button"
            >
              {version || "..."}
              {easterEggFound && <Sparkles size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("settingsVersion")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("aboutCopyVersion")}
              className="about-copy"
              disabled={!version}
              onClick={copy}
              type="button"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {t(copied ? "copied" : "aboutCopyVersion")}
          </TooltipContent>
        </Tooltip>
        <span className="sr-only" role="status">
          {copied ? t("copied") : ""}
        </span>
        <span className="about-license">
          {t("settingsLicense")} <strong>MIT</strong>
        </span>
      </div>
    </section>
  );
}
