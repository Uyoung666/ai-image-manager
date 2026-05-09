import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { inDevelopment } from "@/constants";
import BaseLayout from "@/layouts/base-layout";

function Root() {
  return (
    <BaseLayout>
      <Outlet />
      {inDevelopment && <TanStackRouterDevtools />}
    </BaseLayout>
  );
}

export const Route = createRootRoute({
  component: Root,
});
