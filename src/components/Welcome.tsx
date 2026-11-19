import { FolderOpen, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyStateCard } from "@/components/EmptyStateCard";

interface WelcomeProps {
  isImporting?: boolean;
  onAddFolder: () => void;
}

export function Welcome({ onAddFolder, isImporting }: WelcomeProps) {
  const { t } = useTranslation();

  return (
    <div className="welcome-empty-state flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-8">
      <EmptyStateCard
        actions={
          isImporting
            ? []
            : [
                {
                  label: t("sidebarAddFolder"),
                  onClick: onAddFolder,
                  primary: true,
                },
              ]
        }
        description={
          isImporting
            ? t("emptyImportingDescription")
            : t("emptyWelcomeDescription")
        }
        icon={
          isImporting ? (
            <LoaderCircle className="h-5 w-5 animate-spin" />
          ) : (
            <FolderOpen className="h-5 w-5" />
          )
        }
        title={isImporting ? t("emptyImportingTitle") : t("emptyWelcomeTitle")}
      />
    </div>
  );
}
