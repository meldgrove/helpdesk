import type { Update, UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { ApiError } from "@/lib/api";

/**
 * What the update button shows (Meldgrove docs/updates.md, "Button"), derived
 * from the latest `GET /updates` answer and what this page is doing.
 */
export type ButtonState =
  | { kind: "checking" }
  | { kind: "up-to-date"; installed: string | null }
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
  | { kind: "failed"; update: Update; message: string | null }
  | { kind: "off" }
  | { kind: "unreachable" };

/** An installation this page started and waits for; kept in sessionStorage so a reload keeps waiting. */
export type PendingInstall = {
  version: string;
  /** When it was started (epoch ms). */
  startedAt: number;
  /** The app's version before. */
  fromVersion: string | null;
  /** `updater.last.finishedAt` before, to tell a new result from an earlier one. */
  lastBefore: string | null;
  /** The app stopped answering at some point: it restarted. */
  outage: boolean;
};

export const SLOW_INSTALL_MS = 15 * 60_000;

export function buttonState(input: {
  data: UpdatesResponse | undefined;
  /** The last `GET /updates` failed. */
  loadFailed: boolean;
  /** A check this page asked for runs. */
  checking: boolean;
  pending: PendingInstall | null;
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
  if (!data) return input.loadFailed ? { kind: "unreachable" } : null;
  if (!status) return { kind: "unreachable" };
  if (status.mode === "off") return { kind: "off" };

  const failedUpdate = status.available?.failed
    ? status.available
    : !status.available && status.attention?.failed
      ? status.attention
      : null;
  if (failedUpdate && (status.last?.result === "failed" || status.last?.result === "rolled-back")) {
    return {
      kind: "failed",
      update: failedUpdate,
      message:
        (status.last.version === failedUpdate.version ? status.last.message : null) ?? failedUpdate.failed,
    };
  }
  if (status.available) return { kind: "available", update: status.available };
  if (status.attention) return { kind: "attention", update: status.attention };
  return { kind: "up-to-date", installed: status.installed ?? data.app.version };
}

/** Whether a click opens the popover (otherwise it checks). */
export function hasPopover(state: ButtonState): boolean {
  return ["available", "attention", "failed", "installing"].includes(state.kind);
}

/**
 * How an installation this page waits for ended: done when the app runs the
 * version, or when the updater reports it installed (or the platform
 * accepted it) and the app's version changed or it answered again after an
 * outage; failed when the updater reports it failed or rolled back.
 */
export function installOutcome(
  pending: PendingInstall,
  data: UpdatesResponse,
): "done" | "failed" | "waiting" {
  if (data.app.version === pending.version) return "done";
  const status = data.reachable ? data.updater : null;
  const last = status?.last;
  if (!status || status.installing || !last) return "waiting";
  if (last.version !== pending.version || last.finishedAt === pending.lastBefore) return "waiting";
  if (last.result === "failed" || last.result === "rolled-back") return "failed";
  if (data.app.version !== pending.fromVersion || pending.outage) return "done";
  return "waiting";
}

/** A failed poll while the app restarts: no answer, or the proxy's 5xx. Keep polling. */
export function isOutage(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

const STORAGE_KEY = "helpdesk.updates.installing";

export function readPendingInstall(): PendingInstall | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as PendingInstall | null;
    return value && typeof value.version === "string" && typeof value.startedAt === "number" ? value : null;
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
