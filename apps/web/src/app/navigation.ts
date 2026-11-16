import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  Inbox,
  KanbanSquare,
  List,
  Plug,
  ScrollText,
  SquarePen,
  UsersRound,
} from "lucide-react";
import type { Role } from "@helpdesk/shared/roles";
import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    requests: "Requests",
    newRequest: "New request",
    myRequests: "My requests",
    work: "Tickets",
    board: "Board",
    tickets: "All tickets",
    admin: "Administration",
    form: "Request form",
    people: "People",
    integrations: "Email & Slack",
    audit: "Audit log",
  },
  de: {
    requests: "Anfragen",
    newRequest: "Neue Anfrage",
    myRequests: "Meine Anfragen",
    work: "Tickets",
    board: "Board",
    tickets: "Alle Tickets",
    admin: "Verwaltung",
    form: "Anfrageformular",
    people: "Personen",
    integrations: "E-Mail & Slack",
    audit: "Protokoll",
  },
});

export type NavKey = keyof typeof navMessages.en;
export type NavItem = { key: NavKey; to: string; icon: LucideIcon; role?: Role };
export type NavGroup = { key: NavKey; items: NavItem[]; role: Role };

/** The sidebar. Each group and item shows from its role up; the server checks access too. */
export const NAVIGATION: NavGroup[] = [
  {
    key: "work",
    role: "operator",
    items: [
      { key: "board", to: "/board", icon: KanbanSquare },
      { key: "tickets", to: "/tickets", icon: List },
    ],
  },
  {
    key: "requests",
    role: "requester",
    items: [
      { key: "newRequest", to: "/requests/new", icon: SquarePen },
      { key: "myRequests", to: "/requests", icon: Inbox },
    ],
  },
  {
    key: "admin",
    role: "admin",
    items: [
      { key: "form", to: "/admin/form", icon: ClipboardList },
      { key: "people", to: "/admin/people", icon: UsersRound },
      { key: "integrations", to: "/admin/integrations", icon: Plug, role: "superadmin" },
      { key: "audit", to: "/admin/audit", icon: ScrollText, role: "superadmin" },
    ],
  },
];
