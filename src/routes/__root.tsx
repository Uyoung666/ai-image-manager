import {
  createRootRoute,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Suspense, useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { consumeUpdateWelcome } from "@/actions/update-changelog";
import DragWindowRegion from "@/components/drag-window-region";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { StartupSplash } from "@/components/startup-splash";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ScrollPositionProvider } from "@/contexts/ScrollPositionContext";
import BaseLayout from "@/layouts/base-layout";
import {
  STARTUP_HOME_READY_EVENT,
  STARTUP_ONBOARDING_STATE_EVENT,
  type StartupOnboardingStateDetail,
} from "@/utils/startup-readiness";

const STARTUP_READY_TIMEOUT_MS = 15_000;
const STARTUP_SPLASH_FADE_MS = 180;

function RouteSuspense() {
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingSpinner size="xl" />
    </div>
  );
}

function Root() {
  const location = useLocation();
  const navigate = useNavigate();
  const isTestEnvironment = Boolean(
    window.electronAPI?.isE2E || !window.electronAPI?.preloadReady
  );
  const [startupReady, setStartupReady] = useState(isTestEnvironment);
  const [onboardingStateKnown, setOnboardingStateKnown] =
    useState(isTestEnvironment);
  const [needsOnboarding, setNeedsOnboarding] = useState(isTestEnvironment);
  const [homeReady, setHomeReady] = useState(isTestEnvironment);
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const [renderSplash, setRenderSplash] = useState(!isTestEnvironment);
  const [splashExiting, setSplashExiting] = useState(false);

  useLayoutEffect(() => {
    const handleHomeReady = () => {
      setHomeReady(true);
    };
    const handleOnboardingState = (event: Event) => {
      const detail = (event as CustomEvent<StartupOnboardingStateDetail>)
        .detail;
      if (!detail) {
        return;
      }
      setNeedsOnboarding(detail.needsOnboarding);
      setOnboardingStateKnown(true);
    };

    window.addEventListener(STARTUP_HOME_READY_EVENT, handleHomeReady);
    window.addEventListener(
      STARTUP_ONBOARDING_STATE_EVENT,
      handleOnboardingState
    );

    return () => {
      window.removeEventListener(STARTUP_HOME_READY_EVENT, handleHomeReady);
      window.removeEventListener(
        STARTUP_ONBOARDING_STATE_EVENT,
        handleOnboardingState
      );
    };
  }, []);

  useEffect(() => {
    let active = true;

    if (isTestEnvironment) {
      return () => {
        active = false;
      };
    }

    consumeUpdateWelcome()
      .then(({ version }) => {
        if (!active) {
          return;
        }

        if (!version) {
          setStartupReady(true);
          return;
        }

        return navigate({
          to: "/whats-new",
          search: { version },
          replace: true,
        }).finally(() => {
          if (active) {
            setStartupReady(true);
          }
        });
      })
      .catch((error) => {
        console.error("Failed to check update welcome state", error);
        if (active) {
          setStartupReady(true);
        }
      });

    return () => {
      active = false;
    };
  }, [isTestEnvironment, navigate]);

  const isHomeRoute = location.pathname === "/";
  const surfaceReady = onboardingStateKnown && (needsOnboarding || homeReady);
  const startupWaiting = !startupReady || (isHomeRoute && !surfaceReady);
  const shouldShowSplash = !startupTimedOut && startupWaiting;

  useEffect(() => {
    if (isTestEnvironment || startupTimedOut || !startupWaiting) {
      return;
    }

    const timeout = window.setTimeout(() => {
      console.warn(
        "[startup] Initial surface readiness timed out; revealing fallback UI"
      );
      setStartupTimedOut(true);
    }, STARTUP_READY_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [isTestEnvironment, startupTimedOut, startupWaiting]);

  useEffect(() => {
    if (shouldShowSplash) {
      setRenderSplash(true);
      setSplashExiting(false);
      return;
    }

    if (!renderSplash) {
      return;
    }

    setSplashExiting(true);
    const timeout = window.setTimeout(() => {
      setRenderSplash(false);
      setSplashExiting(false);
    }, STARTUP_SPLASH_FADE_MS);

    return () => window.clearTimeout(timeout);
  }, [renderSplash, shouldShowSplash]);

  const content = (
    <ErrorBoundary>
      <Suspense fallback={<RouteSuspense />}>
        <Outlet />
      </Suspense>
    </ErrorBoundary>
  );

  return (
    <>
      <TooltipProvider>
        <ScrollPositionProvider>
          {location.pathname === "/whats-new" ? (
            <StandaloneLayout>{content}</StandaloneLayout>
          ) : (
            <BaseLayout>{content}</BaseLayout>
          )}
        </ScrollPositionProvider>
      </TooltipProvider>
      {renderSplash && <StartupSplash exiting={splashExiting} />}
    </>
  );
}

function StandaloneLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <DragWindowRegion title="AI Image Manager" />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

function RootError() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-dvh min-w-0 flex-col items-center justify-center gap-3 overflow-y-auto px-4 py-4 text-center sm:px-6">
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
      <div className="min-w-0 max-w-full">
        <p className="font-medium text-[13px] text-foreground">
          {t("routeErrorTitle")}
        </p>
        <p className="mt-1 break-words text-[12px] text-muted-foreground">
          {t("routeErrorDescription")}
        </p>
      </div>
      <button
        className="rounded-[6px] bg-primary/10 px-3 py-1.5 font-medium text-[12px] text-primary transition-colors hover:bg-primary/20"
        onClick={() => window.location.reload()}
        type="button"
      >
        {t("refresh")}
      </button>
    </div>
  );
}

export const Route = createRootRoute({
  component: Root,
  errorComponent: RootError,
});
