import { expect, it, vi } from "vitest";
import { auth } from "./auth";

it("rejects an OIDC provider whose discovery response lacks signing keys", async () => {
  const issuer = process.env.OIDC_ISSUER;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    ),
  );
  try {
    expect((await auth().$context).socialProviders.map((provider) => provider.id)).not.toContain("oidc");
  } finally {
    vi.unstubAllGlobals();
  }
});
