import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export function ErrorBoundaryMessage({ error }: { error: Error }) {
  const { t } = useTranslation();

  return (
    <>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
        <svg
          aria-hidden="true"
          className="h-5 w-5 text-danger"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
        >
          <path
            d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div>
        <p className="font-[510] text-[13px] text-foreground">
          {t("errorBoundaryTitle")}
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {error.message || t("errorUnknown")}
        </p>
      </div>
    </>
  );
}

function ErrorBoundaryInner({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <ErrorBoundaryMessage error={error} />
      <button
        className="rounded-[6px] bg-primary/10 px-3 py-1.5 font-[510] text-[12px] text-primary transition-colors hover:bg-primary/20"
        onClick={onReset}
      >
        {t("aiRetry")}
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error.message, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <ErrorBoundaryInner error={this.state.error} onReset={this.handleReset} />;
    }

    return this.props.children;
  }
}
