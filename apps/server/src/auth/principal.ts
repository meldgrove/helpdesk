import type { NotifyChannel, Role } from "@helpdesk/shared/roles";

/** The signed-in person of a request (someone with access: a role). */
export type UserPrincipal = {
  kind: "user";
  id: string;
  email: string;
  name: string;
  role: Role;
  image: string | null;
  notifyVia: NotifyChannel;
};
