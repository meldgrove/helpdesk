/*
 * The operator command, `cli` in the image (docs/deployment.md, "Settings
 * from the command line"): `cli settings …` sets what superadmins set under
 * Admin › Integrations, with the same functions. Stdout carries only the
 * command's output; logs go to stderr. It starts no web server and no
 * worker, closes the database pool and exits. It loads without
 * instrument.ts, so it reports nothing to Sentry.
 */
import { logToStderr } from "./log-target";

logToStderr();
// Loaded only now: the logger reads the target when it loads.
const { runCli } = await import("./cli/main");
const { processIo } = await import("./cli/io");
const { closeDb } = await import("./db/client");

const code = await runCli(process.argv.slice(2), processIo());
await closeDb().catch(() => undefined);
process.exit(code);
