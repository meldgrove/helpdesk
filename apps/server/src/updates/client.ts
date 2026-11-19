import { updaterStatusSchema, type UpdateChannel, type UpdaterStatus } from "@helpdesk/shared/api/updates";

/**
 * A client for the Meldgrove Updater's HTTP API (no authentication; it is
 * reachable only on the Compose network). Every call ends in one of:
 * - ok: the updater's status;
 * - refused: the updater answered with an error (`{ error }`, 4xx or 5xx);
 * - unreachable: no answer in time, no connection, or not an updater's answer.
 */
export type UpdaterResult =
  | { kind: "ok"; status: UpdaterStatus }
  | { kind: "refused"; httpStatus: number; error: string }
  | { kind: "unreachable"; error: string };

/** How long each call may take; the updater checks for up to 30 s. */
export const UPDATER_TIMEOUTS = { status: 3_000, check: 35_000, install: 10_000, channel: 35_000 };

export type UpdaterClient = {
  status(): Promise<UpdaterResult>;
  check(): Promise<UpdaterResult>;
  install(version: string): Promise<UpdaterResult>;
  channel(channel: UpdateChannel): Promise<UpdaterResult>;
};

export function createUpdaterClient(
  baseUrl: string,
  options: { fetch?: typeof fetch; timeouts?: typeof UPDATER_TIMEOUTS } = {},
): UpdaterClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeouts = options.timeouts ?? UPDATER_TIMEOUTS;

  async function call(method: "GET" | "POST", path: string, timeoutMs: number, body?: unknown) {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers:
          body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        kind: "unreachable",
        error: timedOut
          ? `The update service at ${baseUrl} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
          : `No connection to the update service at ${baseUrl}.`,
      } satisfies UpdaterResult;
    }
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: an error page of something else, or not an updater.
    }
    if (!response.ok) {
      const message = (data as { error?: unknown } | null)?.error;
      return {
        kind: "refused",
        httpStatus: response.status,
        error:
          typeof message === "string" && message.trim()
            ? message.slice(0, 1000)
            : `The update service answered with status ${response.status}.`,
      } satisfies UpdaterResult;
    }
    const status = updaterStatusSchema.safeParse(data);
    if (!status.success) {
      return {
        kind: "unreachable",
        error: `Something other than the update service answered at ${baseUrl}.`,
      } satisfies UpdaterResult;
    }
    return { kind: "ok", status: status.data } satisfies UpdaterResult;
  }

  return {
    status: () => call("GET", "/v1/status", timeouts.status),
    check: () => call("POST", "/v1/check", timeouts.check),
    install: (version) => call("POST", "/v1/install", timeouts.install, { version }),
    channel: (channel) => call("POST", "/v1/channel", timeouts.channel, { channel }),
  };
}
