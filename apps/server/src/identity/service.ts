import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import type { IdentityRequest, identityRequestInputSchema } from "@helpdesk/shared/api/identity";
import { config } from "../config";
import { getDb, type DbOrTx } from "../db/client";
import { identityRequests, ticketEvents, tickets, users } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { getStoredIam } from "../core/settings";
import { AppError, conflict, notFound, validationError } from "../http/errors";
import { logger } from "../logger";
import { iamClient, iamConfigured, IamError, type IamRequest } from "./iam";

/**
 * Identity requests: staff ask Meldgrove IAM for a new person from a ticket.
 * IAM keeps the request and decides; the helpdesk keeps what IAM last said
 * (`identity_requests`) and notes each step in the ticket's activity. The
 * worker asks IAM for news (`syncIdentityRequests`).
 */

type Row = typeof identityRequests.$inferSelect;
type Input = z.output<typeof identityRequestInputSchema>;

/** IAM's refusals as helpdesk errors, for staff. */
function asAppError(error: unknown): unknown {
  if (!(error instanceof IamError)) return error;
  switch (error.kind) {
    case "invalid":
      return error.fields && Object.keys(error.fields).length > 0
        ? validationError(error.fields, error.message)
        : new AppError(422, "iam_refused", error.message);
    case "unreachable":
    case "failed":
      return new AppError(502, "iam_unavailable", error.message);
    case "not_found":
      return notFound(error.message);
    default:
      return conflict(error.message, `iam_${error.kind}`);
  }
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asAppError(error);
  }
}

export function toView(row: Row, sentBy: { name: string | null; email: string } | null): IdentityRequest {
  return {
    id: row.id,
    name: row.name,
    personType: row.personType,
    status: (["open", "approved", "rejected", "cancelled"] as const).find((s) => s === row.status) ?? "open",
    reason: row.reason,
    personStatus: row.personStatus,
    workEmail: row.workEmail,
    url: row.url,
    sentBy: sentBy ? sentBy.name?.trim() || sentBy.email : null,
    createdAt: row.createdAt.toISOString(),
    checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
  };
}

/** The requests sent from a ticket, oldest first. */
export async function identityRequestsOf(db: DbOrTx, ticketId: string): Promise<IdentityRequest[]> {
  const rows = await db
    .select({ row: identityRequests, name: users.name, email: users.email })
    .from(identityRequests)
    .leftJoin(users, eq(users.id, identityRequests.sentById))
    .where(eq(identityRequests.ticketId, ticketId))
    .orderBy(asc(identityRequests.createdAt));
  return rows.map(({ row, name, email }) => toView(row, email === null ? null : { name, email }));
}

/** The activity entries an answer of IAM adds: a decision, and accounts that became ready. */
function changes(row: Row, answer: IamRequest): string[] {
  const steps: string[] = [];
  if (answer.status !== row.status) steps.push(answer.status);
  const personStatus = answer.person?.status ?? null;
  if (personStatus === "active" && row.personStatus !== "active") steps.push("active");
  return steps;
}

/** Saves IAM's answer under the row's lock and notes what changed in the ticket's activity. */
async function apply(id: string, answer: IamRequest, actorId: string | null): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(identityRequests).where(eq(identityRequests.id, id)).for("update");
    if (!row) return;
    const steps = changes(row, answer);
    await tx
      .update(identityRequests)
      .set({
        status: answer.status,
        reason: answer.reason,
        personStatus: answer.person?.status ?? null,
        workEmail: answer.person?.workEmail ?? null,
        url: answer.url || row.url,
        checkedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(identityRequests.id, id));
    if (steps.length > 0) {
      await tx.insert(ticketEvents).values(
        steps.map((to) => ({
          ticketId: row.ticketId,
          actorId,
          kind: "identity_request_changed",
          data: { name: row.name, to, reason: to === "rejected" ? answer.reason || null : null },
        })),
      );
    }
  });
}

/** Sends a request to IAM from a ticket. The same `submissionKey` again changes nothing. */
export async function sendIdentityRequest(actor: UserPrincipal, number: number, input: Input): Promise<void> {
  const db = getDb();
  const [ticket] = await db
    .select({ id: tickets.id, number: tickets.number })
    .from(tickets)
    .where(eq(tickets.number, number));
  if (!ticket) throw notFound("Ticket not found");
  const [sent] = await db
    .select({ ticketId: identityRequests.ticketId })
    .from(identityRequests)
    .where(eq(identityRequests.id, input.submissionKey));
  if (sent) {
    if (sent.ticketId !== ticket.id) throw conflict("This request was already sent", "duplicate_submission");
    return;
  }

  const client = await call(async () => iamClient(await getStoredIam(db)));
  const answer = await call(() =>
    client.create({
      externalId: `helpdesk:${input.submissionKey}`,
      externalUrl: `${config().APP_URL}/tickets/${ticket.number}`,
      requestedBy: { name: actor.name, email: actor.email },
      firstName: input.firstName,
      lastName: input.lastName,
      personalEmail: input.personalEmail,
      jobTitle: input.jobTitle,
      personType: input.personType,
      teamId: input.teamId,
      managerEmail: input.managerEmail,
      startDate: input.startDate,
      endDate: input.endDate,
      notes: input.notes,
    }),
  );
  const name = `${input.firstName} ${input.lastName}`.trim();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(identityRequests)
      .values({
        id: input.submissionKey,
        ticketId: ticket.id,
        iamId: answer.id,
        name,
        personType: input.personType,
        status: answer.status,
        reason: answer.reason,
        personStatus: answer.person?.status ?? null,
        workEmail: answer.person?.workEmail ?? null,
        url: answer.url,
        sentById: actor.id,
        checkedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning();
    // Sent twice at once: the other one recorded it.
    if (!row) return;
    await tx.insert(ticketEvents).values({
      ticketId: ticket.id,
      actorId: actor.id,
      kind: "identity_requested",
      data: { name, to: answer.status },
    });
  });
}

/** Withdraws an open request in IAM, e.g. when the contract fell through. */
export async function cancelIdentityRequest(actor: UserPrincipal, number: number, id: string): Promise<void> {
  const db = getDb();
  const [found] = await db
    .select({ row: identityRequests })
    .from(identityRequests)
    .innerJoin(tickets, eq(tickets.id, identityRequests.ticketId))
    .where(and(eq(identityRequests.id, id), eq(tickets.number, number)));
  if (!found) throw notFound("Request not found");
  const client = await call(async () => iamClient(await getStoredIam(db)));
  const answer = await call(() => client.cancel(found.row.iamId));
  await apply(id, answer, actor.id);
}

/** Requests IAM may still change: open ones, and approved ones whose accounts are not ready yet. */
const UNSETTLED = or(
  eq(identityRequests.status, "open"),
  and(
    eq(identityRequests.status, "approved"),
    or(
      isNull(identityRequests.personStatus),
      inArray(identityRequests.personStatus, ["planned", "onboarding"]),
    ),
  ),
);

/** Asks IAM what became of unsettled requests, least recently checked first. Returns how many changed. */
export async function syncIdentityRequests(limit = 100): Promise<number> {
  const stored = await getStoredIam(getDb());
  if (!iamConfigured(stored)) return 0;
  const client = iamClient(stored);
  const rows = await getDb()
    .select()
    .from(identityRequests)
    .where(UNSETTLED)
    .orderBy(sql`${identityRequests.checkedAt} asc nulls first`)
    .limit(limit);
  let changed = 0;
  for (const row of rows) {
    let answer: IamRequest;
    try {
      answer = await client.get(row.iamId);
    } catch (error) {
      if (!(error instanceof IamError)) throw error;
      logger.warn({ requestId: row.id, kind: error.kind }, "IAM did not answer about an identity request");
      // A key or connection problem affects every request: try again next time.
      if (error.kind !== "not_found") break;
      continue;
    }
    if (changes(row, answer).length > 0) changed += 1;
    await apply(row.id, answer, null);
  }
  return changed;
}
