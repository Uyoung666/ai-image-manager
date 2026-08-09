import { useTranslation } from "react-i18next";

interface RouteErrorProps {
  error: Error;
  reset: () => void;
}

/**
 * 路由级错误边界组件。
 * 当页面数据加载失败时显示友好错误提示和重试按钮，而非空白页。
 */
export function RouteError({ error, reset }: RouteErrorProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <div className="text-center">
        <p className="font-medium text-[14px] text-foreground">
          {t("routeErrorTitle")}
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {error.message || t("routeErrorDescription")}
        </p>
      </div>
      <button
        className="rounded-[6px] bg-primary px-4 py-2 font-medium text-[13px] text-primary-foreground transition-colors hover:bg-primary/90"
        onClick={reset}
        type="button"
      >
        {t("refresh")}
      </button>
    </div>
  );
}
