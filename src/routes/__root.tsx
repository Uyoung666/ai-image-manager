import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import BaseLayout from "@/layouts/base-layout";

function RouteSuspense() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function Root() {
  return (
    <BaseLayout>
      <ErrorBoundary>
        <Suspense fallback={<RouteSuspense />}>
          <Outlet />
        </Suspense>
      </ErrorBoundary>
    </BaseLayout>
  );
}

function RootError() {
  const { t } = useTranslation();

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
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
        <p className="font-medium text-[13px] text-foreground">
          {t("routeErrorTitle")}
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {t("routeErrorDescription")}
        </p>
      </div>
      <button
        className="rounded-[6px] bg-primary/10 px-3 py-1.5 font-medium text-[12px] text-primary transition-colors hover:bg-primary/20"
        onClick={() => window.location.reload()}
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
