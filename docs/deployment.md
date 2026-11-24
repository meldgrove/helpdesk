# Deployment

For the person who runs the helpdesk on a Linux server, such as a VPS with
Debian or Ubuntu: requirements, [setup](#setup),
[settings from the command line](#settings-from-the-command-line), sign-in,
upgrades, automatic updates, backups, Sentry and troubleshooting. To run it on Coolify
instead, see [Coolify](coolify.md). Every environment
variable is described in [Configuration](configuration.md); the form,
categories, email and Slack are set up afterwards in the app
([Admin guide](admin-guide.md)).

## Requirements

- **A server with Debian 12 or later** (or a similar system with systemd and
  apt, such as Ubuntu 24.04), with Docker Engine and its Compose plugin, and
  a domain name that points at it.
- **PostgreSQL 16 or later**: a database of your own, or the one
  `compose.postgres.yaml` adds.
- **Caddy** (or another reverse proxy on the server) that terminates HTTPS.
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
the releases within a series install without anyone acting. Every change on
`main` that passes CI is published as a preview: `0.1.1-preview.3` (three
changes after 0.1.0) and the tag `preview`.

| File                    | Contains                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `worker`, `migrate`, `cli`) picks the role.  |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`), the `worker` and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.       |
| `compose.coolify.yaml`  | The same as `compose.yaml`, for [Coolify](coolify.md).                             |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`HELPDESK_PORT` changes the host port. With several apps on one server, give
each its own port and its own site in the Caddyfile. Uploaded files are
stored in the
volume `attachments` (`/data/attachments` in the container). The branch
`stable` is at the newest release; `main` has changes that are not released
yet.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process. Mount a volume at `/data/attachments`.

## Setup

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
   `chmod 600 .env`) and set production values: `HELPDESK_VERSION` (the
   newest release, such as `0.1.0`), `APP_URL`, `DATABASE_URL`, new secrets
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
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   helpdesk.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself. With
   `HELPDESK_PORT` set, use that port instead of 3000.

7. Open `APP_URL` and sign in.
8. **Continue in the app** ([Admin guide](admin-guide.md)): set up email and
   Slack, then the categories and the form. Email, Slack and Meldgrove IAM
   can also be set on the server instead:
   [Settings from the command line](#settings-from-the-command-line).
9. **Automatic updates:** [set them up](#setup-on-the-server).

## Settings from the command line

What superadmins set under **Integrations** (email, Slack, Meldgrove IAM)
can also be set on the server, without a browser, with `cli settings`. It
runs the same code as the page: the same checks, the same encryption, and
an entry in the audit log with the actor `operator` and the command. In
`/srv/helpdesk`:

```sh
docker compose run --rm -T migrate cli settings list
```

In a running container, such as a terminal on Coolify, the command is just
`cli …` (`docker compose exec web cli settings list`).

| Command                                  | What it does                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `cli settings list [--json]`             | Each setting: `set`, `not set` or `incomplete`, with hints such as `password …a1b2`  |
| `cli settings show <name>`               | The setting as JSON, as the page reads it: secrets only as hints                     |
| `cli settings show slack --channels`     | The channels the Slack bot can see, with their IDs                                   |
| `cli settings apply <name>`              | Saves the JSON body on stdin, as the page's **Save** does; prints what `show` prints |
| `cli settings test <name>`               | What the page's test button does                                                     |
| `cli settings test email --to <address>` | Sends a test email to the address                                                    |
| `cli help`                               | The commands and the setting names                                                   |

- Secrets go only in the body on stdin, never in an argument (arguments show
  in `ps` and the shell history). Nothing prints a saved secret.
- `apply` replaces the whole setting, as the page does: start from what
  `show` prints. As on the page, an empty or missing secret keeps the saved
  one.
- Exit codes: `0` done; `1` refused, with the page's message and the field
  on stderr; `2` a wrong command or a body that is not JSON.
- The helpdesk has no lists of settings and issues no tokens, so there is no
  `cli settings remove` and no `cli tokens`.

The bodies, as the Integrations page sends them:

`email` over SMTP (`security`: `tls` on port 465, `starttls` on 587, or
`none`). `{"provider": "none"}` turns email off.

```json
{
  "provider": "smtp",
  "fromAddress": "helpdesk@example.org",
  "fromName": "Helpdesk",
  "smtp": {
    "host": "mail.example.org",
    "port": 587,
    "security": "starttls",
    "username": "helpdesk@example.org",
    "password": "<password>"
  }
}
```

`email` over MailerSend:

```json
{
  "provider": "mailersend",
  "fromAddress": "helpdesk@example.org",
  "fromName": "Helpdesk",
  "mailersend": { "token": "<API token>" }
}
```

`slack`: the bot token (`xoxb-…`) and the channel for new tickets, an ID
from `cli settings show slack --channels`. `"botToken": ""` keeps the saved
token; `"botToken": null` disconnects Slack.

```json
{ "botToken": "<bot token>", "channelId": "C0123456789" }
```

`iam`: IAM's address, the API key (`iam_…`) and which question of the form
fills which field of a request (question IDs; `cli settings show iam` shows
the current ones, and the fields left out stay empty). `"apiKey": null`
removes the key.

```json
{
  "url": "https://iam.example.org",
  "apiKey": "<API key>",
  "mapping": { "firstName": "first_name", "lastName": "last_name", "personType": "person_type" }
}
```

Then test it: `cli settings test slack`, `cli settings test iam`, or
`cli settings test email --to you@example.org`.

An AI with access to the server sets a key this way: it receives the secret
as a file, pipes the body into `cli settings apply`, runs
`cli settings test` and deletes the file. With `jq`, the secret never
appears in an argument:

```sh
jq -n --rawfile token slack-token '{botToken: ($token | rtrimstr("\n")), channelId: "C0123456789"}' \
  | docker compose run --rm -T migrate cli settings apply slack
docker compose run --rm -T migrate cli settings test slack
rm slack-token
```

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds (at least
  every 30 seconds while PostgreSQL restarts); `compose.yaml` checks its age.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then move to the new series: in `/srv/helpdesk`, run
   `git pull` (the newest release's `compose.yaml`), then click
   **Install anyway…** at the update button, or change `HELPDESK_VERSION` in
   `.env` and run `docker compose up -d --pull always`.

The `migrate` service applies database migrations before `web` and `worker`
start.

## Automatic updates

The `updater` service ([meldgrove/updater](https://github.com/meldgrove/updater))
checks for new versions every hour, installs them once the
[host setup](#setup-on-the-server) runs, and tells superadmins in the app.
Set up [backups](#backups) first: migrations run without anyone
watching. There are two channels:

- **Stable** (default): releases. A release without upgrade steps (the same
  series) installs once it has been out for three days (`UPDATE_COOLDOWN`:
  `0` installs at the next check, `7d` waits a week). A release with upgrade
  steps (a new series) is shown in the app but never installs on its own.
- **Preview**: every change on `main` as soon as CI passed for it, before it
  is released, and every release; previews install within the hour. New
  features first, and now and then a new bug. Switching back to Stable
  installs nothing: the helpdesk keeps the preview until a release is newer.

With `UPDATE_WINDOW` (such as `02:00-05:00`, in the time zone `TZ`), updates
install automatically only then.

### Update button

Superadmins see an update icon in the header: a click checks for updates; a
dot means an update is available, with its changes, its release notes, when
it installs, and **Install now**. While it installs, the icon shows the
progress, and the page reloads when the helpdesk is back; when an update
fails, it shows why. With automatic updates off on the server, the icon
still shows new releases, but nothing installs from the app.
**Administration → Updates** shows the installed version and sets the
channel. The app reaches the updater at `UPDATER_URL`
(default `http://updater:8080`); without it, the icon says "No update
service". The updater's API has no authentication: never publish its port.

### Setup on the server

The server installs the exact version: it writes it into `HELPDESK_VERSION`
in `.env`, pulls the image, runs the migrations, starts the helpdesk and
waits until it is healthy. When it does not become healthy, the server goes
back to the version before, and the update button shows why. Superadmins
choose the channel in the app.

As root in `/srv/helpdesk`:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the version in `HELPDESK_VERSION`, which the
updater takes as installed. The second writes the setup script from the
updater's image; read it before you run it. The script installs a systemd
unit that waits for the updater's request and installs the version.
`docker compose logs updater` shows the checks, and
`journalctl -u meldgrove-updater-helpdesk.service` shows each installation.
`sh updater-setup.sh remove` switches it off. The server installs images,
not files: a release that changes `compose.yaml` needs a `git pull` (its
upgrade steps say so).

**Servers set up before the update button** (with updater 0.1 or an
earlier release) get it, and the channel, this way: set `HELPDESK_VERSION`
in `.env` to the release that brings the update button, or a newer one,
then:

```sh
cd /srv/helpdesk
git pull
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh && sudo sh updater-setup.sh
```

The third command starts that release, so the helpdesk itself, not just
the updater, runs a version with the button before the host setup runs
again.

## Backups

### With Meldgrove Backups

The `backup-agent` service in `compose.yaml` sends the database and the
`attachments` volume to
[Meldgrove Backups](https://github.com/meldgrove/backups) when Backups asks.
While `BACKUP_URL` is empty, it idles.

1. In Backups, add a source of the kind **Meldgrove app**, and put the two
   lines it shows (`BACKUP_URL`, `BACKUP_TOKEN`) into `.env`.
2. Run `docker compose up -d`, then check the agent:
   `docker compose exec backup-agent backup-agent check`.
3. Let the backup end before the update window (`UPDATE_WINDOW`): automatic
   updates run migrations without anyone present.

Keep `ENCRYPTION_KEY` apart from the backups: a restore needs it, the backups
do not hold it, and Backups shows the name on the source page.

With [automatic updates](#automatic-updates), run the updater's host setup
again once the app's folder has updater 0.2.2 or later (`git pull`): its
deploy script then pulls the agent's image with each update. Without it:
`docker compose pull backup-agent && docker compose up -d`.

To restore, follow the
[agent's guide](https://github.com/meldgrove/backup-agent#restore).

### By hand

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

The superadmins' **Integrations** page lists recent deliveries with their
state and last error.

## Hardening

- Serve the app over HTTPS only.
- Use your organization's own identity provider, where people cannot choose
  their email address or groups themselves.
- Keep `SUPERADMIN_EMAILS` to one or two people: they always have full
  access, whatever their groups.
- Uploaded files are always downloaded, never shown in the browser, and
  only file types on an allow list are accepted.
