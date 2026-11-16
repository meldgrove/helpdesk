import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { meUpdateSchema, type AuthConfig, type Me } from "@helpdesk/shared/api/users";
import { pickLocaleFromHeader } from "../core/locale";
import { config } from "../config";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { getStoredSlack } from "../core/settings";
import type { AppEnv } from "../http/env";
import { jsonBody, requireUser } from "../http/middleware";
import type { UserPrincipal } from "../auth/principal";

const router = new Hono<AppEnv>();

router.get("/auth-config", (c) => {
  const body: AuthConfig = { appName: config().APP_NAME, providerName: config().OIDC_PROVIDER_NAME };
  return c.json(body);
});

async function me(principal: UserPrincipal): Promise<Me> {
  const slack = await getStoredSlack(getDb());
  return {
    id: principal.id,
    email: principal.email,
    name: principal.name || principal.email,
    role: principal.role,
    image: principal.image,
    notifyVia: principal.notifyVia,
    locale: principal.locale,
    slackAvailable: Boolean(slack.botTokenEncrypted),
  };
}

router.get("/me", async (c) => {
  const principal = requireUser(c);
  // Emails need a language before the person ever picks one: take the browser's.
  if (!principal.locale) {
    const locale = pickLocaleFromHeader(c.req.header("accept-language"));
    if (locale) {
      await getDb().update(users).set({ locale }).where(eq(users.id, principal.id));
      principal.locale = locale;
    }
  }
  return c.json(await me(principal));
});

router.patch("/me", async (c) => {
  const principal = requireUser(c);
  const input = await jsonBody(c, meUpdateSchema);
  await getDb()
    .update(users)
    .set({ ...input, updatedAt: sql`now()` })
    .where(eq(users.id, principal.id));
  return c.json(await me({ ...principal, ...input }));
});

export default router;
