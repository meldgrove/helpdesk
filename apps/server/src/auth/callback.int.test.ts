import { expect, it, vi } from "vitest";
import { createApp } from "../http/app";

it("returns to the sign-in page when an OIDC callback has no state", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  try {
    const response = await createApp().request("http://localhost:3000/api/auth/callback/oidc");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3000/sign-in?error=state_not_found");
  } finally {
    fetchMock.mockRestore();
  }
});
