import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { accounts, settings, users } from "../db/schema";
import { resetConfigForTests } from "../config";
import { createUser, resetDatabase } from "../test/helpers";
import { refreshAccessAtSignIn, setKeycloakClientForTests } from "./sign-in";
import { syncDirectory } from "./sync";
import type { KeycloakClient, KeycloakUser } from "./keycloak";

function idToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ sub: "subject-1", ...claims })}.signature`;
}

async function signedIn(email: string, claims: Record<string, unknown>, subject = "subject-1") {
  const user = await createUser(null, { email });
  await getDb()
    .insert(accounts)
    .values({ accountId: subject, providerId: "oidc", userId: user.id, idToken: idToken(claims) });
  return { ...user, tokens: { idToken: idToken({ ...claims, sub: subject }) } };
}

const roleOf = async (id: string) => (await getDb().select().from(users).where(eq(users.id, id)))[0]!;

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DIRECTORY;
  delete process.env.OIDC_GROUPS_CLAIM;
  resetConfigForTests();
  setKeycloakClientForTests(undefined);
});

describe("roles at sign-in from the groups claim (DIRECTORY=oidc)", () => {
  it("gives the highest role of the claimed groups, or none", async () => {
    const operator = await signedIn("op@example.org", {
      groups: ["/helpdesk/employees", "/helpdesk/operators/it"],
    });
    expect(await refreshAccessAtSignIn(operator.id, operator.tokens)).toBe("operator");
    expect(await roleOf(operator.id)).toMatchObject({
      role: "operator",
      roleSource: "sign_in",
      directoryId: "subject-1",
    });

    const outsider = await signedIn("out@example.org", { groups: ["/marketing"] }, "subject-2");
    expect(await refreshAccessAtSignIn(outsider.id, outsider.tokens)).toBeNull();
    expect((await roleOf(outsider.id)).role).toBeNull();
  });

  it("reads a nested claim", async () => {
    process.env.OIDC_GROUPS_CLAIM = "realm_access.roles";
    resetConfigForTests();
    const admin = await signedIn("admin@example.org", { realm_access: { roles: ["helpdesk/admins"] } });
    expect(await refreshAccessAtSignIn(admin.id, admin.tokens)).toBe("admin");
  });

  it("uses UserInfo groups only for the signed-in subject", async () => {
    const user = await signedIn("op@example.org", {});
    const tokens = { ...user.tokens, accessToken: "test-token" };
    const issuer = process.env.OIDC_ISSUER!;
    let subject = "subject-1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/.well-known/openid-configuration")) {
          return Response.json({ issuer, userinfo_endpoint: `${issuer}/userinfo` });
        }
        return Response.json({ sub: subject, groups: ["helpdesk/operators"] });
      }),
    );

    expect(await refreshAccessAtSignIn(user.id, tokens)).toBe("operator");
    subject = "different-subject";
    expect(await refreshAccessAtSignIn(user.id, tokens)).toBeNull();
  });

  it("requires a current ID token and keeps an existing subject binding", async () => {
    const user = await signedIn("op@example.org", { groups: ["helpdesk/operators"] });
    expect(await refreshAccessAtSignIn(user.id, {})).toBeNull();
    expect(await refreshAccessAtSignIn(user.id, user.tokens)).toBe("operator");
    const other = { idToken: idToken({ sub: "other", groups: ["helpdesk/superadmins"] }) };
    expect(await refreshAccessAtSignIn(user.id, other)).toBeNull();
    expect((await roleOf(user.id)).role).toBe("operator");
  });

  it("always lets SUPERADMIN_EMAILS in", async () => {
    const root = await signedIn("root@example.org", { groups: [] });
    expect(await refreshAccessAtSignIn(root.id, root.tokens)).toBe("superadmin");
  });
});

function fakeKeycloak(
  groups: Record<string, KeycloakUser[]>,
  userGroups: Record<string, string[]> = {},
): KeycloakClient {
  return {
    async membersOf(path) {
      return new Map((groups[path] ?? []).map((user) => [user.id, user]));
    },
    async userGroups(id) {
      return userGroups[id] ?? [];
    },
    async check() {},
  };
}

describe("Keycloak (DIRECTORY=keycloak)", () => {
  beforeEach(() => {
    process.env.DIRECTORY = "keycloak";
    resetConfigForTests();
  });

  it("reads the person's groups at sign-in", async () => {
    setKeycloakClientForTests(fakeKeycloak({}, { "kc-1": ["/helpdesk/superadmins"] }));
    const user = await signedIn("ada@example.org", {}, "kc-1");
    expect(await refreshAccessAtSignIn(user.id, user.tokens)).toBe("superadmin");
    expect((await roleOf(user.id)).roleSource).toBe("directory");
  });

  it("keeps the last known role when Keycloak cannot be read", async () => {
    setKeycloakClientForTests({
      ...fakeKeycloak({}),
      userGroups: async () => Promise.reject(new Error("down")),
    });
    const user = await signedIn("op@example.org", {}, "kc-2");
    await getDb().update(users).set({ role: "operator", directoryId: "kc-2" }).where(eq(users.id, user.id));
    expect(await refreshAccessAtSignIn(user.id, user.tokens)).toBe("operator");
  });

  it("syncs everyone in the groups and removes roles of people who left", async () => {
    const leaver = await createUser("operator", { email: "leaver@example.org" });
    await getDb().update(users).set({ directoryId: "kc-old" }).where(eq(users.id, leaver.id));
    const known = await createUser(null, { email: "erin@example.org" });
    const result = await syncDirectory(
      fakeKeycloak({
        "/helpdesk/employees": [
          { id: "kc-erin", email: "Erin@example.org", firstName: "Erin", lastName: "Employee" },
          { id: "kc-off", email: "off@example.org", enabled: false },
          { id: "kc-nomail", username: "nomail" },
        ],
        "/helpdesk/operators": [{ id: "kc-oscar", email: "oscar@example.org", firstName: "Oscar" }],
        "/helpdesk/admins": [{ id: "kc-erin", email: "erin@example.org" }],
      }),
    );
    expect(result).toEqual({ people: 2 });
    expect(await roleOf(known.id)).toMatchObject({
      role: "admin",
      name: "Erin Employee",
      directoryId: "kc-erin",
    });
    const [oscar] = await getDb().select().from(users).where(eq(users.email, "oscar@example.org"));
    expect(oscar).toMatchObject({ role: "operator", roleSource: "directory", name: "Oscar" });
    expect((await roleOf(leaver.id)).role).toBeNull();
    const [status] = await getDb().select().from(settings).where(eq(settings.key, "directory"));
    expect(status!.value).toMatchObject({ ok: true, people: 2 });
  });
});
