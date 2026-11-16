import type { Role } from "@helpdesk/shared/roles";
import type { Status, Urgency } from "@helpdesk/shared/tickets";
import { defineMessages, useT } from "@/i18n";

/** Words for the app's fixed values: statuses, urgencies, roles. */
export const labelMessages = defineMessages({
  en: {
    new: "New",
    in_progress: "In progress",
    waiting_for_requester: "Waiting for requester",
    waiting_for_others: "Waiting for others",
    done: "Done",
    cancelled: "Cancelled",
    low: "Low",
    normal: "Normal",
    urgent: "Urgent",
    very_urgent: "Very urgent",
    requester: "Requester",
    operator: "Operator",
    admin: "Admin",
    superadmin: "Superadmin",
    noRole: "No access",
  },
  de: {
    new: "Neu",
    in_progress: "In Arbeit",
    waiting_for_requester: "Wartet auf anfragende Person",
    waiting_for_others: "Wartet auf andere",
    done: "Erledigt",
    cancelled: "Abgebrochen",
    low: "Niedrig",
    normal: "Normal",
    urgent: "Dringend",
    very_urgent: "Sehr dringend",
    requester: "Anfragende Person",
    operator: "Bearbeitung",
    admin: "Admin",
    superadmin: "Superadmin",
    noRole: "Kein Zugang",
  },
});

export function useStatusLabel() {
  const t = useT(labelMessages);
  return (status: Status) => t(status);
}

export function useUrgencyLabel() {
  const t = useT(labelMessages);
  return (urgency: Urgency) => t(urgency);
}

export function useRoleLabel() {
  const t = useT(labelMessages);
  return (role: Role | null) => (role ? t(role) : t("noRole"));
}
