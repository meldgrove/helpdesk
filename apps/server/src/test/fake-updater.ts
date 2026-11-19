import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { UpdaterStatus } from "@helpdesk/shared/api/updates";

/** A status as the Meldgrove Updater answers it: 0.2.0 installed, 0.2.1 available. */
export function updaterStatus(overrides: Partial<UpdaterStatus> = {}): UpdaterStatus {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: {
      version: "0.2.1",
      preview: false,
      publishedAt: "2026-11-17T10:00:00.000Z",
      url: "https://github.com/meldgrove/helpdesk/releases/tag/v0.2.1",
      notes: ["Fix the board filters"],
      changes: 1,
      installsAt: "2026-11-20T02:00:00.000Z",
      failed: null,
    },
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: "2026-11-19T08:00:00.000Z",
    error: null,
    automatic: true,
    cooldown: "3d",
    window: "02:00-05:00",
    timezone: "UTC",
    ...overrides,
  };
}

type Reply = { status?: number; body?: unknown; text?: string; delayMs?: number };
type Received = { method: string; path: string; body: unknown };

/**
 * A stand-in for the updater's HTTP API on a free local port. Each request
 * gets `reply(method, path)` (default: 200 with `updaterStatus()`); every
 * request is recorded in `received`.
 */
export async function startFakeUpdater() {
  const received: Received[] = [];
  let reply: (method: string, path: string) => Reply = () => ({ body: updaterStatus() });
  const server: Server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const path = new URL(request.url ?? "/", "http://updater").pathname;
    received.push({ method: request.method ?? "", path, body: text ? JSON.parse(text) : undefined });
    const answer = reply(request.method ?? "", path);
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if (response.destroyed) return;
    response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    response.end(answer.text ?? JSON.stringify(answer.body ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    reply(handler: (method: string, path: string) => Reply) {
      reply = handler;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
