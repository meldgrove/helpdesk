import { afterEach, describe, expect, it } from "vitest";
import type { Update, UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { ApiError } from "@/lib/api";
import {
  buttonState,
  formatCooldown,
  hasPopover,
  installOutcome,
  isOutage,
  parseWindow,
  readPendingInstall,
  SLOW_INSTALL_MS,
  visibleNotes,
  writePendingInstall,
  type PendingInstall,
} from "./state";

const NOW = Date.parse("2026-11-19T09:00:00.000Z");

function update(overrides: Partial<Update> = {}): Update {
  return {
    version: "0.2.1",
    preview: false,
    publishedAt: "2026-11-17T09:00:00.000Z",
    url: "https://github.com/meldgrove/helpdesk/releases/tag/v0.2.1",
    notes: ["Fix the board filters"],
    changes: 1,
    installsAt: "2026-11-20T02:00:00.000Z",
    failed: null,
    ...overrides,
  };
}

function status(overrides: Partial<UpdaterStatus> = {}): UpdaterStatus {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: null,
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: "2026-11-19T08:50:00.000Z",
    error: null,
    automatic: true,
    cooldown: "3d",
    window: null,
    timezone: "UTC",
    ...overrides,
  };
}

function response(updater: UpdaterStatus | null, appVersion: string | null = "0.2.0"): UpdatesResponse {
  return { app: { version: appVersion }, reachable: updater !== null, updater, error: null };
}

function state(data: UpdatesResponse | undefined, extra: Partial<Parameters<typeof buttonState>[0]> = {}) {
  return buttonState({
    data,
    loadFailed: false,
    checking: false,
    pending: null,
    restarting: false,
    now: NOW,
    ...extra,
  });
}

const pending: PendingInstall = {
  version: "0.2.1",
  startedAt: NOW,
  fromVersion: "0.2.0",
  lastBefore: null,
  outage: false,
};

describe("buttonState", () => {
  it("is up to date without an update or a failure", () => {
    expect(state(response(status()))).toEqual({ kind: "up-to-date", installed: "0.2.0" });
    expect(state(response(status({ installed: null }), "0.2.0"))).toEqual({
      kind: "up-to-date",
      installed: "0.2.0",
    });
  });

  it("shows an available update", () => {
    const available = update();
    expect(state(response(status({ available })))).toEqual({ kind: "available", update: available });
  });

  it("shows an update that needs upgrade steps only without an available one", () => {
    const attention = update({ version: "0.3.0" });
    expect(state(response(status({ attention })))).toEqual({ kind: "attention", update: attention });
    expect(state(response(status({ attention, available: update() })))?.kind).toBe("available");
  });

  it("checks while a check runs, here or in the updater", () => {
    expect(state(response(status({ available: update() })), { checking: true })).toEqual({
      kind: "checking",
    });
    expect(state(response(status({ checking: true })))).toEqual({ kind: "checking" });
  });

  it("installs while the updater installs", () => {
    const installing = {
      version: "0.2.1",
      startedAt: "2026-11-19T08:59:00.000Z",
      manual: false,
      stage: "pulling",
    } as const;
    expect(state(response(status({ available: update(), installing })))).toEqual({
      kind: "installing",
      version: "0.2.1",
      stage: "pulling",
      restarting: false,
      slow: false,
    });
  });

  it("installs while the page waits for the new version, also while the app restarts", () => {
    expect(state(undefined, { pending, restarting: true, loadFailed: true })).toEqual({
      kind: "installing",
      version: "0.2.1",
      stage: null,
      restarting: true,
      slow: false,
    });
    expect(state(response(null), { pending })?.kind).toBe("installing");
  });

  it("takes longer than expected after 15 minutes", () => {
    const result = state(response(status()), { pending, now: NOW + SLOW_INSTALL_MS + 1 });
    expect(result).toMatchObject({ kind: "installing", slow: true });
    expect(state(response(status()), { pending, now: NOW + SLOW_INSTALL_MS })).toMatchObject({ slow: false });
  });

  it("failed when the last installation failed or rolled back and the update says so", () => {
    const available = update({ failed: "container web is unhealthy" });
    for (const result of ["failed", "rolled-back"] as const) {
      const last = {
        version: "0.2.1",
        result,
        message: "container web is unhealthy. 0.2.0 runs again.",
        finishedAt: "2026-11-19T08:00:00.000Z",
      };
      expect(state(response(status({ available, last })))).toEqual({
        kind: "failed",
        update: available,
        message: "container web is unhealthy. 0.2.0 runs again.",
      });
    }
  });

  it("uses the update's message when the last installation was another version", () => {
    const available = update({ version: "0.2.2", failed: "image not found" });
    const last = {
      version: "0.2.1",
      result: "failed",
      message: "other",
      finishedAt: NOW.toString(),
    } as const;
    expect(state(response(status({ available, last })))).toMatchObject({
      kind: "failed",
      message: "image not found",
    });
  });

  it("is not failed after a successful installation", () => {
    const available = update({ version: "0.2.2", failed: "image not found" });
    const last = {
      version: "0.2.1",
      result: "installed",
      message: null,
      finishedAt: NOW.toString(),
    } as const;
    expect(state(response(status({ available, last })))?.kind).toBe("available");
  });

  it("still shows what is new when the server installs nothing", () => {
    const off = { mode: "off", automatic: false } as const;
    expect(state(response(status({ ...off, available: update() })))?.kind).toBe("available");
    expect(state(response(status({ ...off, attention: update({ version: "0.3.0" }) })))?.kind).toBe(
      "attention",
    );
    expect(state(response(status(off)))).toEqual({ kind: "off" });
  });

  it("is unreachable without an updater", () => {
    expect(state({ app: { version: null }, reachable: false, updater: null, error: "No answer" })).toEqual({
      kind: "unreachable",
    });
    expect(state(undefined, { loadFailed: true })).toEqual({ kind: "unreachable" });
  });

  it("shows nothing before the first answer", () => {
    expect(state(undefined)).toBeNull();
  });

  it("opens a popover only when there is something to show", () => {
    expect(hasPopover({ kind: "available", update: update() })).toBe(true);
    expect(hasPopover({ kind: "attention", update: update() })).toBe(true);
    expect(hasPopover({ kind: "failed", update: update(), message: null })).toBe(true);
    expect(
      hasPopover({ kind: "installing", version: "0.2.1", stage: null, restarting: false, slow: false }),
    ).toBe(true);
    for (const kind of ["checking", "off", "unreachable"] as const) expect(hasPopover({ kind })).toBe(false);
    expect(hasPopover({ kind: "up-to-date", installed: null })).toBe(false);
  });
});

describe("installOutcome", () => {
  const last = (
    result: "installed" | "failed" | "rolled-back" | "accepted",
    finishedAt = "2026-11-19T09:01:00Z",
  ) => ({
    version: "0.2.1",
    result,
    message: null,
    finishedAt,
  });

  it("is done when the app runs the version", () => {
    expect(installOutcome(pending, response(null, "0.2.1"))).toBe("done");
  });

  it("waits while the updater installs", () => {
    const installing = {
      version: "0.2.1",
      startedAt: "2026-11-19T09:00:00Z",
      manual: true,
      stage: "starting",
    } as const;
    expect(installOutcome(pending, response(status({ installing })))).toBe("waiting");
    expect(installOutcome(pending, response(null))).toBe("waiting");
  });

  it("is done when the updater installed it and the app's version changed", () => {
    expect(installOutcome(pending, response(status({ last: last("installed") }), "0.2.0"))).toBe("waiting");
    expect(
      installOutcome(
        { ...pending, fromVersion: null },
        response(status({ last: last("installed") }), "0.2.0"),
      ),
    ).toBe("done");
  });

  it("is done when the updater installed or the platform accepted it and the app answered after an outage", () => {
    const afterOutage = { ...pending, outage: true };
    expect(installOutcome(afterOutage, response(status({ last: last("installed") }), "0.2.0"))).toBe("done");
    expect(installOutcome(afterOutage, response(status({ last: last("accepted") }), "0.2.0"))).toBe("done");
    expect(installOutcome(pending, response(status({ last: last("accepted") }), "0.2.0"))).toBe("waiting");
  });

  it("failed when the updater reports it failed or rolled back", () => {
    expect(installOutcome(pending, response(status({ last: last("failed") })))).toBe("failed");
    expect(installOutcome(pending, response(status({ last: last("rolled-back") })))).toBe("failed");
  });

  it("ignores the result from before the installation", () => {
    const earlier = last("failed", "2026-11-18T09:00:00Z");
    const retry = { ...pending, lastBefore: earlier.finishedAt };
    expect(installOutcome(retry, response(status({ last: earlier })))).toBe("waiting");
    expect(installOutcome(pending, response(status({ last: { ...last("failed"), version: "0.2.2" } })))).toBe(
      "waiting",
    );
  });
});

describe("isOutage", () => {
  it("takes network errors and gateway errors as the restart", () => {
    expect(isOutage(new TypeError("Failed to fetch"))).toBe(true);
    expect(isOutage(new ApiError(502, "internal_error", "Bad gateway"))).toBe(true);
    expect(isOutage(new ApiError(503, "internal_error", "Unavailable"))).toBe(true);
    expect(isOutage(new ApiError(403, "forbidden", "No"))).toBe(false);
  });
});

describe("pending installation storage", () => {
  afterEach(() => window.sessionStorage.clear());

  it("survives a reload", () => {
    writePendingInstall(pending);
    expect(readPendingInstall()).toEqual(pending);
    writePendingInstall(null);
    expect(readPendingInstall()).toBeNull();
  });

  it("ignores broken values", () => {
    window.sessionStorage.setItem("helpdesk.updates.installing", "{nope");
    expect(readPendingInstall()).toBeNull();
    window.sessionStorage.setItem("helpdesk.updates.installing", JSON.stringify({ version: 3 }));
    expect(readPendingInstall()).toBeNull();
  });
});

describe("formatting", () => {
  it("writes cooldowns out", () => {
    expect(formatCooldown("3d")).toBe("3 days");
    expect(formatCooldown("1d")).toBe("1 day");
    expect(formatCooldown("12h")).toBe("12 hours");
    expect(formatCooldown("30m")).toBe("30 minutes");
    expect(formatCooldown("90")).toBe("90 seconds");
    expect(formatCooldown("1w")).toBe("1w");
  });

  it("reads the install window", () => {
    expect(parseWindow("02:00-05:00")).toEqual(["02:00", "05:00"]);
    expect(parseWindow(null)).toBeNull();
    expect(parseWindow("nightly")).toBeNull();
  });

  it("lists up to 8 notes and counts the rest", () => {
    const notes = Array.from({ length: 15 }, (_, index) => `Change ${index + 1}`);
    expect(visibleNotes(update({ notes, changes: 23 }))).toEqual({ notes: notes.slice(0, 8), more: 15 });
    expect(visibleNotes(update({ notes: ["One", "Two"], changes: 2 }))).toEqual({
      notes: ["One", "Two"],
      more: 0,
    });
  });
});
