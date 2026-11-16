import { Hono } from "hono";
import { count, desc, eq } from "drizzle-orm";
import {
  emailSettingsInputSchema,
  emailTestSchema,
  REQUIRED_SLACK_SCOPES,
  OPTIONAL_SLACK_SCOPES,
  slackSettingsInputSchema,
  type EmailSettings,
  type SlackSettings,
} from "@helpdesk/shared/api/integrations";
import { pageQuerySchema, type CheckResult } from "@helpdesk/shared/api/common";
import { config } from "../config";
import { getDb } from "../db/client";
import { notifications, tickets } from "../db/schema";
import { audit } from "../core/audit";
import { decryptSecret, encryptSecret, secretHint } from "../core/crypto";
import {
  getStoredEmail,
  getStoredSlack,
  putSetting,
  type StoredEmail,
  type StoredSlack,
} from "../core/settings";
import type { AppEnv } from "../http/env";
import { conflict, validationError } from "../http/errors";
import { jsonBody, queryOf, requireSuperadmin } from "../http/middleware";
import { createSlackApi, DeliveryError, emailTransportFor } from "../notifications/transports";
import { testEmail } from "../notifications/templates";
import { localeOf } from "../notifications/enqueue";
import { iso, isoRequired } from "./util";

/** Email and Slack, set up by superadmins. Secrets are stored encrypted and shown only as hints. */
const router = new Hono<AppEnv>();

function emailView(stored: StoredEmail): EmailSettings {
  return {
    provider: stored.provider,
    fromAddress: stored.fromAddress,
    fromName: stored.fromName,
    smtp: {
      host: stored.smtp.host,
      port: stored.smtp.port,
      security: stored.smtp.security,
      username: stored.smtp.username,
      passwordHint: stored.smtp.passwordHint,
    },
    mailersend: { tokenHint: stored.mailersend.tokenHint },
  };
}

router.get("/integrations/email", async (c) => {
  requireSuperadmin(c);
  return c.json(emailView(await getStoredEmail(getDb())));
});

router.put("/integrations/email", async (c) => {
  const actor = requireSuperadmin(c);
  const input = await jsonBody(c, emailSettingsInputSchema);
  const stored = await getDb().transaction(async (tx) => {
    const current = await getStoredEmail(tx);
    if (input.provider === "mailersend" && !input.mailersend.token && !current.mailersend.tokenEncrypted) {
      throw validationError({ "mailersend.token": "Enter the API token" });
    }
    const next: StoredEmail = {
      provider: input.provider,
      fromAddress: input.fromAddress,
      fromName: input.fromName,
      smtp: {
        host: input.smtp.host,
        port: input.smtp.port,
        security: input.smtp.security,
        username: input.smtp.username,
        passwordEncrypted: input.smtp.password
          ? encryptSecret(input.smtp.password)
          : current.smtp.passwordEncrypted,
        passwordHint: input.smtp.password ? secretHint(input.smtp.password) : current.smtp.passwordHint,
      },
      mailersend: {
        tokenEncrypted: input.mailersend.token
          ? encryptSecret(input.mailersend.token)
          : current.mailersend.tokenEncrypted,
        tokenHint: input.mailersend.token ? secretHint(input.mailersend.token) : current.mailersend.tokenHint,
      },
    };
    await putSetting(tx, "email", next);
    await audit(tx, actor, {
      action: "integration.email",
      entityType: "integration",
      entityId: "email",
      summary: input.provider === "none" ? "Turned email off" : `Set up email over ${input.provider}`,
    });
    return next;
  });
  return c.json(emailView(stored));
});

router.post("/integrations/email/test", async (c) => {
  const actor = requireSuperadmin(c);
  const { to } = await jsonBody(c, emailTestSchema);
  const transport = emailTransportFor(await getStoredEmail(getDb()));
  if (!transport) throw conflict("Set up email first");
  const started = Date.now();
  let result: CheckResult;
  try {
    await transport.send({ to, ...testEmail(localeOf(actor), config().APP_NAME, config().APP_URL) });
    result = { ok: true, message: `Sent a test email to ${to}`, latencyMs: Date.now() - started };
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof DeliveryError ? error.message : "Sending failed",
      latencyMs: Date.now() - started,
    };
  }
  return c.json(result);
});

function slackView(stored: StoredSlack): SlackSettings {
  return {
    configured: Boolean(stored.botTokenEncrypted),
    botTokenHint: stored.botTokenHint,
    teamName: stored.teamName,
    botName: stored.botName,
    channelId: stored.channelId,
    channelName: stored.channelName,
    missingScopes: stored.missingScopes,
  };
}

/** auth.test with the scopes Slack reports in its response header. */
async function slackAuthTest(token: string) {
  let response: Response;
  try {
    response = await fetch(new URL("auth.test", config().SLACK_API_URL), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw validationError({ botToken: "Could not reach Slack. Try again." });
  }
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    team?: string;
    user?: string;
  } | null;
  if (!body?.ok) {
    throw validationError({
      botToken: `Slack rejected the token (${body?.error ?? `HTTP ${response.status}`})`,
    });
  }
  const scopes = new Set(
    (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  return {
    teamName: body.team ?? null,
    botName: body.user ?? null,
    missingScopes: [...REQUIRED_SLACK_SCOPES, ...OPTIONAL_SLACK_SCOPES].filter((scope) => !scopes.has(scope)),
  };
}

async function channelName(token: string, channelId: string): Promise<string | null> {
  try {
    const result = await createSlackApi(token).call("conversations.info", { channel: channelId });
    const channel = result.channel as { name?: string } | undefined;
    return channel?.name ?? null;
  } catch {
    return null;
  }
}

router.get("/integrations/slack", async (c) => {
  requireSuperadmin(c);
  return c.json(slackView(await getStoredSlack(getDb())));
});

router.put("/integrations/slack", async (c) => {
  const actor = requireSuperadmin(c);
  const input = await jsonBody(c, slackSettingsInputSchema);
  const current = await getStoredSlack(getDb());
  let next: StoredSlack;
  if (input.botToken === null) {
    next = {
      ...current,
      botTokenEncrypted: null,
      botTokenHint: null,
      teamName: null,
      botName: null,
      missingScopes: [],
    };
  } else if (input.botToken) {
    if (!input.botToken.startsWith("xoxb-"))
      throw validationError({ botToken: "A bot token starts with xoxb-" });
    const check = await slackAuthTest(input.botToken);
    next = {
      ...current,
      ...check,
      botTokenEncrypted: encryptSecret(input.botToken),
      botTokenHint: secretHint(input.botToken),
    };
  } else {
    next = { ...current };
  }
  next.channelId = input.channelId;
  next.channelName =
    input.channelId && next.botTokenEncrypted
      ? ((await channelName(decryptSecret(next.botTokenEncrypted), input.channelId)) ??
        (input.channelId === current.channelId ? current.channelName : null))
      : null;
  await getDb().transaction(async (tx) => {
    await putSetting(tx, "slack", next);
    await audit(tx, actor, {
      action: "integration.slack",
      entityType: "integration",
      entityId: "slack",
      summary: next.botTokenEncrypted
        ? `Set up Slack${next.channelName ? ` with the channel #${next.channelName}` : ""}`
        : "Disconnected Slack",
    });
  });
  return c.json(slackView(next));
});

router.get("/integrations/slack/channels", async (c) => {
  requireSuperadmin(c);
  const stored = await getStoredSlack(getDb());
  if (!stored.botTokenEncrypted) throw conflict("Connect Slack first");
  const api = createSlackApi(decryptSecret(stored.botTokenEncrypted));
  const items: { id: string; name: string; isPrivate: boolean; isMember: boolean }[] = [];
  let cursor = "";
  try {
    for (let page = 0; page < 10; page++) {
      const result = await api.call("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      const channels = (result.channels ?? []) as {
        id: string;
        name: string;
        is_private?: boolean;
        is_member?: boolean;
      }[];
      for (const channel of channels) {
        items.push({
          id: channel.id,
          name: channel.name,
          isPrivate: Boolean(channel.is_private),
          isMember: Boolean(channel.is_member),
        });
      }
      cursor = (result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      if (!cursor) break;
    }
  } catch (error) {
    throw conflict(
      error instanceof DeliveryError && error.code === "missing_scope"
        ? "The bot token lacks channels:read or groups:read. Enter the channel ID instead."
        : "Slack did not list the channels. Enter the channel ID instead.",
      "slack_channels",
    );
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ items });
});

router.post("/integrations/slack/test", async (c) => {
  requireSuperadmin(c);
  const stored = await getStoredSlack(getDb());
  if (!stored.botTokenEncrypted || !stored.channelId)
    throw conflict("Connect Slack and choose a channel first");
  const started = Date.now();
  let result: CheckResult;
  try {
    await createSlackApi(decryptSecret(stored.botTokenEncrypted)).call("chat.postMessage", {
      channel: stored.channelId,
      text: `:white_check_mark: ${config().APP_NAME} can post to this channel.`,
    });
    result = { ok: true, message: "Posted a test message to the channel", latencyMs: Date.now() - started };
  } catch (error) {
    const code = error instanceof DeliveryError ? error.code : undefined;
    result = {
      ok: false,
      message:
        code === "not_in_channel" || code === "channel_not_found"
          ? "The bot is not in this channel. Invite it in Slack (/invite @bot), then test again."
          : error instanceof DeliveryError
            ? error.message
            : "Posting failed",
      latencyMs: Date.now() - started,
    };
  }
  return c.json(result);
});

/** Recent emails and Slack messages, with their delivery state. */
router.get("/integrations/deliveries", async (c) => {
  requireSuperadmin(c);
  const query = queryOf(c, pageQuerySchema);
  const [rows, [total]] = await Promise.all([
    getDb()
      .select({ notification: notifications, number: tickets.number })
      .from(notifications)
      .leftJoin(tickets, eq(tickets.id, notifications.ticketId))
      .orderBy(desc(notifications.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    getDb().select({ value: count() }).from(notifications),
  ]);
  return c.json({
    items: rows.map(({ notification, number }) => ({
      id: notification.id,
      channel: notification.channel,
      kind: notification.kind,
      recipient: notification.recipient,
      status: notification.status,
      attempts: notification.attempts,
      lastError: notification.lastError,
      ticketNumber: number ?? null,
      createdAt: isoRequired(notification.createdAt),
      sentAt: iso(notification.sentAt),
    })),
    total: total?.value ?? 0,
  });
});

export default router;
