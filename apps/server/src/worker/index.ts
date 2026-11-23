import { writeFile } from "node:fs/promises";
import type pg from "pg";
import { config } from "../config";
import { getPool } from "../db/client";
import { databaseOutage, isDatabaseUnavailable, retryDelayMs, retryWhileUnavailable } from "../db/outage";
import { logger } from "../logger";
import { monitored } from "../error-reporting";
import { deliverDue, pruneNotifications } from "../notifications/deliver";
import { NOTIFY_CHANNEL } from "../notifications/enqueue";
import { directory } from "../directory";
import { pruneUnusedUploads } from "../attachments/storage";

const POLL_MS = 5_000;

export type Stop = () => Promise<void>;

type Schedule = { task: string; monitor: string; minutes: number; firstDelayMs: number };

/**
 * Repeats a job every `minutes`, first after `firstDelayMs`, with Sentry
 * check-ins. While the database is unreachable, a run tries again (see
 * `retryWhileUnavailable`). Errors are logged, never thrown.
 */
function every({ task, monitor, minutes, firstDelayMs }: Schedule, job: () => Promise<unknown>): Stop {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  const stopping = new AbortController();
  const run = () => {
    running = monitored(monitor, { minutes }, () =>
      retryWhileUnavailable(task, job, { signal: stopping.signal }),
    )
      .catch((error: unknown) => {
        // The outage itself is reported once, by `databaseOutage`.
        if (isDatabaseUnavailable(error)) logger.warn({ err: error, task }, "scheduled job gave up");
        else logger.error({ err: error, task }, "scheduled job failed");
      })
      .finally(() => {
        running = undefined;
        if (!stopping.signal.aborted) timer = setTimeout(run, minutes * 60_000);
      });
  };
  timer = setTimeout(run, firstDelayMs);
  return async () => {
    stopping.abort();
    clearTimeout(timer);
    await running;
  };
}

/**
 * The worker: sends emails and Slack messages (woken by NOTIFY, checking at
 * least every 5 seconds), syncs the directory (DIRECTORY=keycloak) and
 * removes old notifications. It survives a database restart: it logs
 * warnings and tries again with backoff (`db/outage.ts`).
 */
export function startWorker(): Stop {
  let stopped = false;
  let wake: (() => void) | undefined;
  let unlisten: (() => void) | undefined;
  let listenFailures = 0;
  let listenTimer: NodeJS.Timeout | undefined;

  const listenLater = () => {
    if (stopped || listenTimer) return;
    listenFailures += 1;
    listenTimer = setTimeout(() => {
      listenTimer = undefined;
      void listen();
    }, retryDelayMs(listenFailures));
  };

  const listen = async () => {
    let client: pg.PoolClient | undefined;
    let released = false;
    // Once only: a lost connection can both fail the LISTEN query and emit `error`.
    const release = () => {
      if (released) return false;
      released = true;
      if (unlisten === release) unlisten = undefined;
      client?.off("error", onError);
      client?.release(true); // ends the connection and its LISTEN
      return true;
    };
    const onError = (error: Error) => {
      logger.warn({ err: error }, "notification listener lost its connection");
      if (release()) listenLater();
    };
    try {
      client = await getPool().connect();
      client.on("notification", () => wake?.());
      client.on("error", onError);
      await client.query(`listen ${NOTIFY_CHANNEL}`);
      if (released) return;
      if (stopped) {
        release();
        return;
      }
      unlisten = release;
      listenFailures = 0;
    } catch (error) {
      logger.warn({ err: error }, "could not listen for notifications; polling only");
      if (release()) listenLater();
    }
  };
  void listen();

  const heartbeat = config().WORKER_HEARTBEAT_FILE;
  const loop = (async () => {
    let failures = 0;
    while (!stopped) {
      if (heartbeat) await writeFile(heartbeat, "").catch(() => undefined);
      let waitMs = POLL_MS;
      try {
        const handled = await deliverDue();
        failures = 0;
        databaseOutage.succeeded();
        if (handled > 0) continue;
      } catch (error) {
        if (isDatabaseUnavailable(error)) {
          failures += 1;
          databaseOutage.failed("deliver", error, failures);
          waitMs = retryDelayMs(failures);
        } else {
          logger.error({ err: error, task: "deliver" }, "sending notifications failed");
        }
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  })();

  const stops: Stop[] = [
    every(
      {
        task: "prune-notifications",
        monitor: "helpdesk-prune-notifications",
        minutes: 24 * 60,
        firstDelayMs: 60_000,
      },
      pruneNotifications,
    ),
  ];
  const { mode, sync } = directory();
  if (sync) {
    stops.push(
      every(
        {
          task: "directory-sync",
          monitor: "helpdesk-directory-sync",
          minutes: sync.everyMinutes,
          firstDelayMs: 2_000,
        },
        () => sync.run(),
      ),
    );
  }
  logger.info({ directory: mode }, "worker started");

  return async () => {
    stopped = true;
    clearTimeout(listenTimer);
    wake?.();
    await Promise.all([loop, ...stops.map((stop) => stop())]);
    unlisten?.();
  };
}

/** Jobs of the web process: remove uploads no ticket used. */
export function startWebJobs(): Stop {
  return every(
    { task: "prune-uploads", monitor: "helpdesk-prune-uploads", minutes: 60, firstDelayMs: 30_000 },
    pruneUnusedUploads,
  );
}
