import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desc } from "drizzle-orm";
import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
import { resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema";
import { createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

// The handler of @meldgrove/ui answers for the updater (its own tests cover
// timeouts, refusals and the status); these tests cover what Helpdesk adds:
// the role, the same-origin check, UPDATER_TOKEN and the audit log.

const TOKEN = "updater-test-token";

type User = Awaited<ReturnType<typeof createUser>>;
let updater: FakeUpdater;
let superadmin: User;

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests();
}

const lastAudit = async () =>
  (await getDb().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(1))[0];

beforeEach(async () => {
  await resetDatabase();
  superadmin = await createUser("superadmin", { email: "ada@example.org" });
  updater = await startFakeUpdater({ token: TOKEN });
  setEnv({ UPDATER_URL: updater.url, UPDATER_TOKEN: TOKEN, APP_VERSION: "0.2.0" });
});

afterEach(async () => {
  await updater.close();
  setEnv({ UPDATER_URL: undefined, UPDATER_TOKEN: undefined, APP_VERSION: undefined });
});

describe("updates", () => {
  it("are for superadmins only, without a call to the updater", async () => {
    for (const role of ["requester", "operator", "admin"] as const) {
      const user = await createUser(role);
      expect((await request("GET", "/api/v1/updates", { userId: user.id })).status).toBe(403);
      const check = await request("POST", "/api/v1/updates/check", { userId: user.id, body: {} });
      expect(check.status).toBe(403);
      const install = await request("POST", "/api/v1/updates/install", {
        userId: user.id,
        body: { version: "0.2.1" },
      });
      expect(install.status).toBe(403);
      const channel = await request("POST", "/api/v1/updates/channel", {
        userId: user.id,
        body: { channel: "preview" },
      });
      expect(channel.status).toBe(403);
    }
    expect((await request("GET", "/api/v1/updates")).status).toBe(401);
    expect(updater.calls).toEqual([]);
  });

  it("show the updater's status and the app's version, asked with UPDATER_TOKEN", async () => {
    const response = await request("GET", "/api/v1/updates", { userId: superadmin.id });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: updaterStatus({ apiToken: true }),
      error: null,
    });
    expect(updater.calls).toEqual([
      { method: "GET", path: "/v1/status", body: null, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("send no token while UPDATER_TOKEN is empty", async () => {
    await updater.close();
    updater = await startFakeUpdater();
    setEnv({ UPDATER_URL: updater.url, UPDATER_TOKEN: "" });

    const response = await request("POST", "/api/v1/updates/check", { userId: superadmin.id, body: {} });

    expect(response.status).toBe(200);
    expect(response.body.updater).toEqual(updaterStatus({ apiToken: false }));
    expect(updater.calls).toEqual([{ method: "POST", path: "/v1/check", body: null, authorization: null }]);
  });

  it("name UPDATER_TOKEN when the updater refuses the token", async () => {
    setEnv({ UPDATER_TOKEN: "another-token" });

    const response = await request("GET", "/api/v1/updates", { userId: superadmin.id });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/UPDATER_TOKEN/);
    expect(updater.calls.map((call) => call.authorization)).toEqual(["Bearer another-token"]);
  });

  it("install a version and record it in the audit log", async () => {
    const installing = updaterStatus({
      installing: {
        version: "0.2.1",
        startedAt: "2026-11-19T09:00:00.000Z",
        manual: true,
        stage: "requested",
      },
    });
    updater.respond(() => ({ status: 202, body: installing }));

    const response = await request("POST", "/api/v1/updates/install", {
      userId: superadmin.id,
      body: { version: "0.2.1" },
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: installing,
      error: null,
    });
    expect(updater.calls).toEqual([
      { method: "POST", path: "/v1/install", body: { version: "0.2.1" }, authorization: `Bearer ${TOKEN}` },
    ]);
    expect(await lastAudit()).toMatchObject({
      action: "update.install",
      entityId: "0.2.1",
      actorEmail: "ada@example.org",
      summary: "Started the update to 0.2.1",
    });
  });

  it("record nothing when the updater refuses", async () => {
    updater.respond((call) =>
      call.path === "/v1/install"
        ? { status: 409, body: { error: "0.2.1 is being installed." } }
        : { body: updaterStatus() },
    );

    const response = await request("POST", "/api/v1/updates/install", {
      userId: superadmin.id,
      body: { version: "0.2.1" },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ reachable: true, error: "0.2.1 is being installed." });
    expect(await getDb().select().from(auditLog)).toEqual([]);
  });

  it("refuse a wrong version before calling the updater", async () => {
    for (const version of ["latest", "0.2.1; rm -rf /", 7]) {
      const response = await request("POST", "/api/v1/updates/install", {
        userId: superadmin.id,
        body: { version },
      });
      expect(response.status).toBe(400);
    }
    expect(updater.calls).toEqual([]);
    expect(await getDb().select().from(auditLog)).toEqual([]);
  });

  it("switch the channel and record it", async () => {
    const preview = updaterStatus({ channel: "preview", cooldown: null });
    updater.respond(() => ({ body: preview }));

    const response = await request("POST", "/api/v1/updates/channel", {
      userId: superadmin.id,
      body: { channel: "preview" },
    });

    expect(response.status).toBe(200);
    expect(response.body.updater).toEqual(preview);
    expect(updater.calls).toEqual([
      { method: "POST", path: "/v1/channel", body: { channel: "preview" }, authorization: `Bearer ${TOKEN}` },
    ]);
    expect(await lastAudit()).toMatchObject({
      action: "update.channel",
      entityId: "preview",
      summary: "Switched updates to Preview",
    });
  });

  it("are off without a call when UPDATER_URL is empty", async () => {
    setEnv({ UPDATER_URL: "" });

    const response = await request("POST", "/api/v1/updates/check", { userId: superadmin.id, body: {} });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reachable: false, updater: null });
    expect(updater.calls).toEqual([]);
  });

  it("reject cross-site requests", async () => {
    const { createApp } = await import("../http/app");
    const response = await createApp().request("/api/v1/updates/install", {
      method: "POST",
      headers: {
        origin: "https://evil.example.org",
        "content-type": "application/json",
        "x-test-user": superadmin.id,
      },
      body: JSON.stringify({ version: "0.2.1" }),
    });
    expect(response.status).toBe(403);
    expect(updater.calls).toEqual([]);
  });
});
