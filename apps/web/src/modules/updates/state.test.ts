import { afterEach, describe, expect, it } from "vitest";
import type { Update, UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { ApiError } from "@/lib/api";
import {
  afterInstallAnswer,
  buttonState,
  formatCooldown,
  hasPopover,
  installAction,
  installDidNotStart,
  installOutcome,
  isOutage,
  isSignedOut,
  newAttempt,
  parseWindow,
  readPendingInstall,
  RECONCILE_MS,
  SLOW_INSTALL_MS,
  trackInstall,
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
  confirmed: true,
  serverStartedAt: null,
  reason: null,
  fromVersion: "0.2.0",
  outage: false,
};

const installing = (version = "0.2.1", startedAt = "2026-11-19T09:00:01Z") =>
  ({ version, startedAt, manual: true, stage: "starting" }) as const;

describe("buttonState", () => {
  it("is up to date without an update or a failure", () => {
    expect(state(response(status()))).toEqual({ kind: "up-to-date", installed: "0.2.0", error: null });
    expect(state(response(status({ installed: null }), "0.2.0"))).toEqual({
      kind: "up-to-date",
      installed: "0.2.0",
      error: null,
    });
  });

  it("keeps the error of a failed check instead of claiming up to date", () => {
    expect(state(response(status({ error: "registry not reachable" })))).toEqual({
      kind: "up-to-date",
      installed: "0.2.0",
      error: "registry not reachable",
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
        version: "0.2.1",
        update: available,
        message: "container web is unhealthy. 0.2.0 runs again.",
      });
    }
  });

  it("is failed when the last installation of the offered version failed, before the offer says so", () => {
    const attention = update({ version: "0.3.0" });
    const last = {
      version: "0.3.0",
      result: "rolled-back",
      message: "migrate failed. 0.2.0 runs again.",
      finishedAt: "2026-11-19T08:00:00.000Z",
    } as const;
    expect(state(response(status({ attention, last })))).toEqual({
      kind: "failed",
      version: "0.3.0",
      update: attention,
      message: "migrate failed. 0.2.0 runs again.",
    });
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

  describe("the failure of an installation this page followed", () => {
    const last = {
      version: "0.3.0",
      result: "rolled-back",
      message: "migrate failed. 0.2.0 runs again.",
      finishedAt: "2026-11-19T09:03:00Z",
    } as const;
    const failure = { version: "0.3.0", message: last.message, finishedAt: last.finishedAt };

    it("names the version and the updater's message, also when no offer says it failed", () => {
      // An update is available, too; the release with upgrade steps failed.
      const data = response(status({ available: update(), attention: update({ version: "0.3.0" }), last }));
      expect(state(data, { failure })).toEqual({
        kind: "failed",
        version: "0.3.0",
        message: "migrate failed. 0.2.0 runs again.",
        update: update({ version: "0.3.0" }),
      });
    });

    it("has no offer to try again once the version is no longer offered", () => {
      expect(state(response(status({ last })), { failure })).toMatchObject({ kind: "failed", update: null });
    });

    it("gives way to a newer result", () => {
      const newer = {
        ...last,
        version: "0.2.1",
        result: "installed",
        finishedAt: "2026-11-19T09:10:00Z",
      } as const;
      expect(state(response(status({ last: newer })), { failure })?.kind).toBe("up-to-date");
    });
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
    expect(hasPopover({ kind: "failed", version: "0.2.1", update: update(), message: null })).toBe(true);
    expect(
      hasPopover({ kind: "installing", version: "0.2.1", stage: null, restarting: false, slow: false }),
    ).toBe(true);
    for (const kind of ["checking", "off", "unreachable"] as const) expect(hasPopover({ kind })).toBe(false);
    expect(hasPopover({ kind: "up-to-date", installed: null, error: null })).toBe(false);
  });
});

describe("installAction", () => {
  const attention = update({ version: "0.3.0" });

  it("installs an available update, also where a platform's tag decides", () => {
    expect(installAction(status({ available: update() }), "0.2.1")).toBe("install");
    expect(
      installAction(status({ available: update(), mode: "platform", channelLocked: "tag" }), "0.2.1"),
    ).toBe("install");
  });

  it("installs a release with upgrade steps only while the channel is not locked", () => {
    expect(installAction(status({ attention }), "0.3.0")).toBe("install-anyway");
    expect(
      installAction(
        status({
          attention,
          mode: "platform",
          channelLocked: "The image tag 0.2 decides which updates install.",
        }),
        "0.3.0",
      ),
    ).toBe("locked");
  });

  it("installs nothing in mode off or what is no longer offered", () => {
    expect(installAction(status({ attention, mode: "off" }), "0.3.0")).toBe("off");
    expect(installAction(status(), "0.2.1")).toBeNull();
    expect(installAction(null, "0.2.1")).toBeNull();
  });
});

describe("installOutcome", () => {
  const last = (
    result: "installed" | "failed" | "rolled-back" | "accepted",
    finishedAt = "2026-11-19T09:01:00Z",
  ) => ({
    version: "0.2.1",
    result,
    message: result === "installed" || result === "accepted" ? null : "container web is unhealthy",
    finishedAt,
  });

  it("waits while the updater installs", () => {
    expect(installOutcome(pending, response(status({ installing: installing() })))).toBe("waiting");
    expect(installOutcome(pending, response(null))).toBe("waiting");
  });

  it("keeps installing while the updater installs, even when the app already answers with the new version", () => {
    const data = response(status({ installing: installing() }), "0.2.1");
    expect(installOutcome(pending, data)).toBe("waiting");
    expect(state(data, { pending })).toMatchObject({
      kind: "installing",
      version: "0.2.1",
      stage: "starting",
    });
  });

  it("is done when the updater reports it installed", () => {
    expect(installOutcome(pending, response(status({ last: last("installed") }), "0.2.0"))).toBe("done");
  });

  it("is done when the platform accepted it and the app runs it, or answered after an outage without a version", () => {
    expect(installOutcome(pending, response(status({ last: last("accepted") }), "0.2.0"))).toBe("waiting");
    expect(installOutcome(pending, response(status({ last: last("accepted") }), "0.2.1"))).toBe("done");
    const accepted = response(status({ last: last("accepted") }), null);
    expect(installOutcome(pending, accepted)).toBe("waiting");
    expect(installOutcome({ ...pending, outage: true }, accepted)).toBe("done");
  });

  it("is done when nothing reports the installation any more and the app runs the version", () => {
    expect(installOutcome(pending, response(status(), "0.2.1"))).toBe("done");
    expect(installOutcome(pending, response(status(), "0.2.0"))).toBe("waiting");
    // Without the updater it is not known whether the server still installs.
    expect(installOutcome(pending, response(null, "0.2.1"))).toBe("waiting");
  });

  it("failed when the updater reports it failed or rolled back, without the offer saying so", () => {
    const available = update({ failed: null });
    expect(installOutcome(pending, response(status({ available, last: last("failed") })))).toBe("failed");
    expect(installOutcome(pending, response(status({ available, last: last("rolled-back") })))).toBe(
      "failed",
    );
    // The failure wins over a new version the app answered with before the rollback.
    expect(installOutcome(pending, response(status({ last: last("rolled-back") }), "0.2.1"))).toBe("failed");
  });

  it("ignores a result that finished before the installation started", () => {
    const stale = "2026-11-19T08:59:59Z";
    expect(installOutcome(pending, response(status({ last: last("failed", stale) })))).toBe("waiting");
    expect(installOutcome(pending, response(status({ last: last("installed", stale) })))).toBe("waiting");
    // Counted from the updater's start once a status reported it.
    const reported = { ...pending, serverStartedAt: "2026-11-19T09:00:30Z" };
    expect(installOutcome(reported, response(status({ last: last("failed", "2026-11-19T09:00:20Z") })))).toBe(
      "waiting",
    );
    expect(installOutcome(reported, response(status({ last: last("failed", "2026-11-19T09:00:30Z") })))).toBe(
      "failed",
    );
    // The updater writes whole seconds: a result in the same second counts.
    const late = { ...pending, startedAt: NOW + 700 };
    expect(installOutcome(late, response(status({ last: last("failed", "2026-11-19T09:00:00Z") })))).toBe(
      "failed",
    );
  });

  it("ignores a result of another version", () => {
    expect(installOutcome(pending, response(status({ last: { ...last("failed"), version: "0.2.2" } })))).toBe(
      "waiting",
    );
  });
});

describe("following an installation", () => {
  const attempt = newAttempt("0.2.1", "0.2.0", NOW);

  it("is confirmed once a status reports it, with the updater's start", () => {
    expect(attempt.confirmed).toBe(false);
    const tracked = trackInstall(attempt, response(status({ installing: installing() })), NOW + 2_000);
    expect(tracked).toMatchObject({
      version: "0.2.1",
      confirmed: true,
      serverStartedAt: "2026-11-19T09:00:01Z",
    });
    expect(trackInstall(tracked, response(status({ installing: installing() })), NOW + 4_000)).toBe(tracked);
  });

  it("follows another installation a status reports instead of an unconfirmed attempt", () => {
    const tracked = trackInstall(attempt, response(status({ installing: installing("0.2.2") })), NOW + 2_000);
    expect(tracked).toMatchObject({ version: "0.2.2", confirmed: true, startedAt: NOW + 2_000 });
  });

  it("gives up an unconfirmed attempt after 60 s", () => {
    expect(installDidNotStart(attempt, NOW + RECONCILE_MS)).toBe(false);
    expect(installDidNotStart(attempt, NOW + RECONCILE_MS + 1)).toBe(true);
    expect(installDidNotStart({ ...attempt, confirmed: true }, NOW + RECONCILE_MS + 1)).toBe(false);
  });
});

describe("afterInstallAnswer", () => {
  const attempt = newAttempt("0.2.1", "0.2.0", NOW);

  it("follows an accepted installation", () => {
    const data = response(status({ installing: installing() }));
    expect(afterInstallAnswer(attempt, { data }, NOW + 1_000)).toEqual({
      pending: { ...attempt, confirmed: true, serverStartedAt: "2026-11-19T09:00:01Z" },
      error: null,
    });
  });

  it("keeps the attempt when the answer is unclear", () => {
    const timedOut = {
      ...response(null),
      error: "The update service at http://updater:8080 did not answer within 10 seconds.",
    };
    expect(afterInstallAnswer(attempt, { data: timedOut }, NOW + 10_000)).toEqual({
      pending: { ...attempt, reason: timedOut.error },
      error: null,
    });
    for (const error of [
      new TypeError("Failed to fetch"),
      new ApiError(502, "internal_error", "Bad gateway"),
    ]) {
      expect(afterInstallAnswer(attempt, { error }, NOW + 1_000)).toMatchObject({
        pending: { version: "0.2.1", confirmed: false, reason: error.message },
        error: null,
      });
    }
  });

  it("forgets a refused attempt", () => {
    const refused = { ...response(status()), error: "0.2.1 is not offered; check again." };
    expect(afterInstallAnswer(attempt, { data: refused }, NOW + 1_000)).toEqual({
      pending: null,
      error: "0.2.1 is not offered; check again.",
    });
    expect(afterInstallAnswer(attempt, { error: new ApiError(403, "forbidden", "No access") }, NOW)).toEqual({
      pending: null,
      error: "No access",
    });
  });

  it("follows the installation a refusal reports", () => {
    const faster = {
      ...response(status({ installing: installing("0.2.2") })),
      error: "An installation runs.",
    };
    expect(afterInstallAnswer(attempt, { data: faster }, NOW + 1_000)).toEqual({
      pending: {
        version: "0.2.2",
        startedAt: NOW + 1_000,
        confirmed: true,
        serverStartedAt: "2026-11-19T09:00:01Z",
        reason: null,
        fromVersion: "0.2.0",
        outage: false,
      },
      error: "An installation runs.",
    });
    const same = { ...response(status({ installing: installing() })), error: "An installation runs." };
    expect(afterInstallAnswer(attempt, { data: same }, NOW + 1_000).pending).toMatchObject({
      version: "0.2.1",
      startedAt: NOW,
      confirmed: true,
    });
  });
});

describe("isOutage", () => {
  it("takes network errors and gateway errors as the restart", () => {
    expect(isOutage(new TypeError("Failed to fetch"))).toBe(true);
    expect(isOutage(new ApiError(502, "internal_error", "Bad gateway"))).toBe(true);
    expect(isOutage(new ApiError(503, "internal_error", "Unavailable"))).toBe(true);
    expect(isOutage(new ApiError(403, "forbidden", "No"))).toBe(false);
  });

  it("stops polling when the session ended", () => {
    expect(isSignedOut(new ApiError(401, "unauthorized", "Sign in"))).toBe(true);
    expect(isSignedOut(new ApiError(403, "forbidden", "No"))).toBe(true);
    expect(isSignedOut(new ApiError(502, "internal_error", "Bad gateway"))).toBe(false);
    expect(isSignedOut(new TypeError("Failed to fetch"))).toBe(false);
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
    window.sessionStorage.setItem(
      "helpdesk.updates.installing",
      JSON.stringify({ version: "0.2.1", startedAt: NOW, lastBefore: null }),
    );
    expect(readPendingInstall()).toEqual({ ...newAttempt("0.2.1", null, NOW) });
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
