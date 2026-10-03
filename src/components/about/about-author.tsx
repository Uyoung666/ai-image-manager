import { type CSSProperties, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

export function AboutAuthor() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const messages = [
    { id: "name", text: "Uyoung" },
    { id: "greeting", text: t("aboutAuthorGreeting") },
    { id: "message", text: t("aboutAuthorMessage") },
  ];
  const greeting = hovered || focused ? 1 : 0;
  const current = showMessage ? 2 : greeting;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`${messages[current].text} · ${t("aboutAuthorHint")}`}
          className="about-author"
          data-message={messages[current].id}
          data-reduced-motion={reduceMotion}
          onBlur={() => {
            setFocused(false);
            setShowMessage(false);
          }}
          onClick={() => setShowMessage((previous) => !previous)}
          onFocus={() => setFocused(true)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false);
            setShowMessage(false);
          }}
          type="button"
        >
          {messages.map(({ id, text }, messageIndex) => {
            const words = text.split(" ");
            return (
              <span
                aria-hidden="true"
                className="about-author-line"
                data-active={current === messageIndex}
                key={id}
              >
                {words.map((word, wordIndex) => (
                  <span
                    className="about-author-word"
                    key={words.slice(0, wordIndex + 1).join(" ")}
                  >
                    {Array.from(word, (letter, letterIndex) => (
                      <span
                        className="about-author-letter-window"
                        key={word.slice(0, letterIndex + 1)}
                      >
                        <span
                          className="about-author-letter"
                          style={
                            {
                              "--letter-delay": `${Math.min(wordIndex * 3 + letterIndex, 8) * 18}ms`,
                            } as CSSProperties
                          }
                        >
                          {letter}
                        </span>
                      </span>
                    ))}
                  </span>
                ))}
              </span>
            );
          })}
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("aboutAuthorHint")}</TooltipContent>
    </Tooltip>
  );
}
