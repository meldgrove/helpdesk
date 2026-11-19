import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  updateChannelInputSchema,
  updateInstallInputSchema,
  type UpdatesResponse,
} from "@helpdesk/shared/api/updates";
import { config } from "../config";
import { getDb } from "../db/client";
import { audit } from "../core/audit";
import type { AppEnv } from "../http/env";
import { jsonBody, requireSuperadmin } from "../http/middleware";
import { logger } from "../logger";
import { createUpdaterClient, type UpdaterClient, type UpdaterResult } from "../updates/client";

/**
 * In-app updates for superadmins: the Meldgrove Updater's status, a check,
 * an installation and the channel
 * (https://github.com/meldgrove/updater#the-apps-update-button). Every route
 * answers with `UpdatesResponse`: an updater error answer becomes 409 with
 * `error` and the latest status (the install route passes a 5xx through: the
 * installation may have started); no answer from UPDATER_URL (or an empty
 * UPDATER_URL) is 200 with `reachable: false`.
 */
const router = new Hono<AppEnv>();

const OFF = "No update service is set up (UPDATER_URL is empty).";

function updaterClient(): UpdaterClient | null {
  const url = config().UPDATER_URL;
  return url ? createUpdaterClient(url) : null;
}

async function respond(
  c: Context<AppEnv>,
  client: UpdaterClient | null,
  result: UpdaterResult | null,
  options: { success?: 200 | 202; passServerErrors?: boolean } = {},
) {
  const app = { version: config().APP_VERSION ?? null };
  let body: UpdatesResponse;
  let status: ContentfulStatusCode = 200;
  if (!client || !result) {
    body = { app, reachable: false, updater: null, error: OFF };
  } else if (result.kind === "ok") {
    body = { app, reachable: true, updater: result.status, error: null };
    status = options.success ?? 200;
  } else if (result.kind === "unreachable") {
    logger.warn({ route: c.req.routePath, problem: "unreachable" }, "update service not reachable");
    body = { app, reachable: false, updater: null, error: result.error };
  } else {
    logger.warn({ route: c.req.routePath, status: result.httpStatus }, "update service refused");
    const latest = c.req.method === "GET" ? null : await client.status();
    body = {
      app,
      reachable: true,
      updater: latest?.kind === "ok" ? latest.status : null,
      error: result.error,
    };
    status =
      options.passServerErrors && result.httpStatus >= 500 && result.httpStatus <= 599
        ? (result.httpStatus as ContentfulStatusCode)
        : 409;
  }
  return c.json(body, status);
}

router.get("/updates", async (c) => {
  requireSuperadmin(c);
  const client = updaterClient();
  return respond(c, client, client ? await client.status() : null);
});

router.post("/updates/check", async (c) => {
  requireSuperadmin(c);
  const client = updaterClient();
  return respond(c, client, client ? await client.check() : null);
});

router.post("/updates/install", async (c) => {
  const actor = requireSuperadmin(c);
  const { version } = await jsonBody(c, updateInstallInputSchema);
  const client = updaterClient();
  const result = client ? await client.install(version) : null;
  if (result?.kind === "ok") {
    await audit(getDb(), actor, {
      action: "update.install",
      entityType: "update",
      entityId: version,
      summary: `Started the update to ${version}`,
    });
  }
  return respond(c, client, result, { success: 202, passServerErrors: true });
});

router.post("/updates/channel", async (c) => {
  const actor = requireSuperadmin(c);
  const { channel } = await jsonBody(c, updateChannelInputSchema);
  const client = updaterClient();
  const result = client ? await client.channel(channel) : null;
  if (result?.kind === "ok") {
    await audit(getDb(), actor, {
      action: "update.channel",
      entityType: "update",
      entityId: channel,
      summary: channel === "preview" ? "Switched updates to Preview" : "Switched updates to Stable",
    });
  }
  return respond(c, client, result);
});

export default router;
