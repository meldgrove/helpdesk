import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeUpdater } from "../test/fake-updater";
import { createUpdaterClient } from "./client";

/** Answers captured from Updater 0.2 (against GHCR and GitHub). */
const FIXTURES = new URL("../test/fixtures/updater-0.2/", import.meta.url);
const samples = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, text: readFileSync(new URL(name, FIXTURES), "utf8") }));

let updater: Awaited<ReturnType<typeof startFakeUpdater>>;

beforeEach(async () => {
  updater = await startFakeUpdater();
});

afterEach(async () => {
  await updater.close();
});

describe("the real answers of Updater 0.2", () => {
  it("has samples", () => {
    expect(samples.length).toBeGreaterThanOrEqual(7);
  });

  it.each(samples)("reads $name with every field", async ({ name, text }) => {
    const install = name.startsWith("install-");
    updater.reply(() => ({ status: install ? 202 : 200, text }));
    const client = createUpdaterClient(updater.url);

    const result = install ? await client.install("0.1.3") : await client.status();

    // toEqual: a field the schema does not know would be missing here.
    expect(result).toEqual({ kind: "ok", status: JSON.parse(text) });
  });
});
