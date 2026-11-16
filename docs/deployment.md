# Deployment

For the person who runs the helpdesk on a server: requirements, a setup
with Docker Compose, sign-in, upgrades, backups, Sentry and troubleshooting.
Every environment variable is described in [Configuration](configuration.md);
the form, categories, email and Slack are set up afterwards in the app
([Admin guide](admin-guide.md)).

## Requirements

- **PostgreSQL 16 or later.**
- **Docker with Docker Compose.** Without Docker you need Node.js 26.
- **A reverse proxy that terminates HTTPS.**
- **An OpenID Connect provider** for sign-in whose groups decide the roles:
  Keycloak, or any provider that puts groups into the sign-in
  ([Identity and access](identity-and-access.md)).
- **Disk space for uploaded files** (a volume; up to 10 MB per file).
- Outgoing connections to your mail server or MailerSend, and to Slack.

## Setup with Docker Compose

Each [release](https://github.com/meldgrove/helpdesk/releases) publishes the
image `ghcr.io/meldgrove/helpdesk` for linux/amd64 and linux/arm64, tagged
with its version (`0.1.0`), its series (`0.1`; from 1.0.0 the major version,
`1`) and `latest`. A release that needs manual steps starts a new series, so
the releases within a series install without anyone acting.

| File                    | Contains                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `worker`, `migrate`) picks the role.         |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`), the `worker` and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.       |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`HELPDESK_PORT` changes the host port. Uploaded files are stored in the
volume `attachments` (`/data/attachments` in the container).

1. **Get the files:** clone the repository and check out the release, e.g.
   `git checkout v0.1.0`. Platforms that read `compose.yaml` from the
   repository follow the branch `stable`, which is at the newest release.
2. **Create `.env`** next to `compose.yaml` from `.env.example` and set
   production values: `HELPDESK_VERSION`, `APP_URL`, `DATABASE_URL`, new
   secrets (`openssl rand -base64 32` for `AUTH_SECRET` and
   `ENCRYPTION_KEY`), the `OIDC_*` values, `DIRECTORY` and the groups
   ([Identity and access](identity-and-access.md)), and your address in
   `SUPERADMIN_EMAILS`. Remove `NODE_ENV=development` and `RUN_MIGRATIONS`.
3. **Start:** `docker compose up -d` (with `-f compose.yaml -f
compose.postgres.yaml` and `POSTGRES_PASSWORD` for the bundled database).
4. **Point the reverse proxy** at `127.0.0.1:3000`, open `APP_URL` and sign
   in.
5. **Continue in the app** ([Admin guide](admin-guide.md)): set up email and
   Slack, then the categories and the form.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process. Mount a volume at `/data/attachments`.

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Change `HELPDESK_VERSION` (or let the updater do it, below) and run
   `docker compose up -d`. The `migrate` service applies database migrations
   before `web` and `worker` start.

### Automatic updates

The optional `updater` service redeploys when the tag in `HELPDESK_VERSION`
points to a new image. It needs the platform's deploy link in
`UPDATE_DEPLOY_HOOK_URL` (and `UPDATE_DEPLOY_HOOK_TOKEN` when the link needs
a bearer token); without it, it does nothing. Use a series tag such as `0.1`
to get every release that installs without steps. `UPDATE_COOLDOWN` (default
`3d`) lets a release settle before it installs; `UPDATE_WINDOW` (e.g.
`02:00-05:00`, time zone `TZ`) limits when. See
[meldgrove/updater](https://github.com/meldgrove/updater).

## Backups

Back up together:

- the PostgreSQL database (`pg_dump`, or the `postgres` volume),
- the `attachments` volume (uploaded files; the database refers to them),
- `ENCRYPTION_KEY`, kept separately. Without it the database still works,
  but the stored SMTP password and the MailerSend and Slack tokens must be
  entered again.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `helpdesk@<version>`, so
reports link to the code; release images come with their source maps
uploaded.

- **Errors:** crashes, failed requests and errors the server logs, from the
  server and from browsers.
- **Performance:** set `SENTRY_TRACES_SAMPLE_RATE` (e.g. `0.2`) to trace
  that share of requests and page loads: server routes, database queries,
  calls to Slack and the mail service, and the page loads and navigations
  that started them.
- **Logs:** warnings and errors of the server.
- **Cron monitors:** the scheduled jobs check in (`helpdesk-directory-sync`,
  `helpdesk-prune-uploads`, `helpdesk-prune-notifications`), so Sentry
  raises an alert when one stops running or keeps failing. Sentry creates
  the monitors at the first check-in.

Reports never contain ticket texts, answers, names, email addresses,
request data or variables; error messages are left out because database
errors can quote values. There are no session replays.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
worker`). Logs carry identifiers (ticket, notification, error codes), never
ticket texts or email addresses. Useful lines: `directory synced`, `access
checked at sign-in` (with the role), `notification handled` and
`notification not sent` (with the channel and the provider's error code).

The superadmins' **Email & Slack** page lists recent deliveries with their
state and last error.

## Hardening

- Serve the app over HTTPS only.
- Use your organization's own identity provider, where people cannot choose
  their email address or groups themselves.
- Keep `SUPERADMIN_EMAILS` to one or two people: they always have full
  access, whatever their groups.
- Uploaded files are always downloaded, never shown in the browser, and
  only file types on an allow list are accepted.
