import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc } from "drizzle-orm";
import { resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema";
import { createUser, request, resetDatabase } from "../test/helpers";
import { startFakeUpdater, updaterStatus } from "../test/fake-updater";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

type User = Awaited<ReturnType<typeof createUser>>;
let updater: Awaited<ReturnType<typeof startFakeUpdater>>;
let superadmin: User;

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests();
}

beforeAll(async () => {
  updater = await startFakeUpdater();
});

afterAll(async () => {
  await updater.close();
  setEnv({ UPDATER_URL: undefined, APP_VERSION: undefined });
});

beforeEach(async () => {
  await resetDatabase();
  superadmin = await createUser("superadmin", { email: "ada@example.org" });
  updater.received.length = 0;
  updater.reply(() => ({ body: updaterStatus() }));
  setEnv({ UPDATER_URL: updater.url, APP_VERSION: "0.2.0" });
});

afterEach(() => {
  setEnv({ UPDATER_URL: undefined, APP_VERSION: undefined });
});

describe("updates", () => {
  it("are for superadmins only", async () => {
    for (const role of ["requester", "operator", "admin"] as const) {
      const user = await createUser(role);
      expect((await request("GET", "/api/v1/updates", { userId: user.id })).status).toBe(403);
      expect((await request("POST", "/api/v1/updates/check", { userId: user.id, body: {} })).status).toBe(
        403,
      );
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
    expect(updater.received).toEqual([]);
  });

  it("show the updater's status and the app's version", async () => {
    const response = await request("GET", "/api/v1/updates", { userId: superadmin.id });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: updaterStatus(),
      error: null,
    });
    expect(updater.received).toEqual([{ method: "GET", path: "/v1/status", body: undefined }]);
  });

  it("have no app version in development", async () => {
    setEnv({ APP_VERSION: undefined });
    const response = await request("GET", "/api/v1/updates", { userId: superadmin.id });
    expect(response.body.app).toEqual({ version: null });
  });

  it("check on request", async () => {
    const response = await request("POST", "/api/v1/updates/check", { userId: superadmin.id, body: {} });

    expect(response.status).toBe(200);
    expect(response.body.updater).toEqual(updaterStatus());
    expect(updater.received.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /v1/check"]);
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
    updater.reply(() => ({ status: 202, body: installing }));

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
    expect(updater.received).toEqual([{ method: "POST", path: "/v1/install", body: { version: "0.2.1" } }]);
    const [entry] = await getDb().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(entry).toMatchObject({
      action: "update.install",
      entityId: "0.2.1",
      actorEmail: "ada@example.org",
      summary: "Started the update to 0.2.1",
    });
  });

  it("accept previews and images without a version", async () => {
    for (const version of ["0.2.1-preview.3", "sha256:0123456789ab"]) {
      const response = await request("POST", "/api/v1/updates/install", {
        userId: superadmin.id,
        body: { version },
      });
      expect(response.status).toBe(202);
    }
  });

  it("validate the version and the channel before calling the updater", async () => {
    for (const version of ["latest", "0.2", "v0.2.1", "0.2.1-rc.1", "0.2.1; rm -rf /", "sha256:0123", 7]) {
      const response = await request("POST", "/api/v1/updates/install", {
        userId: superadmin.id,
        body: { version },
      });
      expect(response.status).toBe(422);
      expect(response.body.error.fields).toHaveProperty("version");
    }
    for (const channel of ["beta", "", null]) {
      const response = await request("POST", "/api/v1/updates/channel", {
        userId: superadmin.id,
        body: { channel },
      });
      expect(response.status).toBe(422);
    }
    expect(updater.received).toEqual([]);
  });

  it("switch the channel", async () => {
    const preview = updaterStatus({ channel: "preview", cooldown: null });
    updater.reply(() => ({ body: preview }));

    const response = await request("POST", "/api/v1/updates/channel", {
      userId: superadmin.id,
      body: { channel: "preview" },
    });

    expect(response.status).toBe(200);
    expect(response.body.updater).toEqual(preview);
    expect(updater.received).toEqual([{ method: "POST", path: "/v1/channel", body: { channel: "preview" } }]);
    const [entry] = await getDb().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(entry).toMatchObject({ action: "update.channel", summary: "Switched updates to Preview" });
  });

  it("answer 409 with the updater's error and the latest status", async () => {
    updater.reply((method, path) =>
      path === "/v1/install"
        ? { status: 409, body: { error: "0.2.1 is being installed." } }
        : { body: updaterStatus() },
    );

    const response = await request("POST", "/api/v1/updates/install", {
      userId: superadmin.id,
      body: { version: "0.2.1" },
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: updaterStatus(),
      error: "0.2.1 is being installed.",
    });
    expect(updater.received.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/install",
      "GET /v1/status",
    ]);
    expect(await getDb().select().from(auditLog)).toEqual([]);
  });

  it("pass on a locked channel as 409", async () => {
    const locked = "The platform's image tag latest decides which updates install. Change it there.";
    updater.reply((method, path) =>
      path === "/v1/channel" ? { status: 409, body: { error: locked } } : { body: updaterStatus() },
    );

    const response = await request("POST", "/api/v1/updates/channel", {
      userId: superadmin.id,
      body: { channel: "preview" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(locked);
  });

  it("are unreachable without an updater", async () => {
    const closed = await startFakeUpdater();
    await closed.close();
    setEnv({ UPDATER_URL: closed.url });

    const response = await request("GET", "/api/v1/updates", { userId: superadmin.id });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      app: { version: "0.2.0" },
      reachable: false,
      updater: null,
      error: `No connection to the update service at ${closed.url}.`,
    });
  });

  it("are unreachable when the updater does not answer in time", async () => {
    updater.reply(() => ({ delayMs: 4_000, body: updaterStatus() }));

    const response = await request("GET", "/api/v1/updates", { userId: superadmin.id });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reachable: false,
      error: `The update service at ${updater.url} did not answer within 3 seconds.`,
    });
  });

  it("are off without a call when UPDATER_URL is empty", async () => {
    setEnv({ UPDATER_URL: "" });

    const response = await request("POST", "/api/v1/updates/check", { userId: superadmin.id, body: {} });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ reachable: false, updater: null });
    expect(updater.received).toEqual([]);
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
    expect(updater.received).toEqual([]);
  });
});
