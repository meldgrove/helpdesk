import { afterEach, describe, expect, it } from "vitest";
import { config, resetConfigForTests } from "./config";

function withUpdaterUrl(value: string | undefined) {
  if (value === undefined) delete process.env.UPDATER_URL;
  else process.env.UPDATER_URL = value;
  resetConfigForTests();
  return config;
}

afterEach(() => withUpdaterUrl(undefined));

describe("UPDATER_URL", () => {
  it("defaults to the updater service of compose.yaml", () => {
    expect(withUpdaterUrl(undefined)().UPDATER_URL).toBe("http://updater:8080");
  });

  it("is off when empty", () => {
    expect(withUpdaterUrl("")().UPDATER_URL).toBe("");
    expect(withUpdaterUrl("  ")().UPDATER_URL).toBe("");
  });

  it("drops a trailing slash", () => {
    expect(withUpdaterUrl("http://127.0.0.1:18087/")().UPDATER_URL).toBe("http://127.0.0.1:18087");
  });

  it("must be an http URL", () => {
    expect(withUpdaterUrl("updater:8080")).toThrow(/UPDATER_URL/);
    expect(withUpdaterUrl("file:///etc/passwd")).toThrow(/UPDATER_URL/);
  });
});

describe("UPDATER_TOKEN", () => {
  afterEach(() => {
    delete process.env.UPDATER_TOKEN;
    resetConfigForTests();
  });

  const withToken = (value: string | undefined) => {
    if (value === undefined) delete process.env.UPDATER_TOKEN;
    else process.env.UPDATER_TOKEN = value;
    resetConfigForTests();
    return config().UPDATER_TOKEN;
  };

  it("is none when unset or empty", () => {
    expect(withToken(undefined)).toBeUndefined();
    expect(withToken("")).toBeUndefined();
    expect(withToken("  ")).toBeUndefined();
  });

  it("drops surrounding spaces", () => {
    expect(withToken(" 0123abcd \n")).toBe("0123abcd");
  });
});
