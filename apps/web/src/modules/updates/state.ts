import type { Update, UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { ApiError, errorMessage } from "@/lib/api";

/**
 * What the update button shows, derived from the latest `GET /updates` answer
 * (https://github.com/meldgrove/updater#the-apps-update-button) and what this
 * page is doing.
 */
export type ButtonState =
  | { kind: "checking" }
  | {
      kind: "up-to-date";
      installed: string | null;
      /** Why the last check failed: then it is not known whether this is the newest version. */
      error: string | null;
    }
  | { kind: "available"; update: Update }
  | { kind: "attention"; update: Update }
  | {
      kind: "installing";
      version: string;
      stage: NonNullable<UpdaterStatus["installing"]>["stage"] | null;
      /** The app does not answer: it restarts. */
      restarting: boolean;
      /** Waiting for more than 15 minutes. */
      slow: boolean;
    }
  | {
      kind: "failed";
      version: string;
      message: string | null;
      /** The offer of that version; null: no longer offered, so it cannot be tried again. */
      update: Update | null;
    }
  | { kind: "off" }
  | { kind: "unreachable" };

/**
 * An installation this page follows: one it asked for, or one a status
 * reported. Kept in sessionStorage so a reload keeps following it.
 */
export type PendingInstall = {
  version: string;
  /** When this page started the attempt or took the installation over (epoch ms, this browser's clock). */
  startedAt: number;
  /** The updater accepted it (202), or a status reported it; an unconfirmed attempt ends after 60 s. */
  confirmed: boolean;
  /** `installing.startedAt` once a status reported the installation (the updater's clock). */
  serverStartedAt: string | null;
  /** Why the answer to the install request was unclear; named when the installation did not start. */
  reason: string | null;
  /** The app's version before. */
  fromVersion: string | null;
  /** The app stopped answering at some point: it restarted. */
  outage: boolean;
};

/** An installation this page followed until the updater reported that it failed or rolled back. */
export type InstallFailure = { version: string; message: string | null; finishedAt: string };

export const SLOW_INSTALL_MS = 15 * 60_000;
/** How long an attempt without a clear answer waits for a status that reports it. */
export const RECONCILE_MS = 60_000;

export function buttonState(input: {
  data: UpdatesResponse | undefined;
  /** The last `GET /updates` failed. */
  loadFailed: boolean;
  /** A check this page asked for runs. */
  checking: boolean;
  pending: PendingInstall | null;
  /** The installation this page followed failed. */
  failure?: InstallFailure | null;
  restarting: boolean;
  now: number;
}): ButtonState | null {
  const { data, pending } = input;
  const status = data?.reachable ? data.updater : null;

  if (pending || status?.installing) {
    const version = pending?.version ?? status!.installing!.version;
    return {
      kind: "installing",
      version,
      stage: status?.installing?.version === version ? status.installing.stage : null,
      restarting: input.restarting,
      slow: pending !== null && input.now - pending.startedAt > SLOW_INSTALL_MS,
    };
  }
  if (input.checking || status?.checking) return { kind: "checking" };

  // The failure this page saw, as long as the updater's last result is still that one.
  const failure = input.failure;
  if (
    failure &&
    (!status || (status.last?.version === failure.version && status.last.finishedAt === failure.finishedAt))
  ) {
    return {
      kind: "failed",
      version: failure.version,
      message: failure.message ?? offerOf(status, failure.version)?.failed ?? null,
      update: offerOf(status, failure.version),
    };
  }
  if (!data) return input.loadFailed ? { kind: "unreachable" } : null;
  if (!status) return { kind: "unreachable" };

  // The offer failed before, or the last installation of exactly that version failed.
  const offer = status.available ?? status.attention;
  const lastFailed =
    status.last?.result === "failed" || status.last?.result === "rolled-back" ? status.last : null;
  if (offer && lastFailed && (offer.failed || lastFailed.version === offer.version)) {
    return {
      kind: "failed",
      version: offer.version,
      update: offer,
      message: (lastFailed.version === offer.version ? lastFailed.message : null) ?? offer.failed,
    };
  }
  if (status.available) return { kind: "available", update: status.available };
  if (status.attention) return { kind: "attention", update: status.attention };
  // Mode off still shows what is new (without installing); "off" only when nothing is.
  if (status.mode === "off") return { kind: "off" };
  return { kind: "up-to-date", installed: status.installed ?? data.app.version, error: status.error };
}

/** The available or attention offer of a version. */
function offerOf(status: UpdaterStatus | null, version: string): Update | null {
  if (status?.available?.version === version) return status.available;
  if (status?.attention?.version === version) return status.attention;
  return null;
}

/** Whether a click opens the popover (otherwise it checks). */
export function hasPopover(state: ButtonState): boolean {
  return ["available", "attention", "failed", "installing"].includes(state.kind);
}

/**
 * What the popover offers for a version: "install" (Install now / Try again),
 * "install-anyway" (a release with upgrade steps, confirmed as such),
 * "locked" (needs upgrade steps, and the image tag set where the app is
 * deployed does not reach it: the platform's tag must change), "off" (the
 * server installs nothing from here), or null (no longer offered).
 */
export function installAction(
  status: UpdaterStatus | null,
  version: string,
): "install" | "install-anyway" | "locked" | "off" | null {
  if (!status) return null;
  if (status.mode === "off") return "off";
  if (status.available?.version === version) return "install";
  if (status.attention?.version === version)
    return status.channelLocked === null ? "install-anyway" : "locked";
  return null;
}

/** The new attempt, remembered before the install request. */
export function newAttempt(version: string, fromVersion: string | null, now: number): PendingInstall {
  return {
    version,
    startedAt: now,
    confirmed: false,
    serverStartedAt: null,
    reason: null,
    fromVersion,
    outage: false,
  };
}

/** Follows an installation a status reports (from a poll, a check or a refusal); null: none runs. */
export function adoptInstall(data: UpdatesResponse, now: number): PendingInstall | null {
  const installing = data.reachable ? data.updater?.installing : null;
  if (!installing) return null;
  return {
    version: installing.version,
    startedAt: now,
    confirmed: true,
    serverStartedAt: installing.startedAt,
    reason: null,
    fromVersion: data.app.version,
    outage: false,
  };
}

/**
 * The updater's last result, when it names the version and finished at or
 * after the installation started (whole seconds, as the updater writes
 * them): from `installing.startedAt` once a status reported it, otherwise
 * from when this page started the attempt.
 */
export function freshLast(pending: PendingInstall, data: UpdatesResponse): UpdaterStatus["last"] {
  const last = data.reachable ? data.updater?.last : null;
  if (!last || last.version !== pending.version) return null;
  const serverStart = pending.serverStartedAt ? Date.parse(pending.serverStartedAt) : NaN;
  const since = Number.isFinite(serverStart) ? serverStart : pending.startedAt;
  return Date.parse(last.finishedAt) >= Math.floor(since / 1000) * 1000 ? last : null;
}

/**
 * The attempt after a fresh status: confirmed once the status reports the
 * installation or its result; an unconfirmed attempt gives way to another
 * installation the status reports. Returns the same object when nothing changed.
 */
export function trackInstall(pending: PendingInstall, data: UpdatesResponse, now: number): PendingInstall {
  const installing = data.reachable ? data.updater?.installing : null;
  if (installing?.version === pending.version) {
    return pending.confirmed && pending.serverStartedAt === installing.startedAt
      ? pending
      : { ...pending, confirmed: true, serverStartedAt: installing.startedAt };
  }
  if (pending.confirmed) return pending;
  if (installing) return adoptInstall(data, now)!;
  return freshLast(pending, data) ? { ...pending, confirmed: true } : pending;
}

/**
 * How a followed installation stands after a fresh status, in this order:
 * its result failed or rolled back → failed; the updater still installs it
 * → waiting (even when the app already answers with the new version: a
 * server reports the result only when every service is healthy, and may
 * still roll back); installed → done; accepted by the platform → done once
 * the app runs the version (without an app version: once it answered after
 * an outage); nothing reports it any more → done when the app runs the
 * version. A `last` from before the installation does not count.
 */
export function installOutcome(
  pending: PendingInstall,
  data: UpdatesResponse,
): "done" | "failed" | "waiting" {
  const status = data.reachable ? data.updater : null;
  const last = freshLast(pending, data);
  if (last?.result === "failed" || last?.result === "rolled-back") return "failed";
  if (status?.installing?.version === pending.version) return "waiting";
  if (last?.result === "installed") return "done";
  if (last?.result === "accepted") {
    if (data.app.version !== null) return data.app.version === pending.version ? "done" : "waiting";
    return pending.outage ? "done" : "waiting";
  }
  return status && data.app.version === pending.version ? "done" : "waiting";
}

/** An unconfirmed attempt that no status reported within 60 s: it did not start. */
export function installDidNotStart(pending: PendingInstall, now: number): boolean {
  return !pending.confirmed && now - pending.startedAt > RECONCILE_MS;
}

/** The answer to `POST /updates/install`: the route's body (also a 409's), or what it threw. */
export type InstallAnswer = { data: UpdatesResponse } | { error: unknown };

/**
 * The attempt after the install request's answer, and the error to show:
 * - 202: confirmed; follow it.
 * - a refusal (409 or another 4xx): forget it and show the error, unless the
 *   returned status reports an installation (another admin or an automatic
 *   install was faster): follow that one instead.
 * - unclear (`reachable: false`, a network error, a timeout, a 5xx): keep it
 *   unconfirmed; the status tells within 60 s whether it started.
 */
export function afterInstallAnswer(
  pending: PendingInstall,
  answer: InstallAnswer,
  now: number,
): { pending: PendingInstall | null; error: string | null } {
  if ("error" in answer) {
    const refused = answer.error instanceof ApiError && answer.error.status < 500;
    return refused
      ? { pending: null, error: errorMessage(answer.error) }
      : { pending: { ...pending, reason: errorMessage(answer.error) }, error: null };
  }
  const { data } = answer;
  if (!data.reachable) return { pending: { ...pending, reason: data.error }, error: null };
  if (data.error) {
    const installing = data.updater?.installing;
    if (!installing) return { pending: null, error: data.error };
    return {
      pending:
        installing.version === pending.version ? trackInstall(pending, data, now) : adoptInstall(data, now),
      error: data.error,
    };
  }
  return { pending: trackInstall({ ...pending, confirmed: true }, data, now), error: null };
}

/** A failed poll while the app restarts: no answer, or the proxy's 5xx. Keep polling. */
export function isOutage(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

/** The session ended (401, 403, or a sign-in page answered): stop polling, keep the attempt. */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

const STORAGE_KEY = "helpdesk.updates.installing";

export function readPendingInstall(): PendingInstall | null {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<PendingInstall> | null;
    if (!value || typeof value.version !== "string" || typeof value.startedAt !== "number") return null;
    return {
      version: value.version,
      startedAt: value.startedAt,
      confirmed: value.confirmed === true,
      serverStartedAt: typeof value.serverStartedAt === "string" ? value.serverStartedAt : null,
      reason: typeof value.reason === "string" ? value.reason : null,
      fromVersion: typeof value.fromVersion === "string" ? value.fromVersion : null,
      outage: value.outage === true,
    };
  } catch {
    return null;
  }
}

export function writePendingInstall(value: PendingInstall | null) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the page still waits until it is reloaded.
  }
}

const COOLDOWN_UNITS: Record<string, [one: string, many: string]> = {
  d: ["day", "days"],
  h: ["hour", "hours"],
  m: ["minute", "minutes"],
  s: ["second", "seconds"],
};

/** "3d" → "3 days", "12h" → "12 hours", "90" → "90 seconds". */
export function formatCooldown(cooldown: string): string {
  const match = /^(\d+)([dhms]?)$/.exec(cooldown.trim());
  if (!match) return cooldown;
  const count = Number(match[1]);
  const [one, many] = COOLDOWN_UNITS[match[2] || "s"]!;
  return `${count} ${count === 1 ? one : many}`;
}

/** "02:00-05:00" → ["02:00", "05:00"]. */
export function parseWindow(window: string | null): [string, string] | null {
  const match = window ? /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(window) : null;
  return match ? [match[1]!, match[2]!] : null;
}

/** The notes the popover lists (at most 8) and how many changes it leaves out. */
export function visibleNotes(update: Update, max = 8): { notes: string[]; more: number } {
  const notes = update.notes.slice(0, max);
  return { notes, more: Math.max(0, Math.max(update.changes, update.notes.length) - notes.length) };
}
