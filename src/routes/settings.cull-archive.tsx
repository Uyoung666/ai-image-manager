import { createFileRoute } from "@tanstack/react-router";
import { RouteError } from "@/components/RouteError";
import { CullListPage } from "@/routes/cull";

export const Route = createFileRoute("/settings/cull-archive")({
  component: () => <CullListPage archivedView />,
  errorComponent: RouteError,
});
