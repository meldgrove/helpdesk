# Architecture

How the helpdesk works inside, for contributors. `AGENTS.md` has the code
rules.

## Processes

One Docker image, one Node.js entry point (`apps/server/src/main.ts`);
`APP_ROLE` picks what runs:

- **web**: the Hono server: the JSON API under `/api/v1`, sign-in under
  `/api/auth` (Better Auth), health checks under `/-/`, and the built web
  app. It also removes unused uploads every hour.
- **worker**: sends queued emails and Slack messages (woken by PostgreSQL
  `NOTIFY`, at least every 5 seconds), syncs roles from Keycloak
  (`DIRECTORY=keycloak`), asks Meldgrove IAM about identity requests every
  5 minutes and removes old notifications.
- **migrate**: applies the Drizzle migrations under an advisory lock and
  creates the default form and category.
- **all**: web and worker in one process.

`node --import dist/instrument.mjs` starts Sentry before the app loads, so
HTTP, Hono, database and outgoing calls can be traced.

## Data

PostgreSQL holds everything except uploaded files, which live in
`ATTACHMENTS_DIR` under generated names.

- `users` (+ Better Auth's `sessions`, `accounts`, `verifications`):
  everyone the sign-in or the directory sync knows, with their `role`
  (null: no access), where it came from, and how they want to be notified.
- `form_versions`: every published version of the form (JSON, with its
  language). The highest version is the form; tickets point to the version
  they were sent with.
- `categories`: the category question's answers, with a default assignee.
- `tickets`: number (identity), title, status, urgency, category,
  requester, assignee, due date, board rank, revision, and the answers as
  asked (`StoredAnswer[]`, labels included).
- `ticket_messages` (public replies and internal notes), `ticket_events`
  (activity, ordered by `seq`), `attachments`.
- `notifications`: the outbox of emails and Slack messages.
- `settings`: email, Slack and IAM settings (secrets encrypted with
  `ENCRYPTION_KEY`), the last directory sync.
- `identity_requests`: requests to Meldgrove IAM sent from a ticket, with
  what IAM last said.
- `audit_log`: changes by admins and superadmins.

## The form

`packages/shared/src/form.ts` holds the model and its rules, used by the web
app (page by page) and the server (the whole submission):

- `visibleForm(definition, answers)`: the shown pages and questions, in one
  pass; conditions may only look back, and a hidden question counts as
  unanswered.
- `validateAnswers`: checks the shown questions only and drops everything
  else, so hidden questions are never required or stored.
- `definitionProblems`: what keeps a definition from being published (system
  questions on page 1, rules referring to earlier questions, choices).

## Tickets

`apps/server/src/tickets/service.ts` makes every change in one transaction:
it locks the ticket, checks the revision the person saw (`409
ticket_changed`), writes the change and its `ticket_events`, and queues the
notifications (`notifications/enqueue.ts`, `Outbox`). Creating a ticket uses
a submission key, so a repeated send creates one ticket. Board moves
renumber the target column's ranks without touching the revision (a layout
change).

## Identity requests

`identity/iam.ts` calls IAM's API for other apps
(`<url>/api/integration/v1/identity-requests`, IAM's `docs/api.md`) with
the stored API key. `identity/service.ts` sends a request from a ticket
(the dialog's submission key is the row's id and IAM's `externalId`,
`helpdesk:<id>`, so a resend makes no second request), records
`identity_requested` and `identity_request_changed` ticket events, and
`syncIdentityRequests` (worker) asks IAM about requests that are open or
approved without ready accounts. Each answer is saved under the row's lock,
so two workers add no event twice.

## Notifications

`Outbox.flush` writes the rows (leaving out channels that are not set up)
and calls `pg_notify`. The worker claims due rows with `FOR UPDATE SKIP
LOCKED` and a lease, sends them through `notifications/transports.ts` (SMTP
with nodemailer, MailerSend's API, Slack's Web API), and retries temporary
failures with backoff (5 attempts); permanent ones (a bad token, a rejected
address) fail at once. A Slack direct message finds the person by email and
falls back to an email.

## Database restarts

The Meldgrove Updater restarts PostgreSQL during updates. The worker (sending,
directory sync, removing old notifications) and the web process's removal of
unused uploads then log a warning and try again after 5, 10, 20, then every
30 seconds (`db/outage.ts`); a scheduled job tries for up to 5 minutes, then
waits for its next run. A notification claimed when the connection dropped
keeps its lease and is sent again when the lease ends (2 minutes). A database
unreachable for more than 5 minutes is an error in Sentry, once per outage.
Other errors are reported as before.

## Sign-in and roles

Better Auth runs the OpenID Connect flow (generic OAuth, PKCE). Before a
session starts, the directory module (`directory/index.ts`) decides the role:
from the Keycloak Admin API (`DIRECTORY=keycloak`) or from the groups claim of
the verified ID token or the userinfo response (`DIRECTORY=oidc`), with
`SUPERADMIN_EMAILS` first. No role, no session. With Keycloak, it also syncs
everyone in the groups every 15 minutes. Only this module reads `DIRECTORY`.
`auth/resolve.ts` turns a session into the request's principal and checks the
role on every request.

## Web app

`apps/web/src/modules/<area>` holds each area's routes, pages, queries and
texts (`requests`, `board`, `tickets`, `form-editor`, `people`,
`integrations`, `audit`, `updates`, `profile`). `routes/app.tsx` loads the signed-in
person and gates pages by role (`requireRole`); the server checks access
again on every request.

## Updates

The `updater` service of `compose.yaml` (the Meldgrove Updater) finds and
installs new versions. `modules/updates.ts` passes the superadmins' requests
to its API at `UPDATER_URL` (`updates/client.ts`, with timeouts) and answers
with its status. The update button and the Updates page come from the
shared package `@meldgrove/ui`: `modules/updates/updates.tsx` gives
superadmins its `UpdatesProvider`, which the header button and
`/admin/updates` share. It derives what to show from that status and follows
an installation through the restart.

## Sentry

Errors, warnings and errors as logs, traces (with
`SENTRY_TRACES_SAMPLE_RATE`) and cron check-ins. `redactErrorReport` and
`redactLog` in `packages/shared/src/error-reports.ts` keep only code
locations, error types, ids and codes: no personal data, request data or
error messages. Release builds upload source maps found by debug IDs
(`scripts/inject-debug-ids.mjs`).
