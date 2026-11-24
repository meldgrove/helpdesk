import { Hono } from "hono";
import { createUpdatesHandler } from "@meldgrove/ui/updates/server";
import type { UpdateChannel, UpdatesResponse } from "@meldgrove/ui/updates/core";
import { config } from "../config";
import { getDb } from "../db/client";
import { audit } from "../core/audit";
import type { AppEnv } from "../http/env";
import { requireSuperadmin } from "../http/middleware";
import { logger } from "../logger";

/**
 * In-app updates for superadmins: the Meldgrove Updater's status, a check,
 * an installation and the channel
 * (https://github.com/meldgrove/updater#the-apps-update-button). The routes
 * check the role (the API's same-origin check covers the POSTs) and record
 * changes in the audit log; `@meldgrove/ui/updates/server` checks the body,
 * asks the updater with UPDATER_TOKEN, and answers with `UpdatesResponse`.
 */
const router = new Hono<AppEnv>();

const updates = createUpdatesHandler(() => ({
  url: config().UPDATER_URL,
  token: config().UPDATER_TOKEN,
  appVersion: config().APP_VERSION ?? null,
  logger,
}));

/**
 * The value the updater took: the request's `version` or `channel`, when
 * the answer is a success with the updater's status and no error. The
 * handler accepted it, so it matches the contract's pattern.
 */
async function accepted(request: Request, response: Response, field: "version" | "channel") {
  if (!response.ok) return null;
  const answer = (await response.clone().json()) as UpdatesResponse;
  if (!answer.reachable || answer.error !== null) return null;
  const value = ((await request.json()) as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

router.get("/updates", (c) => {
  requireSuperadmin(c);
  return updates.respond("status");
});

router.post("/updates/check", (c) => {
  requireSuperadmin(c);
  return updates.respond("check");
});

router.post("/updates/install", async (c) => {
  const actor = requireSuperadmin(c);
  const request = c.req.raw.clone();
  const response = await updates.respond("install", c.req.raw);
  const version = await accepted(request, response, "version");
  if (version) {
    await audit(getDb(), actor, {
      action: "update.install",
      entityType: "update",
      entityId: version,
      summary: `Started the update to ${version}`,
    });
  }
  return response;
});

router.post("/updates/channel", async (c) => {
  const actor = requireSuperadmin(c);
  const request = c.req.raw.clone();
  const response = await updates.respond("channel", c.req.raw);
  const channel = (await accepted(request, response, "channel")) as UpdateChannel | null;
  if (channel) {
    await audit(getDb(), actor, {
      action: "update.channel",
      entityType: "update",
      entityId: channel,
      summary: channel === "preview" ? "Switched updates to Preview" : "Switched updates to Stable",
    });
  }
  return response;
});

export default router;
