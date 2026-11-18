# Deployment

For the person who runs the helpdesk on a server: requirements, the setup
on [Coolify](#coolify) or on a [Debian server](#debian), sign-in, upgrades,
automatic updates, backups, Sentry and troubleshooting. Every environment
variable is described in [Configuration](configuration.md); the form,
categories, email and Slack are set up afterwards in the app
([Admin guide](admin-guide.md)).

## Requirements

- **Coolify, or a server with Debian 12 or later** (or a similar system with
  systemd and apt, such as Ubuntu 24.04), with Docker Engine and its Compose
  plugin.
- **PostgreSQL 16 or later.**
- **A reverse proxy that terminates HTTPS**: Coolify's own, or Caddy on
  Debian.
- **An OpenID Connect provider** for sign-in whose groups decide the roles:
  Keycloak, or any provider that puts groups into the sign-in
  ([Identity and access](identity-and-access.md)).
- **Disk space for uploaded files** (a volume; up to 10 MB per file).
- Outgoing connections to your mail server or MailerSend, and to Slack.

## What runs

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
volume `attachments` (`/data/attachments` in the container). The branch
`stable` is at the newest release; `main` has changes that are not released
yet.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process. Mount a volume at `/data/attachments`.

## Coolify

1. **Database:** create a PostgreSQL resource (16 or later) and copy its
   internal URL.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/helpdesk`, branch `stable`,
   Docker Compose location `/compose.yaml`. Under Advanced, set Auto deploy
   to "Manual deployments only", so that only releases deploy, and turn on
   "Connect To Predefined Network", so that the app reaches the database.
3. **Domain:** assign the domain, such as `https://helpdesk.example.org`, to
   `web`, port 3000.
4. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
5. **Environment variables** of the resource: `HELPDESK_VERSION` (a series
   such as `0.1`, see [Automatic updates](#automatic-updates)), `APP_URL`
   (the domain), `DATABASE_URL` (the database's internal URL), new secrets
   (`openssl rand -base64 32` for `AUTH_SECRET` and `ENCRYPTION_KEY`), the
   `OIDC_*` values, `DIRECTORY` and the groups
   ([Identity and access](identity-and-access.md)), and your address in
   `SUPERADMIN_EMAILS`.
6. **Deploy**, open `APP_URL` and sign in.
7. **Continue in the app** ([Admin guide](admin-guide.md)): set up email and
   Slack, then the categories and the form.
8. **Automatic updates:** set them up [on Coolify](#on-coolify).

## Debian

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/helpdesk.git /srv/helpdesk
   cd /srv/helpdesk
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `HELPDESK_VERSION` (a
   series such as `0.1`), `APP_URL`, `DATABASE_URL`, new secrets
   (`openssl rand -base64 32` for `AUTH_SECRET` and `ENCRYPTION_KEY`), the
   `OIDC_*` values, `DIRECTORY` and the groups
   ([Identity and access](identity-and-access.md)), and your address in
   `SUPERADMIN_EMAILS`. Remove `NODE_ENV=development` and `RUN_MIGRATIONS`.
   Without a database of your own, add
   `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a `POSTGRES_PASSWORD`
   (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://helpdesk:<POSTGRES_PASSWORD>@postgres:5432/helpdesk`.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and replace `/etc/caddy/Caddyfile` with:

   ```text
   helpdesk.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself. With
   `HELPDESK_PORT` set, use that port instead of 3000.

7. Open `APP_URL` and sign in.
8. **Continue in the app** ([Admin guide](admin-guide.md)): set up email and
   Slack, then the categories and the form.
9. **Automatic updates:** set them up [on Debian](#on-debian).

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then move to the new series:
   - **Coolify:** change `HELPDESK_VERSION` in the resource's environment
     variables and redeploy. Coolify reads `compose.yaml` from `stable`,
     which is at the newest release.
   - **Debian:** in `/srv/helpdesk`, run `git pull` (the newest release's
     `compose.yaml`), change `HELPDESK_VERSION` in `.env`, and run
     `docker compose up -d --pull always`.

The `migrate` service applies database migrations before `web` and `worker`
start.

## Automatic updates

The `updater` service installs new releases of the tag in
`HELPDESK_VERSION`: with a series such as `0.1`, every release that installs
without steps; with `latest`, every release, also those with upgrade steps.
A release installs once the updater has seen it for three days
(`UPDATE_COOLDOWN`: `0` installs within the hour, `7d` waits a week), and with `UPDATE_WINDOW` (such
as `02:00-05:00`, in the time zone `TZ`) only then. Set up
[backups](#backups) first: migrations run without anyone watching. Details:
[meldgrove/updater](https://github.com/meldgrove/updater).

### On Coolify

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In the Helpdesk resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

The `updater` log then names the tag it watches.

### On Debian

As root in `/srv/helpdesk`, with `UPDATE_DEPLOY_HOOK_URL` empty:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the image the tag points to now, which the updater
takes as installed. The second writes the setup script from the updater's
image; read it before you run it. The script installs a systemd unit that
waits for the updater's request, then pulls the new image and runs
`docker compose up -d`, migrations first. `docker compose logs updater` names
the tag it watches, and `journalctl -u meldgrove-updater-helpdesk.service`
shows each installation. `sh updater-setup.sh remove` switches it off.

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
