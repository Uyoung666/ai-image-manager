import { useTranslation } from "react-i18next";
import { setAppLanguage } from "@/actions/language";
import langs from "@/localization/langs";

export default function LangToggle() {
  const { i18n } = useTranslation();
  const currentLang = i18n.language;

  function onValueChange(value: string) {
    setAppLanguage(value, i18n);
  }

  return (
    <>
      <style>{`
        .lang-radio-group {
          position: relative;
          display: flex;
          flex-wrap: wrap;
          height: 32px;
          border-radius: 0.5rem;
          background-color: var(--muted);
          box-sizing: border-box;
          box-shadow: 0 0 0px 1px rgba(0, 0, 0, 0.06);
          padding: 0.25rem;
          width: min(200px, 100%);
          max-width: 100%;
          font-size: 12px;
        }
        .lang-radio-group .lang-radio {
          min-width: 0;
          flex: 1 1 auto;
          text-align: center;
        }
        .lang-radio-group .lang-radio input {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        .lang-radio-group .lang-radio .lang-name {
          display: flex;
          cursor: pointer;
          align-items: center;
          justify-content: center;
          border-radius: 0.5rem;
          border: none;
          overflow-wrap: anywhere;
          height: 24px;
          padding: 0 0.25rem;
          color: var(--muted-foreground);
          transition: all 0.15s ease-in-out;
          user-select: none;
        }
        .lang-radio-group .lang-radio:hover .lang-name {
          background-color: color-mix(in srgb, var(--surface) 50%, transparent);
        }
        .lang-radio-group .lang-radio input:checked + .lang-name {
          background-color: var(--surface);
          color: var(--foreground);
          font-weight: 600;
          position: relative;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
          animation: lang-select 0.3s ease;
        }
        .lang-radio-group .lang-radio input:focus-visible + .lang-name {
          outline: 2px solid var(--ring);
          outline-offset: 2px;
        }
        @keyframes lang-select {
          0% {
            transform: scale(0.95);
          }
          50% {
            transform: scale(1.05);
          }
          100% {
            transform: scale(1);
          }
        }
        .lang-radio-group .lang-radio input:checked + .lang-name::before,
        .lang-radio-group .lang-radio input:checked + .lang-name::after {
          content: "";
          position: absolute;
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: var(--primary);
          opacity: 0;
          animation: lang-particles 0.5s ease forwards;
        }
        .lang-radio-group .lang-radio input:checked + .lang-name::before {
          top: -8px;
          left: 50%;
          transform: translateX(-50%);
          --direction: -10px;
        }
        .lang-radio-group .lang-radio input:checked + .lang-name::after {
          bottom: -8px;
          left: 50%;
          transform: translateX(-50%);
          --direction: 10px;
        }
        @keyframes lang-particles {
          0% {
            opacity: 0;
            transform: translateX(-50%) translateY(0);
          }
          50% {
            opacity: 1;
          }
          100% {
            opacity: 0;
            transform: translateX(-50%) translateY(var(--direction));
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .lang-radio-group .lang-radio .lang-name,
          .lang-radio-group .lang-radio input:checked + .lang-name,
          .lang-radio-group .lang-radio input:checked + .lang-name::before,
          .lang-radio-group .lang-radio input:checked + .lang-name::after {
            animation: none;
            transition: none;
          }
        }
      `}</style>
      <div className="lang-radio-group">
        {langs.map((lang) => (
          <label className="lang-radio" key={lang.key}>
            <input
              checked={currentLang === lang.key}
              name="language"
              onChange={() => onValueChange(lang.key)}
              type="radio"
            />
            <span className="lang-name">{lang.prefix}</span>
          </label>
        ))}
      </div>
    </>
  );
}
