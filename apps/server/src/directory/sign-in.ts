import { and, desc, eq, ne, sql } from "drizzle-orm";
import { roleSchema, type Role } from "@helpdesk/shared/roles";
import { config } from "../config";
import { getDb } from "../db/client";
import { accounts, users } from "../db/schema";
import { logger } from "../logger";
import { isEnvironmentSuperadmin } from "../auth/bootstrap";
import { claimGroups, roleFromGroups } from "./groups";
import { createKeycloakClient, DirectoryError, type KeycloakClient } from "./keycloak";

let keycloak: KeycloakClient | undefined;
const keycloakClient = () => (keycloak ??= createKeycloakClient());

/** Tests only: replace the Keycloak client. */
export function setKeycloakClientForTests(client: KeycloakClient | undefined) {
  keycloak = client;
}

/** The claims of a JWT, without checking its signature (the sign-in already verified the ID token). */
export function jwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A claim by name; a dotted name reads a nested claim, e.g. `realm_access.roles`. */
export function readClaim(claims: Record<string, unknown> | null, name: string): unknown {
  if (!claims) return undefined;
  if (name in claims) return claims[name];
  let value: unknown = claims;
  for (const part of name.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

let userInfoEndpoint: string | null | undefined;

async function userInfoClaims(accessToken: string, subject: string): Promise<Record<string, unknown> | null> {
  if (userInfoEndpoint === undefined) {
    const issuer = config().OIDC_ISSUER.replace(/\/+$/, "");
    const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!discovery.ok) throw new DirectoryError("Could not read the provider's discovery document");
    const body = (await discovery.json().catch(() => null)) as {
      issuer?: unknown;
      userinfo_endpoint?: unknown;
    } | null;
    if (body?.issuer !== issuer && body?.issuer !== config().OIDC_ISSUER) {
      throw new DirectoryError("The discovery document has a different issuer");
    }
    userInfoEndpoint = typeof body?.userinfo_endpoint === "string" ? body.userinfo_endpoint : null;
  }
  if (!userInfoEndpoint) return null;
  const response = await fetch(userInfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new DirectoryError(`The provider's userinfo endpoint answered HTTP ${response.status}`);
  const claims = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // OIDC requires UserInfo to refer to the subject of the verified ID token.
  if (claims?.sub !== subject) throw new DirectoryError("UserInfo does not match the signed-in identity");
  return claims;
}

/** The groups of the sign-in: the claim in the ID token, else in the userinfo response. */
async function signInGroups(account: {
  idToken: string | null;
  accessToken: string | null;
}): Promise<string[]> {
  const claim = config().OIDC_GROUPS_CLAIM;
  const idClaims = jwtClaims(account.idToken);
  const fromIdToken = readClaim(idClaims, claim);
  if (fromIdToken !== undefined) return claimGroups(fromIdToken);
  if (!account.accessToken || typeof idClaims?.sub !== "string" || !idClaims.sub) return [];
  return claimGroups(readClaim(await userInfoClaims(account.accessToken, idClaims.sub), claim));
}

/**
 * Decides a person's role at sign-in from their groups, stores it, and
 * returns it (null: no access, no session). With DIRECTORY=keycloak the
 * groups come from the Admin API, else from the sign-in's groups claim. When
 * the Keycloak API cannot be read, the last known role stays.
 */
export async function refreshAccessAtSignIn(userId: string): Promise<Role | null> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  if (isEnvironmentSuperadmin(user.email)) {
    await db
      .update(users)
      .set({ role: "superadmin", roleSource: "environment", roleCheckedAt: sql`now()` })
      .where(eq(users.id, userId));
    return "superadmin";
  }
  const [account] = await db
    .select({ accountId: accounts.accountId, idToken: accounts.idToken, accessToken: accounts.accessToken })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "oidc")))
    .orderBy(desc(accounts.updatedAt))
    .limit(1);
  if (!account) return null;

  let role: Role | null;
  const keycloakMode = config().DIRECTORY === "keycloak";
  try {
    const groups = keycloakMode
      ? await keycloakClient().userGroups(account.accountId)
      : await signInGroups(account);
    role = roleFromGroups(groups);
  } catch (error) {
    logger.warn({ err: error, userId }, "could not read the groups at sign-in");
    return keycloakMode ? (roleSchema.safeParse(user.role).data ?? null) : null;
  }

  await db.transaction(async (tx) => {
    // The provider's ID moved to this person (e.g. their email changed).
    await tx
      .update(users)
      .set({ directoryId: null, role: null, roleSource: null, updatedAt: sql`now()` })
      .where(and(eq(users.directoryId, account.accountId), ne(users.id, userId)));
    await tx
      .update(users)
      .set({
        role,
        roleSource: role ? (keycloakMode ? "directory" : "sign_in") : null,
        roleCheckedAt: sql`now()`,
        directoryId: account.accountId,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, userId));
  });
  logger.info({ userId, role: role ?? "none" }, "access checked at sign-in");
  return role;
}
