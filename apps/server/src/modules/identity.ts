import { Hono } from "hono";
import {
  iamSettingsInputSchema,
  identityRequestInputSchema,
  type IamSettings,
  type IdentityOptions,
} from "@helpdesk/shared/api/identity";
import type { CheckResult } from "@helpdesk/shared/api/common";
import { idSchema } from "@helpdesk/shared/api/common";
import { getDb } from "../db/client";
import { audit } from "../core/audit";
import { encryptSecret, secretHint } from "../core/crypto";
import { getStoredIam, putSetting, type StoredIam } from "../core/settings";
import type { AppEnv } from "../http/env";
import { AppError, notFound } from "../http/errors";
import { jsonBody, numberParam, requireStaff, requireSuperadmin } from "../http/middleware";
import { loadTicketDetail } from "../tickets/queries";
import { iamClient, iamConfigured, IamError } from "../identity/iam";
import { cancelIdentityRequest, sendIdentityRequest } from "../identity/service";

/** Meldgrove IAM: the connection (superadmins) and identity requests from tickets (staff). */
const router = new Hono<AppEnv>();

function iamView(stored: StoredIam): IamSettings {
  return { url: stored.url, apiKeyHint: stored.apiKeyHint, mapping: stored.mapping };
}

router.get("/integrations/iam", async (c) => {
  requireSuperadmin(c);
  return c.json(iamView(await getStoredIam(getDb())));
});

router.put("/integrations/iam", async (c) => {
  const actor = requireSuperadmin(c);
  const input = await jsonBody(c, iamSettingsInputSchema);
  const stored = await getDb().transaction(async (tx) => {
    const current = await getStoredIam(tx);
    const next: StoredIam = {
      url: input.url.replace(/\/+$/, ""),
      apiKeyEncrypted:
        input.apiKey === null ? null : input.apiKey ? encryptSecret(input.apiKey) : current.apiKeyEncrypted,
      apiKeyHint: input.apiKey === null ? null : input.apiKey ? secretHint(input.apiKey) : current.apiKeyHint,
      mapping: input.mapping,
    };
    await putSetting(tx, "iam", next);
    await audit(tx, actor, {
      action: "integration.iam",
      entityType: "integration",
      entityId: "iam",
      summary: iamConfigured(next) ? "Set up IAM for identity requests" : "Turned identity requests off",
    });
    return next;
  });
  return c.json(iamView(stored));
});

/** Checks the saved connection: IAM answers with the person types it accepts. */
router.post("/integrations/iam/test", async (c) => {
  requireSuperadmin(c);
  const started = Date.now();
  let result: CheckResult;
  try {
    const options = await iamClient(await getStoredIam(getDb())).options();
    result = {
      ok: true,
      message:
        options.personTypes.length === 0
          ? "Connected. IAM accepts no identity requests yet: choose person types in IAM's Admin › Settings."
          : `Connected. IAM accepts requests for: ${options.personTypes.map((type) => type.label).join(", ")}.`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    if (!(error instanceof IamError)) throw error;
    result = { ok: false, message: error.message, latencyMs: Date.now() - started };
  }
  return c.json(result);
});

/** What the request dialog needs. Without a connection: `configured` is false. */
router.get("/identity/options", async (c) => {
  requireStaff(c);
  const stored = await getStoredIam(getDb());
  const empty: IdentityOptions = { configured: false, personTypes: [], teams: [], mapping: stored.mapping };
  if (!iamConfigured(stored)) return c.json(empty);
  try {
    const options = await iamClient(stored).options();
    return c.json({ ...empty, configured: true, ...options } satisfies IdentityOptions);
  } catch (error) {
    if (!(error instanceof IamError)) throw error;
    throw new AppError(502, "iam_unavailable", error.message);
  }
});

async function ticketDetail(number: number) {
  const ticket = await loadTicketDetail(getDb(), number);
  if (!ticket) throw notFound("Ticket not found");
  return ticket;
}

router.post("/tickets/:number/identity-requests", async (c) => {
  const actor = requireStaff(c);
  const number = numberParam(c);
  await sendIdentityRequest(actor, number, await jsonBody(c, identityRequestInputSchema));
  return c.json(await ticketDetail(number), 201);
});

router.post("/tickets/:number/identity-requests/:id/cancel", async (c) => {
  const actor = requireStaff(c);
  const number = numberParam(c);
  const id = idSchema.safeParse(c.req.param("id"));
  if (!id.success) throw notFound("Request not found");
  await cancelIdentityRequest(actor, number, id.data);
  return c.json(await ticketDetail(number));
});

export default router;
