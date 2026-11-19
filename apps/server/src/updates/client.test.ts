import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeUpdater, updaterStatus } from "../test/fake-updater";
import { createUpdaterClient, UPDATER_TIMEOUTS } from "./client";

let updater: Awaited<ReturnType<typeof startFakeUpdater>>;

beforeEach(async () => {
  updater = await startFakeUpdater();
});

afterEach(async () => {
  await updater.close();
});

describe("createUpdaterClient", () => {
  it("reads the status and sends installs and channels as JSON", async () => {
    const client = createUpdaterClient(updater.url);

    expect(await client.status()).toEqual({ kind: "ok", status: updaterStatus() });
    await client.check();
    await client.install("0.2.1");
    await client.channel("preview");

    expect(updater.received).toEqual([
      { method: "GET", path: "/v1/status", body: undefined },
      { method: "POST", path: "/v1/check", body: undefined },
      { method: "POST", path: "/v1/install", body: { version: "0.2.1" } },
      { method: "POST", path: "/v1/channel", body: { channel: "preview" } },
    ]);
  });

  it("passes on the updater's error", async () => {
    updater.reply(() => ({ status: 409, body: { error: "0.9.9 is not offered; check again." } }));

    expect(await createUpdaterClient(updater.url).install("0.9.9")).toEqual({
      kind: "refused",
      httpStatus: 409,
      error: "0.9.9 is not offered; check again.",
    });
  });

  it("names the status of an error answer without a message", async () => {
    updater.reply(() => ({ status: 500, text: "<html>Internal Server Error</html>" }));

    expect(await createUpdaterClient(updater.url).check()).toEqual({
      kind: "refused",
      httpStatus: 500,
      error: "The update service answered with status 500.",
    });
  });

  it("is unreachable without a connection", async () => {
    const url = updater.url;
    await updater.close();
    updater = await startFakeUpdater();

    expect(await createUpdaterClient(url).status()).toEqual({
      kind: "unreachable",
      error: `No connection to the update service at ${url}.`,
    });
  });

  it("gives up after the timeout", async () => {
    updater.reply((_method, path) => ({ delayMs: path === "/v1/check" ? 2_500 : 0, body: updaterStatus() }));
    const client = createUpdaterClient(updater.url, { timeouts: { ...UPDATER_TIMEOUTS, check: 2_000 } });

    expect(await client.check()).toEqual({
      kind: "unreachable",
      error: `The update service at ${updater.url} did not answer within 2 seconds.`,
    });
    expect((await client.install("0.2.1")).kind).toBe("ok");
  });

  it("is unreachable when something else answers", async () => {
    updater.reply(() => ({ text: "<html>Welcome</html>" }));
    expect(await createUpdaterClient(updater.url).status()).toEqual({
      kind: "unreachable",
      error: `Something other than the update service answered at ${updater.url}.`,
    });

    updater.reply(() => ({ body: { ok: true } }));
    expect((await createUpdaterClient(updater.url).status()).kind).toBe("unreachable");
  });

  it("uses the timeouts of the specification", () => {
    expect(UPDATER_TIMEOUTS).toEqual({ status: 3_000, check: 35_000, install: 10_000, channel: 35_000 });
  });
});
