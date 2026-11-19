import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute, requireRole } from "@/routes/app";
import { UpdatesPage } from "./updates-page";

const updatesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/updates",
  beforeLoad: requireRole("superadmin"),
  component: UpdatesPage,
});

export const routes: AnyRoute[] = [updatesRoute];
