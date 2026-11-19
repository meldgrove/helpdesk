import type { AnyRoute } from "@tanstack/react-router";
import { routes as audit } from "./audit/routes";
import { routes as board } from "./board/routes";
import { routes as formEditor } from "./form-editor/routes";
import { routes as integrations } from "./integrations/routes";
import { routes as people } from "./people/routes";
import { routes as profile } from "./profile/routes";
import { routes as requests } from "./requests/routes";
import { routes as tickets } from "./tickets/routes";
import { routes as updates } from "./updates/routes";

/** Routes of every module inside the signed-in app. Add new modules here. */
export const appRoutes: AnyRoute[] = [
  ...board,
  ...tickets,
  ...requests,
  ...formEditor,
  ...people,
  ...integrations,
  ...audit,
  ...updates,
  ...profile,
];
