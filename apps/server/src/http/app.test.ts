import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";

const { handler } = vi.hoisted(() => ({
  handler: vi.fn(async (request: Request) => new Response(await request.text())),
}));
vi.mock("../auth/auth", () => ({ auth: () => ({ handler }) }));

describe("authentication requests", () => {
  const app = createApp();
  const path = "/api/auth/sign-in/social";

  beforeEach(() => {
    handler.mockClear();
  });

  it("passes ordinary requests to authentication and prevents caching the response", async () => {
    const body = JSON.stringify({ provider: "oidc" });
    const response = await app.request(path, { method: "POST", body });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps provider token and account management routes private", async () => {
    for (const [method, endpoint] of [
      ["POST", "get-access-token"],
      ["GET", "account-info"],
      ["GET", "get-session"],
      ["POST", "link-social"],
    ] as const) {
      const response = await app.request(`/api/auth/${endpoint}`, { method });
      expect(response.status).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["declared length", "stream"])(
    "rejects oversized bodies with %s before authentication",
    async (mode) => {
      const body = "x".repeat(512 * 1024 + 1);
      const response = await app.request(path, {
        method: "POST",
        body,
        headers: mode === "declared length" ? { "content-length": String(body.length) } : {},
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
