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

/**
 * The operator command (`cli settings …`) on the server. Only the command
 * creates it (cli/operator.ts); no HTTP request resolves to it. It may change
 * what superadmins change under Integrations.
 */
export type OperatorPrincipal = {
  kind: "operator";
  /** The command without its options, e.g. `cli settings apply email`, for the audit log. */
  command: string;
};

/** Who changes something: a signed-in person or the operator command. */
export type Actor = UserPrincipal | OperatorPrincipal;
