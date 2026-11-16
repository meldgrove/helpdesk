import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Board, TicketMove, TicketSummary } from "@helpdesk/shared/api/tickets";
import type { Status } from "@helpdesk/shared/tickets";
import { useT } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { isStale, REFRESH_MS, ticketKeys } from "@/modules/tickets/api";
import type { TicketFilters } from "@/modules/tickets/filters";
import { findTicket, withRevision } from "./board-state";
import { messages } from "./messages";

export const boardQuery = (filters: TicketFilters) => ({
  queryKey: [...ticketKeys.boards, filters] as const,
  queryFn: () => api.get<Board>("/board", filters),
  refetchInterval: REFRESH_MS,
  refetchOnWindowFocus: true,
});

/** A move on the board: the board as it looks after the move, and the target column's order. */
export type MoveInput = { ticket: TicketSummary; status: Status; board: Board; order: string[] };

const MOVE_KEY = ["board-move"] as const;

/**
 * Moves a ticket: the cached board changes at once; the server gets the
 * ticket's newest revision, the target status and the column's order. Moves
 * run one after another, so quick moves of the same ticket don't refuse each
 * other. A refused move shows a toast and loads the board again.
 */
export function useMoveTicket(key: QueryKey) {
  const t = useT(messages);
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MOVE_KEY,
    scope: { id: "board-move" },
    mutationFn: ({ ticket, status, order }: MoveInput) => {
      const latest = findTicket(queryClient.getQueryData<Board>(key), ticket.id)?.revision ?? 0;
      const body: TicketMove = { revision: Math.max(latest, ticket.revision), status, order };
      return api.post<{ revision: number }>(`/tickets/${ticket.number}/move`, body);
    },
    onMutate: async ({ board }) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<Board>(key, board);
    },
    onSuccess: ({ revision }, { ticket }) => {
      queryClient.setQueryData<Board>(key, (board) =>
        board ? withRevision(board, ticket.id, revision) : board,
      );
      void queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticket.number) });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.lists });
    },
    onError: (error, { ticket }) => {
      toast.error(
        isStale(error)
          ? t("moveStale", { number: ticket.number })
          : t("moveFailed", { number: ticket.number, message: errorMessage(error) }),
      );
    },
    onSettled: () => {
      // The last of quick moves loads the board: the server's order and counts win.
      if (queryClient.isMutating({ mutationKey: MOVE_KEY }) <= 1) {
        void queryClient.invalidateQueries({ queryKey: ticketKeys.boards });
      }
    },
  });
}
