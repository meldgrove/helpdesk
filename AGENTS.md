# AGENTS.md

Meldgrove Helpdesk is a self-hosted helpdesk for internal requests:
requesters send one dynamic form (pages and questions with show-if rules),
staff work every ticket on one board, and email and Slack tell people what
happened. User documentation is in `docs/`; contributor setup is in
`CONTRIBUTING.md`; how it works inside is in `docs/architecture.md`.

## Stack

npm workspaces, Node.js 26, strict TypeScript.

- `apps/server`: Hono (API under `/api/v1`), Better Auth (OIDC sign-in under
  `/api/auth`), Drizzle ORM on PostgreSQL, nodemailer, pino logs, Sentry,
  Vitest.
- `apps/web`: Vite + React 19, TanStack Router and Query, Tailwind CSS 4
  with `@meldgrove/ui` (the shared Meldgrove theme, shadcn/ui components and
  update button), dnd-kit (board), react-hook-form with zod. English (US); the
  request form also in German.
- `packages/shared` (`@helpdesk/shared/*`): zod schemas of the API
  (`api/*.ts`), roles, ticket constants, the form model and its show-if and
  answer rules (`form.ts`, used by both apps), error report redaction.

One Docker image runs every process: `APP_ROLE` = `all | web | worker | migrate`.

## Layout

```
apps/server/src/
  main.ts          entry; APP_ROLE selects the processes
  instrument.ts    starts Sentry before the app loads (node --import)
  config.ts        every environment variable (zod); read only via config()
  db/schema/       Drizzle schema (auth.ts, app.ts); db/client.ts, db/migrate.ts
  auth/            Better Auth, session → principal
  directory/       roles from groups (index.ts): Keycloak Admin API or groups claim, SUPERADMIN_EMAILS
  tickets/         ticket writes (service.ts), reads (queries.ts), stored answers
  notifications/   outbox (enqueue.ts), templates, transports, delivery
  attachments/     file storage on disk
  worker/          delivery loop and scheduled jobs
  updates/         client for the Meldgrove Updater's API (in-app updates)
  http/            app factory, middleware (requireUser/requireStaff/requireAdmin/requireSuperadmin), errors
  modules/         one file per API area: routes
apps/web/src/      web app; modules/<area> holds each area's pages
packages/shared/src/  contracts, roles, tickets, form
```

## Rules

- **Contracts first.** Change a request or response in
  `packages/shared/src/api/` and use it on both sides; routes validate input
  with it (`jsonBody`, `queryOf`).
- **Access:** every route calls `requireUser`, `requireStaff`,
  `requireAdmin` or `requireSuperadmin` first. Requesters only ever see their
  own tickets, never internal notes or their files. Roles come from groups
  only; the app never edits them.
- **The form's rules live in `packages/shared/src/form.ts`.** The browser
  and the server use the same visibility and answer checks; hidden
  questions are never required and their answers are never stored.
- **Ticket changes** go through `tickets/service.ts`: it records events,
  checks the revision (`409 ticket_changed`), and queues notifications in
  the same transaction (`Outbox`). The worker sends them.
- **Secrets** (SMTP password, MailerSend and Slack tokens) are stored with
  `encryptSecret` and never returned or logged; responses show hints.
- **UI components** come from `@meldgrove/ui` (`@meldgrove/ui/<name>`, `cn`
  from `@meldgrove/ui/utils`); the app keeps no copies. A missing component or
  a fix goes into that package.
- **Errors:** throw `AppError` helpers (`http/errors.ts`) with short, plain
  messages.
- **Logging:** `logger` with ids and codes; never ticket texts, answers,
  email addresses, tokens or other personal data. No `console.*`, no `any`.
- **Sentry** gets no personal data: `redactErrorReport` and `redactLog`
  decide what reports and logs keep; no session replays.

## Database

Change the schema in `apps/server/src/db/schema/`, then run
`npm run db:generate` and commit the migration. CI fails when they differ.

## Tests

- Unit tests next to the code (`*.test.ts`); integration tests
  (`*.int.test.ts`) use the PostgreSQL of `compose.dev.yaml` and
  `src/test/helpers.ts` (`resetDatabase`, `createUser`, `request`).
- API tests sign in with `vi.mock("../auth/resolve", () => import("../test/resolve-mock"))`.
- Email and Slack in tests: stub `fetch` (MailerSend and Slack use
  `MAILERSEND_API_URL` / `SLACK_API_URL`); SMTP against Mailpit. Never call
  real services in tests.
- End-to-end tests (`e2e/`) run a real browser against the built app,
  Keycloak and Mailpit.

## Commands

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL (55448), Keycloak (8102), Mailpit (8028)
cp .env.example .env.local
npm ci
npm run dev                                # web app http://localhost:5173, server :3000

npm run lint && npm run format:check && npm run typecheck && npm test
npm run test:integration
npm run build && npm run test:e2e
```

Releases: Actions → Release → Run workflow (shared Meldgrove workflow; see
`CONTRIBUTING.md`). No file holds the version.

## Content

UI text, emails and Slack messages are in US English; short and plain. Only
texts the request form shows have German too (`de`, with "du"), because admins
choose each form's language. Never commit secrets, real personal data or data from a real
organization: use `example.org` addresses.
