import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateChannel, UpdatesResponse } from "@helpdesk/shared/api/updates";
import { api, ApiError } from "@/lib/api";

export const updatesKey = ["updates"] as const;

function isUpdatesResponse(value: unknown): value is UpdatesResponse {
  return typeof value === "object" && value !== null && "reachable" in value && "app" in value;
}

/**
 * A call to the updates routes. An updater that refused (409) still answers
 * with the latest status and `error`, so that resolves too; check `error`.
 */
async function call(request: () => Promise<UpdatesResponse>): Promise<UpdatesResponse> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && isUpdatesResponse(error.body)) return error.body;
    throw error;
  }
}

export const fetchUpdates = (signal?: AbortSignal) =>
  call(() => api.get<UpdatesResponse>("/updates", undefined, signal));

/**
 * The updater's status for superadmins: on page load, every 5 minutes and
 * when the window regains focus (at most once a minute). Never checks by
 * itself. `polling: false` while the button polls an installation.
 */
export function useUpdates(options: { enabled?: boolean; polling?: boolean } = {}) {
  return useQuery({
    queryKey: updatesKey,
    queryFn: ({ signal }) => fetchUpdates(signal),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: options.polling === false ? false : 5 * 60_000,
    retry: false,
  });
}

function useUpdatesMutation<T>(request: (input: T) => Promise<UpdatesResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => call(() => request(input)),
    onSuccess: (data) => client.setQueryData(updatesKey, data),
  });
}

/** Asks the updater to check now (up to 35 s). */
export const useCheckUpdates = () =>
  useUpdatesMutation<void>(() => api.post<UpdatesResponse>("/updates/check"));

/** Starts an installation: success when `reachable` and no `error` (HTTP 202). */
export const useInstallUpdate = () =>
  useUpdatesMutation<string>((version) => api.post<UpdatesResponse>("/updates/install", { version }));

export const useSetUpdateChannel = () =>
  useUpdatesMutation<UpdateChannel>((channel) => api.post<UpdatesResponse>("/updates/channel", { channel }));
