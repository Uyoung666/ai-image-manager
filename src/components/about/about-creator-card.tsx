import { SiGithub } from "@icons-pack/react-simple-icons";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openExternalLink } from "@/actions/shell";
import avatar from "@/assets/about/github-avatar.png";
import { SignatureArtwork } from "@/components/signature-artwork";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
export function AboutCreatorCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const id = useId();
  const appReduced = useReducedMotion();
  const systemReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const reduced = appReduced || systemReduced;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = reduced || (override ?? (hovered || focused));
  async function github() {
    try {
      await openExternalLink("https://github.com/Uyoung666/ai-image-manager");
    } catch {
      toast.error(t("aboutOpenFailed"));
    }
  }
  async function feedback() {
    try {
      await navigate({ to: "/settings/diagnostics" });
    } catch {
      toast.error(t("aboutOpenFailed"));
    }
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the group coordinates hover, focus and Escape for its native buttons.
    <section
      aria-label={t("settingsAuthor")}
      className="about-creator"
      data-expanded={expanded}
      data-reduced-motion={reduced}
      data-testid="about-creator"
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setFocused(false);
          if (!hovered) {
            setOverride(null);
          }
        }
      }}
      onFocusCapture={() => setFocused(true)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOverride(false);
          e.stopPropagation();
        }
      }}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") {
          setHovered(true);
        }
      }}
      onPointerLeave={() => {
        setHovered(false);
        if (!focused) {
          setOverride(null);
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-controls={id}
            aria-expanded={expanded}
            aria-label={t("aboutCreatorToggle")}
            className="about-creator-cover"
            disabled={reduced}
            onClick={() => setOverride(!expanded)}
            type="button"
          >
            <img
              alt=""
              draggable={false}
              height={512}
              src={avatar}
              width={512}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("aboutCreatorToggle")}</TooltipContent>
      </Tooltip>
      <div className="about-creator-panel" />
      <div aria-hidden={!expanded} className="about-creator-copy" id={id}>
        <h3>Uyoung</h3>
        <p>{t("aboutAuthorGreeting")}</p>
        <p>{t("aboutAuthorMessage")}</p>
        <SignatureArtwork className="about-small-signature" monochrome />
      </div>
      <div className="about-creator-links">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="GitHub"
              className="about-creator-social"
              onClick={github}
              type="button"
            >
              <SiGithub aria-hidden="true" size={20} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("settingsOpenGitHub")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="about-creator-contact"
              onClick={feedback}
              type="button"
            >
              {t("diagnosticsReportProblem")}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("diagnosticsReportProblem")}</TooltipContent>
        </Tooltip>
      </div>
    </section>
  );
}
