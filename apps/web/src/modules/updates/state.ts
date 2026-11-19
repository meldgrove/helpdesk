import {
  INSTALL_RESULTS,
  type Update,
  type UpdatesResponse,
  type UpdaterStatus,
} from "@helpdesk/shared/api/updates";
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
  | {
      kind: "available";
      update: Update;
      /** An earlier version failed: shown as a line in the newer offer. */
      failure: EarlierFailure | null;
    }
  | { kind: "attention"; update: Update; failure: EarlierFailure | null }
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

/** The updater's result of the last installation. */
export type LastResult = NonNullable<UpdaterStatus["last"]>;

/** A version that failed to install, shown in the offer of a newer one. */
export type EarlierFailure = { version: string; message: string | null };

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
  /**
   * `installing.startedAt` once a status reported the installation (the
   * updater's clock): with the version, the installation's identity.
   */
  serverStartedAt: string | null;
  /** The `last` of the newest status before the attempt (the earlier result): never this attempt's result. */
  earlier: LastResult | null;
  /** Why the answer to the install request was unclear; named when the installation did not start. */
  reason: string | null;
  /** The app's version before. */
  fromVersion: string | null;
  /** The app or the updater stopped answering at some point (no answer, 5xx, `reachable: false`): it restarted. */
  outage: boolean;
  /** A reachable status answered without the unconfirmed attempt: at the deadline, it did not start. */
  answered: boolean;
  /** The last status request's error; named when the attempt could not be confirmed. */
  lastError: string | null;
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

  // The failure this page saw, as long as the updater's last result is still that one
  // and no newer version is offered instead.
  const offer = status ? (status.available ?? status.attention) : null;
  const seen = input.failure;
  const failure =
    seen && (!status || (status.last?.version === seen.version && status.last.finishedAt === seen.finishedAt))
      ? seen
      : null;
  if (failure && (!offer || offerOf(status, failure.version))) {
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
  // A newer version is offered: it replaces the failure, which stays as a line in it.
  const earlier = lastFailed && {
    version: lastFailed.version,
    message: failure?.message ?? lastFailed.message,
  };
  if (status.available) return { kind: "available", update: status.available, failure: earlier };
  if (status.attention) return { kind: "attention", update: status.attention, failure: earlier };
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

/**
 * The new attempt, remembered before the install request, with the `last`
 * of the newest status before it (the earlier result).
 */
export function newAttempt(
  version: string,
  fromVersion: string | null,
  now: number,
  earlier: LastResult | null = null,
): PendingInstall {
  return {
    version,
    startedAt: now,
    confirmed: false,
    serverStartedAt: null,
    earlier,
    reason: null,
    fromVersion,
    outage: false,
    answered: false,
    lastError: null,
  };
}

/** Follows an installation a status reports (from a poll, a check or a refusal); null: none runs. */
export function adoptInstall(data: UpdatesResponse, now: number): PendingInstall | null {
  const installing = data.reachable ? data.updater?.installing : null;
  if (!installing) return null;
  return {
    ...newAttempt(installing.version, data.app.version, now, data.updater?.last ?? null),
    confirmed: true,
    serverStartedAt: installing.startedAt,
  };
}

/** Whole seconds, as the updater writes its times. */
const wholeSeconds = (ms: number) => Math.floor(ms / 1000) * 1000;

/**
 * The updater's last result, when it is this installation's: it names the
 * version, is not the earlier result, and finished at or after the
 * installation started: `installing.startedAt` once a status reported it,
 * otherwise when this page started the attempt, cut to whole seconds (the
 * updater writes whole seconds).
 */
export function freshLast(pending: PendingInstall, data: UpdatesResponse): UpdaterStatus["last"] {
  const last = data.reachable ? data.updater?.last : null;
  if (!last || last.version !== pending.version) return null;
  const earlier = pending.earlier;
  if (
    earlier &&
    earlier.version === last.version &&
    earlier.result === last.result &&
    earlier.finishedAt === last.finishedAt
  ) {
    return null;
  }
  const serverStart = pending.serverStartedAt ? Date.parse(pending.serverStartedAt) : NaN;
  const since = Number.isFinite(serverStart) ? serverStart : pending.startedAt;
  return Date.parse(last.finishedAt) >= wholeSeconds(since) ? last : null;
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

/** Returns `pending` itself when `changes` change nothing. */
function patch(pending: PendingInstall, changes: Partial<PendingInstall>): PendingInstall {
  const keys = Object.keys(changes) as (keyof PendingInstall)[];
  return keys.every((key) => pending[key] === changes[key]) ? pending : { ...pending, ...changes };
}

/**
 * The attempt after a status answered while this page follows it:
 * confirmed or replaced as `trackInstall` decides. `reachable: false`
 * counts as an outage (the app restarts). A reachable status without the
 * unconfirmed attempt is remembered for its deadline, once the install
 * request's answer was unclear (`reason`): a status from before the updater
 * got the request tells nothing.
 */
export function observeStatus(pending: PendingInstall, data: UpdatesResponse, now: number): PendingInstall {
  const tracked = trackInstall(pending, data, now);
  if (!data.reachable) return patch(tracked, { outage: true, lastError: data.error ?? tracked.lastError });
  if (!tracked.confirmed && tracked.reason !== null && data.updater)
    return patch(tracked, { answered: true });
  return tracked;
}

/** The attempt after a status request failed: no answer or a 5xx counts as an outage. */
export function observeError(pending: PendingInstall, error: unknown): PendingInstall {
  return isOutage(error) ? patch(pending, { outage: true, lastError: errorMessage(error) }) : pending;
}

/** When an unconfirmed attempt ends (epoch ms): 60 s after it started. Null once confirmed. */
export function reconcileDeadline(pending: PendingInstall): number | null {
  return pending.confirmed ? null : pending.startedAt + RECONCILE_MS;
}

/**
 * Why an unconfirmed attempt ended at its deadline: it did not start when a
 * reachable status answered without it (with the reason the install answer
 * was unclear); otherwise it could not be confirmed (with the last error).
 */
export function unconfirmedEnd(pending: PendingInstall): {
  started: "no" | "unknown";
  detail: string | null;
} {
  return pending.answered
    ? { started: "no", detail: pending.reason }
    : { started: "unknown", detail: pending.lastError ?? pending.reason };
}

/**
 * The answer to `POST /updates/install`: the route's body (also a 409's),
 * a 202 whose body could not be read, or what it threw.
 */
export type InstallAnswer = { data: UpdatesResponse } | { accepted: true } | { error: unknown };

/**
 * The attempt after the install request's answer, and the error to show:
 * - 202: confirmed; follow it (also when its body could not be read).
 * - a refusal (409 or another 4xx): forget it and show the error, unless the
 *   returned status reports an installation (another admin or an automatic
 *   install was faster): follow that one instead.
 * - unclear (`reachable: false`, a network error, a timeout, an unreadable
 *   answer, a 5xx): keep it unconfirmed; the status tells within 60 s
 *   whether it started.
 */
export function afterInstallAnswer(
  pending: PendingInstall,
  answer: InstallAnswer,
  now: number,
): { pending: PendingInstall | null; error: string | null } {
  if ("accepted" in answer) return { pending: patch(pending, { confirmed: true }), error: null };
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

/**
 * The session ended (401, 403, or a sign-in page answered): stop every
 * automatic status request, keep the attempt.
 */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/**
 * The installation an admin stopped waiting for, by the identity stored on
 * the attempt: its version and `installing.startedAt`, or, when no status
 * reported it, the attempt's start.
 */
export type IgnoredInstall = { version: string; serverStartedAt: string | null; startedAt: number };

export function ignoreInstall(pending: PendingInstall): IgnoredInstall {
  return { version: pending.version, serverStartedAt: pending.serverStartedAt, startedAt: pending.startedAt };
}

/**
 * Whether a reported installation is the ignored one. Without its start it
 * is the first installation of the version that started at or after the
 * attempt (whole seconds); the caller then stores that start.
 */
export function isIgnored(
  ignored: IgnoredInstall | null,
  installing: { version: string; startedAt: string },
): boolean {
  if (!ignored || installing.version !== ignored.version) return false;
  if (ignored.serverStartedAt !== null) return installing.startedAt === ignored.serverStartedAt;
  return Date.parse(installing.startedAt) >= wholeSeconds(ignored.startedAt);
}

const STORAGE_KEY = "helpdesk.updates.installing";
const IGNORED_KEY = "helpdesk.updates.ignored";

function readStored(key: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: object | null) {
  try {
    if (value) window.sessionStorage.setItem(key, JSON.stringify(value));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage blocked: the page still knows it until it is reloaded.
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

function readLast(value: unknown): LastResult | null {
  const last = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (
    typeof last?.version !== "string" ||
    typeof last.finishedAt !== "string" ||
    !INSTALL_RESULTS.includes(last.result as LastResult["result"])
  ) {
    return null;
  }
  return {
    version: last.version,
    result: last.result as LastResult["result"],
    message: text(last.message),
    finishedAt: last.finishedAt,
  };
}

export function readPendingInstall(): PendingInstall | null {
  const value = readStored(STORAGE_KEY);
  if (!value || typeof value.version !== "string" || typeof value.startedAt !== "number") return null;
  return {
    version: value.version,
    startedAt: value.startedAt,
    confirmed: value.confirmed === true,
    serverStartedAt: text(value.serverStartedAt),
    earlier: readLast(value.earlier),
    reason: text(value.reason),
    fromVersion: text(value.fromVersion),
    outage: value.outage === true,
    answered: value.answered === true,
    lastError: text(value.lastError),
  };
}

export function writePendingInstall(value: PendingInstall | null) {
  writeStored(STORAGE_KEY, value);
}

export function readIgnoredInstall(): IgnoredInstall | null {
  const value = readStored(IGNORED_KEY);
  if (!value || typeof value.version !== "string" || typeof value.startedAt !== "number") return null;
  return { version: value.version, serverStartedAt: text(value.serverStartedAt), startedAt: value.startedAt };
}

export function writeIgnoredInstall(value: IgnoredInstall | null) {
  writeStored(IGNORED_KEY, value);
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
