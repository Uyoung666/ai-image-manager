import { createFileRoute } from "@tanstack/react-router";
import { RouteError } from "@/components/RouteError";
import { ShootingProjectWorkspace } from "@/components/ShootingProjectWorkspace";

function ShootingProjectPage() {
  const { projectId } = Route.useParams();
  return <ShootingProjectWorkspace key={projectId} projectId={projectId} />;
}

export const Route = createFileRoute("/shooting-projects/$projectId")({
  component: ShootingProjectPage,
  errorComponent: RouteError,
});
