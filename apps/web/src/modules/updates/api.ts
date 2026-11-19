import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { UpdateChannel, UpdatesResponse } from "@helpdesk/shared/api/updates";
import { ApiError, apiUrl, parse } from "@/lib/api";
import { isSignedOut } from "./state";

export const updatesKey = ["updates"] as const;

function isUpdatesResponse(value: unknown): value is UpdatesResponse {
  return typeof value === "object" && value !== null && "reachable" in value && "app" in value;
}

/** A sign-in page answered instead of the API: the session ended. */
const signedOut = () => new ApiError(401, "unauthorized", "Sign in again.");

/**
 * A call to the updates routes. An updater that refused (409) still answers
 * with the latest status and `error`, so that resolves too; check `error`.
 * A redirect (to sign in) or an HTML page instead of JSON is 401. Null: a
 * 202 whose body could not be read (the installation was accepted).
 */
async function send(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<UpdatesResponse | null> {
  const response = await fetch(apiUrl(path), {
    method,
    credentials: "same-origin",
    // A redirect leads to a sign-in page, never to these routes.
    redirect: "manual",
    headers:
      body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (response.type === "opaqueredirect") throw signedOut();
  let data: unknown;
  try {
    data = await parse<unknown>(response);
  } catch (error) {
    // Accepted; only reading the answer failed.
    if (response.status === 202) return null;
    if (error instanceof ApiError && error.status === 409 && isUpdatesResponse(error.body)) return error.body;
    throw error;
  }
  if (isUpdatesResponse(data)) return data;
  if (response.status === 202) return null;
  if (response.headers.get("content-type")?.includes("text/html")) throw signedOut();
  throw new Error(`The answer could not be read (${response.status}).`);
}

async function call(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) {
  const data = await send(method, path, body, signal);
  if (!data) throw new Error("The answer could not be read (202).");
  return data;
}

export const fetchUpdates = (signal?: AbortSignal) => call("GET", "/updates", undefined, signal);

/**
 * Pages (query clients) where a request of the updates routes found the
 * session ended (401, 403 or a sign-in page): from then on no automatic
 * status request, neither of the install watch nor of any status observer,
 * also one that mounts later. A reload starts again.
 */
const signedOutPages = new WeakSet<QueryClient>();
const signedOutListeners = new Set<() => void>();

function subscribeSignedOut(listener: () => void) {
  signedOutListeners.add(listener);
  return () => void signedOutListeners.delete(listener);
}

export function markSignedOut(client: QueryClient) {
  if (signedOutPages.has(client)) return;
  signedOutPages.add(client);
  for (const listener of signedOutListeners) listener();
}

export const isPageSignedOut = (client: QueryClient) => signedOutPages.has(client);

/** Marks the page signed out when `error` says so; returns it. */
function noteSignedOut(client: QueryClient, error: unknown) {
  if (isSignedOut(error)) markSignedOut(client);
  return error;
}

/**
 * The updater's status for superadmins: on page load, every 5 minutes and
 * when the window regains focus (at most once a minute). Never checks by
 * itself. `polling: false` while the button polls an installation. Once the
 * page is signed out, no more automatic requests.
 */
export function useUpdates(options: { enabled?: boolean; polling?: boolean } = {}) {
  const client = useQueryClient();
  const signedOutPage = useSyncExternalStore(subscribeSignedOut, () => isPageSignedOut(client));
  const automatic = options.polling !== false;
  return useQuery({
    queryKey: updatesKey,
    queryFn: ({ signal }) =>
      fetchUpdates(signal).catch((error: unknown) => {
        throw noteSignedOut(client, error);
      }),
    enabled: (options.enabled ?? true) && !signedOutPage,
    staleTime: 60_000,
    refetchOnWindowFocus: automatic,
    refetchOnReconnect: automatic,
    refetchInterval: automatic ? 5 * 60_000 : false,
    retry: false,
  });
}

function useUpdatesMutation<T, R extends UpdatesResponse | null>(request: (input: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      if (data) client.setQueryData(updatesKey, data);
    },
    onError: (error) => noteSignedOut(client, error),
  });
}

/** Asks the updater to check now (up to 35 s). */
export const useCheckUpdates = () => useUpdatesMutation(() => call("POST", "/updates/check", {}));

/**
 * Starts an installation: success when `reachable` and no `error` (HTTP 202);
 * null: accepted (202), but the answer could not be read.
 */
export const useInstallUpdate = () =>
  useUpdatesMutation((version: string) => send("POST", "/updates/install", { version }));

export const useSetUpdateChannel = () =>
  useUpdatesMutation((channel: UpdateChannel) => call("POST", "/updates/channel", { channel }));
