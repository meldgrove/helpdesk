import { sql } from "drizzle-orm";
import type { Role } from "@helpdesk/shared/roles";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { createApp } from "../http/app";
import { ensureDefaults } from "../core/seed";

/** Empties every table between tests, then adds the default form and category. */
export async function resetDatabase() {
  await getDb().execute(sql`
    truncate table notifications, attachments, ticket_events, ticket_messages, tickets, categories, form_versions,
      audit_log, settings, sessions, accounts, verifications, auth_rate_limits, users
      restart identity cascade
  `);
  await ensureDefaults(getDb());
}

export async function createUser(
  role: Role | null,
  options: { email?: string; name?: string; notifyVia?: "email" | "slack" } = {},
) {
  const email = options.email ?? `${role ?? "nobody"}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  const [user] = await getDb()
    .insert(users)
    .values({
      email,
      name: options.name ?? role ?? "",
      role,
      roleSource: role ? "directory" : null,
      notifyVia: options.notifyVia ?? "email",
    })
    .returning();
  return user!;
}

let app: ReturnType<typeof createApp> | undefined;

/**
 * A request to the app as `userId` (the test resolver in api tests reads the
 * x-test-user header). JSON bodies are sent with the app's origin.
 */
export async function request(
  method: string,
  path: string,
  options: { userId?: string; body?: unknown; form?: FormData } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
): Promise<{ status: number; body: any; headers: Headers }> {
  app ??= createApp();
  const headers: Record<string, string> = { origin: "http://localhost:3000", accept: "application/json" };
  if (options.userId) headers["x-test-user"] = options.userId;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await app.request(path, {
    method,
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  return {
    status: response.status,
    body: text && type.includes("json") ? JSON.parse(text) : text,
    headers: response.headers,
  };
}
