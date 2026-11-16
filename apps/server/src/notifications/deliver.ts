import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { notifications, users } from "../db/schema";
import { getStoredEmail, getStoredSlack } from "../core/settings";
import { logger } from "../logger";
import {
  DeliveryError,
  emailTransportFor,
  slackTransportFor,
  type EmailTransport,
  type SlackTransport,
} from "./transports";

/** Attempts before a notification counts as failed. */
export const MAX_ATTEMPTS = 5;
/** Waits before the next attempt, by attempts so far. */
const BACKOFF_SECONDS = [30, 120, 600, 1800];
const LEASE_SECONDS = 120;

type Row = typeof notifications.$inferSelect;
type Outcome = { status: "sent" | "skipped"; note?: string };

/** Claims due notifications: pending ones, and ones whose sender stopped before finishing. */
async function claim(limit: number): Promise<Row[]> {
  const result = await getDb().execute<Record<string, unknown>>(sql`
    update notifications set status = 'sending', attempts = attempts + 1,
      lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
    where id in (
      select id from notifications
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'sending' and lease_until < now())
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id`);
  const ids = result.rows.map((row) => String(row.id));
  if (ids.length === 0) return [];
  return getDb().select().from(notifications).where(inArray(notifications.id, ids));
}

type Transports = { email: EmailTransport | null; slack: SlackTransport | null };

async function loadTransports(): Promise<Transports> {
  const db = getDb();
  const [email, slack] = await Promise.all([getStoredEmail(db), getStoredSlack(db)]);
  return { email: emailTransportFor(email), slack: slackTransportFor(slack) };
}

async function slackUserId(slack: SlackTransport, row: Row): Promise<string | null> {
  if (row.recipientUserId) {
    const [person] = await getDb()
      .select({ slackUserId: users.slackUserId, email: users.email })
      .from(users)
      .where(eq(users.id, row.recipientUserId));
    if (person?.slackUserId && person.email === row.recipient) return person.slackUserId;
  }
  const id = await slack.lookupUserByEmail(row.recipient);
  if (id && row.recipientUserId) {
    await getDb().update(users).set({ slackUserId: id }).where(eq(users.id, row.recipientUserId));
  }
  return id;
}

async function send(row: Row, transports: Transports): Promise<Outcome> {
  switch (row.channel) {
    case "email": {
      if (!transports.email) return { status: "skipped", note: "Email is not set up" };
      await transports.email.send({
        to: row.recipient,
        subject: row.subject,
        text: row.text,
        html: row.html ?? "",
      });
      return { status: "sent" };
    }
    case "slack_channel": {
      if (!transports.slack) return { status: "skipped", note: "Slack is not set up" };
      await transports.slack.postMessage(row.recipient, row.text);
      return { status: "sent" };
    }
    case "slack_dm": {
      const fallback = async (reason: string): Promise<Outcome> => {
        if (!transports.email || !row.fallbackText) return { status: "skipped", note: reason };
        await transports.email.send({
          to: row.recipient,
          subject: row.subject,
          text: row.fallbackText,
          html: row.html ?? "",
        });
        return { status: "sent", note: `${reason}; sent by email` };
      };
      if (!transports.slack) return fallback("Slack is not set up");
      try {
        const userId = await slackUserId(transports.slack, row);
        if (!userId) return fallback("No Slack account has this email address");
        await transports.slack.postMessage(userId, row.text);
        return { status: "sent" };
      } catch (error) {
        // Slack refuses for good (e.g. a missing scope), or for the last time: email instead.
        if (error instanceof DeliveryError && (error.permanent || row.attempts >= MAX_ATTEMPTS)) {
          return fallback(`Slack failed (${error.code ?? "error"})`);
        }
        throw error;
      }
    }
    default:
      return { status: "skipped", note: `Unknown channel ${row.channel}` };
  }
}

/** Sends due notifications; returns how many it handled. */
export async function deliverDue(limit = 20): Promise<number> {
  const rows = await claim(limit);
  if (rows.length === 0) return 0;
  const transports = await loadTransports();
  for (const row of rows) {
    try {
      const outcome = await send(row, transports);
      await getDb()
        .update(notifications)
        .set({
          status: outcome.status,
          sentAt: outcome.status === "sent" ? new Date() : null,
          lastError: outcome.note ?? null,
          leaseUntil: null,
        })
        .where(eq(notifications.id, row.id));
      logger.info(
        { notificationId: row.id, code: outcome.status, channel: row.channel },
        "notification handled",
      );
    } catch (error) {
      const permanent = error instanceof DeliveryError && error.permanent;
      const finalAttempt = permanent || row.attempts >= MAX_ATTEMPTS;
      const message = error instanceof DeliveryError ? error.message : "Unexpected error while sending";
      const wait = BACKOFF_SECONDS[Math.min(row.attempts - 1, BACKOFF_SECONDS.length - 1)]!;
      await getDb()
        .update(notifications)
        .set({
          status: finalAttempt ? "failed" : "pending",
          lastError: message,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + wait * 1000),
        })
        .where(eq(notifications.id, row.id));
      if (error instanceof DeliveryError) {
        logger.warn(
          {
            notificationId: row.id,
            channel: row.channel,
            code: error.code,
            permanent,
            attempt: row.attempts,
          },
          "notification not sent",
        );
      } else {
        logger.error({ err: error, notificationId: row.id, channel: row.channel }, "notification failed");
      }
    }
  }
  return rows.length;
}

/** Removes handled notifications after 90 days. */
export async function pruneNotifications(): Promise<number> {
  const result = await getDb()
    .delete(notifications)
    .where(
      and(
        inArray(notifications.status, ["sent", "skipped", "failed"]),
        lt(notifications.createdAt, new Date(Date.now() - 90 * 24 * 60 * 60_000)),
      ),
    );
  return result.rowCount ?? 0;
}
