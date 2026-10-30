import { ArrowUpRight, Globe, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openExternalLink } from "@/actions/shell";
import enDark from "@/assets/about/website/en-dark.jpg";
import enLight from "@/assets/about/website/en-light.jpg";
import zhDark from "@/assets/about/website/zh-dark.jpg";
import zhLight from "@/assets/about/website/zh-light.jpg";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import icon from "../../../assets/icons/icon-256.png";

const URL = "https://ai-image-manager.uyoungvision.cn/";
export function AboutWebsiteCard() {
  const { t, i18n } = useTranslation();
  const [failed, setFailed] = useState<string[]>([]);
  const english = !(i18n.resolvedLanguage || i18n.language || "zh").startsWith(
    "zh"
  );
  async function open() {
    try {
      await openExternalLink(URL);
    } catch {
      toast.error(t("aboutOpenFailed"));
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={t("settingsVisitWebsite")}
          className="about-website"
          data-testid="about-website"
          onClick={open}
          type="button"
        >
          <span aria-hidden="true" className="about-browser-tabs">
            <span>
              <Globe size={12} /> AI Image Manager
            </span>
            <span>− □ ×</span>
          </span>
          <span aria-hidden="true" className="about-browser-address">
            <LockKeyhole size={11} />
            <span>ai-image-manager.uyoungvision.cn</span>
            <ArrowUpRight size={13} />
          </span>
          <span className="about-browser-preview">
            {[english ? enLight : zhLight, english ? enDark : zhDark].map(
              (src, index) => (
                <span
                  className={index ? "about-site-dark" : "about-site-light"}
                  key={src}
                >
                  {failed.includes(src) ? (
                    <span className="about-site-fallback">
                      <img alt="" height={32} src={icon} width={32} />
                      {t("settingsVisitWebsite")}
                    </span>
                  ) : (
                    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: image loading failure is not input.
                    <img
                      alt=""
                      height={600}
                      onError={() => setFailed((p) => [...p, src])}
                      src={src}
                      width={1260}
                    />
                  )}
                </span>
              )
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{URL}</TooltipContent>
    </Tooltip>
  );
}
