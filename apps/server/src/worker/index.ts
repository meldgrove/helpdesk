import { writeFile } from "node:fs/promises";
import type pg from "pg";
import { config } from "../config";
import { getPool } from "../db/client";
import { logger } from "../logger";
import { monitored } from "../error-reporting";
import { deliverDue, pruneNotifications } from "../notifications/deliver";
import { NOTIFY_CHANNEL } from "../notifications/enqueue";
import { syncDirectory } from "../directory/sync";
import { pruneUnusedUploads } from "../attachments/storage";

const POLL_MS = 5_000;

export type Stop = () => Promise<void>;

/** Repeats a job every `minutes`, first after `firstDelayMs`; errors are logged, never thrown. */
function every(minutes: number, firstDelayMs: number, name: string, job: () => Promise<unknown>): Stop {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const run = () => {
    running = job()
      .catch((error: unknown) => logger.error({ err: error, task: name }, "scheduled job failed"))
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(run, minutes * 60_000);
      });
  };
  timer = setTimeout(run, firstDelayMs);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

/**
 * The worker: sends emails and Slack messages (woken by NOTIFY, checking at
 * least every 5 seconds), syncs the directory (DIRECTORY=keycloak) and
 * removes old notifications.
 */
export function startWorker(): Stop {
  let stopped = false;
  let wake: (() => void) | undefined;
  let listener: pg.PoolClient | undefined;

  const listen = async () => {
    try {
      const client = await getPool().connect();
      client.on("notification", () => wake?.());
      client.on("error", (error) => {
        logger.warn({ err: error }, "notification listener lost its connection");
        client.release(true);
        if (listener === client) listener = undefined;
        if (!stopped) setTimeout(() => void listen(), POLL_MS);
      });
      await client.query(`listen ${NOTIFY_CHANNEL}`);
      listener = client;
    } catch (error) {
      logger.warn({ err: error }, "could not listen for notifications; polling only");
      if (!stopped) setTimeout(() => void listen(), POLL_MS);
    }
  };
  void listen();

  const heartbeat = config().WORKER_HEARTBEAT_FILE;
  const loop = (async () => {
    while (!stopped) {
      if (heartbeat) await writeFile(heartbeat, "").catch(() => undefined);
      try {
        if ((await deliverDue()) > 0) continue;
      } catch (error) {
        logger.error({ err: error, task: "deliver" }, "sending notifications failed");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  })();

  const stops: Stop[] = [
    every(24 * 60, 60_000, "prune-notifications", () =>
      monitored("helpdesk-prune-notifications", { minutes: 24 * 60 }, pruneNotifications),
    ),
  ];
  if (config().DIRECTORY === "keycloak") {
    const minutes = config().DIRECTORY_SYNC_MINUTES;
    stops.push(
      every(minutes, 2_000, "directory-sync", () =>
        monitored("helpdesk-directory-sync", { minutes }, () => syncDirectory()),
      ),
    );
  }
  logger.info({ directory: config().DIRECTORY }, "worker started");

  return async () => {
    stopped = true;
    wake?.();
    await Promise.all([loop, ...stops.map((stop) => stop())]);
    listener?.release();
  };
}

/** Jobs of the web process: remove uploads no ticket used. */
export function startWebJobs(): Stop {
  return every(60, 30_000, "prune-uploads", () =>
    monitored("helpdesk-prune-uploads", { minutes: 60 }, pruneUnusedUploads),
  );
}
