import {
  createFileRoute,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { RouteError } from "@/components/RouteError";

function ShootingProjectsLayout() {
  const navigate = useNavigate();
  const childMatch = useMatch({
    from: "/shooting-projects/$projectId",
    shouldThrow: false,
  });
  useEffect(() => {
    if (!childMatch) {
      navigate({ to: "/cull", replace: true });
    }
  }, [childMatch, navigate]);
  return childMatch ? <Outlet /> : null;
}

export const Route = createFileRoute("/shooting-projects")({
  component: ShootingProjectsLayout,
  errorComponent: RouteError,
});
