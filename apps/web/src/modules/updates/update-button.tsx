import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Update, UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useAuthConfig } from "@/lib/auth-config";
import { useFormatter } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fetchUpdates, updatesKey, useCheckUpdates, useInstallUpdate, useUpdates } from "./api";
import { messages } from "./messages";
import { DEPLOYMENT_GUIDE_URL } from "./updates-page";
import {
  adoptInstall,
  afterInstallAnswer,
  buttonState,
  freshLast,
  hasPopover,
  installAction,
  installDidNotStart,
  installOutcome,
  isOutage,
  isSignedOut,
  newAttempt,
  readPendingInstall,
  trackInstall,
  visibleNotes,
  writePendingInstall,
  type ButtonState,
  type InstallAnswer,
  type InstallFailure,
  type PendingInstall,
} from "./state";

const POLL_MS = 2_000;
const RELOAD_MS = 1_500;

type Translate = ReturnType<typeof useT<typeof messages.en>>;
type Action = ReturnType<typeof installAction>;

const installKey = (version: string, startedAt: string | number) => `${version}@${startedAt}`;

/**
 * Follows an installation, one this page asked for or one a status reported:
 * polls every 2 s, takes failed polls as the restart, and ends with a toast
 * and a reload, or the failure. `onFailed` must be stable.
 */
function useInstallWatch(onFailed: () => void) {
  const client = useQueryClient();
  const t = useT(messages);
  const [pending, setPendingState] = useState<PendingInstall | null>(readPendingInstall);
  const [failure, setFailure] = useState<InstallFailure | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pendingRef = useRef(pending);
  /** Done: the page reloads, and later answers change nothing. */
  const doneRef = useRef(false);
  /** The installation an admin stopped waiting for; not taken over again. */
  const ignoredRef = useRef<string | null>(null);

  const setPending = useCallback((value: PendingInstall | null) => {
    pendingRef.current = value;
    writePendingInstall(value);
    setPendingState(value);
    if (value) setFailure(null);
  }, []);

  const key = pending ? installKey(pending.version, pending.startedAt) : null;
  useEffect(() => {
    if (!key) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let data: UpdatesResponse | undefined;
      try {
        data = await fetchUpdates();
      } catch (error) {
        if (stopped) return;
        // Signed out: stop polling and keep the attempt for a later page load.
        if (isSignedOut(error)) {
          setRestarting(false);
          return;
        }
        const followed = pendingRef.current;
        if (isOutage(error) && followed && !followed.outage) {
          pendingRef.current = { ...followed, outage: true };
          writePendingInstall(pendingRef.current);
        }
        setRestarting(isOutage(error));
      }
      if (stopped) return;
      const at = Date.now();
      setNow(at);
      const current = pendingRef.current;
      if (data && current) {
        client.setQueryData(updatesKey, data);
        // No updater while the app restarts is expected, too.
        setRestarting(!data.reachable);
        const tracked = trackInstall(current, data, at);
        if (tracked !== current) {
          setPending(tracked);
          // Another installation: the effect starts again for it.
          if (installKey(tracked.version, tracked.startedAt) !== key) return;
        }
        const outcome = installOutcome(tracked, data);
        if (outcome === "done") {
          doneRef.current = true;
          writePendingInstall(null);
          toast.success(t("updated", { version: tracked.version }));
          timer = setTimeout(() => window.location.reload(), RELOAD_MS);
          return;
        }
        if (outcome === "failed") {
          const last = freshLast(tracked, data)!;
          setPending(null);
          setFailure({ version: tracked.version, message: last.message, finishedAt: last.finishedAt });
          onFailed();
          return;
        }
        if (installDidNotStart(tracked, at)) {
          setPending(null);
          toast.error(tracked.reason ? t("notStartedReason", { reason: tracked.reason }) : t("notStarted"));
          return;
        }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, client, t, onFailed, setPending]);

  /** Remembers an attempt before its install request, so a restart that comes first finds it. */
  const begin = useCallback(
    (version: string, fromVersion: string | null) => {
      const attempt = newAttempt(version, fromVersion, Date.now());
      doneRef.current = false;
      setPending(attempt);
      return attempt;
    },
    [setPending],
  );

  /** Applies the install request's answer, unless the attempt ended meanwhile; returns the error to show. */
  const settle = useCallback(
    (attempt: PendingInstall, answer: InstallAnswer): string | null => {
      const current = pendingRef.current;
      if (
        doneRef.current ||
        !current ||
        installKey(current.version, current.startedAt) !== installKey(attempt.version, attempt.startedAt)
      ) {
        return null;
      }
      const next = afterInstallAnswer(current, answer, Date.now());
      if (next.pending !== current) setPending(next.pending);
      return next.error;
    },
    [setPending],
  );

  /** Follows an installation a status reports, while this page follows none. */
  const adopt = useCallback(
    (data: UpdatesResponse) => {
      if (pendingRef.current || doneRef.current) return;
      const next = adoptInstall(data, Date.now());
      if (next && installKey(next.version, next.serverStartedAt ?? "") !== ignoredRef.current)
        setPending(next);
    },
    [setPending],
  );

  /** Stop waiting: forget the attempt and poll as usual again. */
  const stop = useCallback(() => {
    const installing = client.getQueryData<UpdatesResponse>(updatesKey)?.updater?.installing;
    ignoredRef.current = installing ? installKey(installing.version, installing.startedAt) : null;
    setRestarting(false);
    setPending(null);
  }, [client, setPending]);

  return { pending, failure, restarting, now, begin, settle, adopt, stop };
}

function tooltip(state: ButtonState, t: Translate): string {
  switch (state.kind) {
    case "checking":
      return t("checking");
    case "up-to-date":
      // After a failed check it is not known whether this is the newest version.
      if (state.error) return t("checkFailed", { error: state.error });
      return state.installed ? t("upToDateVersion", { version: state.installed }) : t("upToDate");
    case "available":
      return t("availableVersion", { version: state.update.version });
    case "attention":
      return t("needsSteps", { version: state.update.version });
    case "installing":
      return state.restarting ? t("restarting") : t("installing", { version: state.version });
    case "failed":
      return t("failedTitle", { version: state.version });
    case "off":
      return t("off");
    case "unreachable":
      return t("unreachable");
  }
}

function StateIcon({ state }: { state: ButtonState }) {
  const spin = "animate-spin motion-reduce:animate-none";
  switch (state.kind) {
    case "checking":
      return <RefreshCw className={spin} aria-hidden />;
    case "installing":
      return <LoaderCircle className={spin} aria-hidden />;
    case "available":
    case "attention":
      return (
        <>
          <Download aria-hidden />
          <span
            className={cn(
              "ring-background absolute top-1 right-1 size-2 rounded-full ring-2",
              state.kind === "available" ? "bg-primary" : "bg-warning",
            )}
            aria-hidden
          />
        </>
      );
    case "failed":
      return <TriangleAlert className="text-destructive" aria-hidden />;
    case "unreachable":
      return <RefreshCw className="text-muted-foreground opacity-60" aria-hidden />;
    default:
      return <RefreshCw className="text-muted-foreground" aria-hidden />;
  }
}

function ReleaseNotesLink({ url }: { url: string }) {
  const t = useT(messages);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary inline-flex w-fit items-center gap-1 text-sm underline-offset-4 hover:underline"
    >
      {t("releaseNotes")}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

function Title({ children }: { children: ReactNode }) {
  return <h2 className="font-medium break-words">{children}</h2>;
}

/**
 * In place of the install buttons: in mode off nothing can install from here;
 * a release with upgrade steps that the deployment's image tag does not reach
 * needs the tag changed there.
 */
function ActionNote({ action, version, appName }: { action: Action; version: string; appName: string }) {
  const t = useT(messages);
  if (action === "locked") {
    return (
      <p className="text-muted-foreground text-sm break-words">{t("tagLocked", { app: appName, version })}</p>
    );
  }
  if (action !== "off") return null;
  const [before, after] = t("offCannotInstall").split("{guide}");
  return (
    <p className="text-muted-foreground text-sm">
      {before}
      <a
        href={DEPLOYMENT_GUIDE_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline-offset-4 hover:underline"
      >
        {t("deploymentGuide")}
      </a>
      {after}
    </p>
  );
}

function AvailableView(props: { update: Update; action: Action; appName: string; onInstall: () => void }) {
  const { update } = props;
  const t = useT(messages);
  const format = useFormatter();
  const { notes, more } = visibleNotes(update);
  const installsAt = update.installsAt
    ? new Date(update.installsAt).getTime() > Date.now()
      ? t("installsOn", { date: format.dateTime(update.installsAt) })
      : t("installsNextCheck")
    : null;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Title>{t("available")}</Title>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="break-all">
            {update.version}
            {update.publishedAt ? ` · ${format.relative(update.publishedAt)}` : ""}
          </span>
          {update.preview ? <Badge variant="secondary">{t("preview")}</Badge> : null}
        </div>
      </div>
      {notes.length > 0 ? (
        <div className="grid gap-1 text-sm">
          <ul className="grid list-disc gap-1 pl-5">
            {notes.map((note, index) => (
              <li key={index} className="break-words">
                {note}
              </li>
            ))}
          </ul>
          {more > 0 ? <p className="text-muted-foreground">{t("moreChanges", { count: more })}</p> : null}
        </div>
      ) : null}
      {update.url ? <ReleaseNotesLink url={update.url} /> : null}
      {installsAt ? <p className="text-muted-foreground text-sm">{installsAt}</p> : null}
      {props.action === "install" ? (
        <Button size="sm" onClick={props.onInstall}>
          {t("installNow")}
        </Button>
      ) : (
        <ActionNote action={props.action} version={update.version} appName={props.appName} />
      )}
    </div>
  );
}

function AttentionView(props: { update: Update; action: Action; appName: string; onInstall: () => void }) {
  const t = useT(messages);
  const { update } = props;
  return (
    <div className="grid gap-3">
      <Title>{t("needsSteps", { version: update.version })}</Title>
      <p className="text-muted-foreground text-sm">{t("needsStepsText")}</p>
      {update.url ? <ReleaseNotesLink url={update.url} /> : null}
      {props.action === "install-anyway" ? (
        <Button size="sm" variant="outline" onClick={props.onInstall}>
          {t("installAnyway")}
        </Button>
      ) : (
        <ActionNote action={props.action} version={update.version} appName={props.appName} />
      )}
    </div>
  );
}

function FailedView(props: {
  version: string;
  message: string | null;
  running: string | null;
  action: Action;
  appName: string;
  onRetry: () => void;
}) {
  const t = useT(messages);
  return (
    <div className="grid gap-3">
      <Title>{t("failedTitle", { version: props.version })}</Title>
      {props.message ? (
        <p className="text-destructive text-sm break-words whitespace-pre-line">{props.message}</p>
      ) : null}
      {props.running ? (
        <p className="text-muted-foreground text-sm">{t("stillRunning", { version: props.running })}</p>
      ) : null}
      {/* Only while the version is still offered; a release with upgrade steps asks again. */}
      {props.action === "install" || props.action === "install-anyway" ? (
        <Button size="sm" onClick={props.onRetry}>
          {t("tryAgain")}
        </Button>
      ) : (
        <ActionNote action={props.action} version={props.version} appName={props.appName} />
      )}
    </div>
  );
}

function InstallingView(props: {
  state: Extract<ButtonState, { kind: "installing" }>;
  running: string | null;
  appName: string;
  onStop: () => void;
}) {
  const t = useT(messages);
  const { state } = props;
  const stage = state.restarting
    ? t("restarting")
    : state.stage && state.stage !== "requested"
      ? t(`stage_${state.stage}`, { version: props.running ?? "" })
      : null;
  return (
    <div className="grid gap-2" role="status">
      <Title>{t("installing", { version: state.version })}</Title>
      {stage ? <p className="text-sm">{stage}</p> : null}
      <p className="text-muted-foreground text-sm">{t("restartsReloads", { app: props.appName })}</p>
      {state.slow ? (
        <>
          <p className="flex gap-2 text-sm">
            <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="break-words">{t("slow")}</span>
          </p>
          <Button size="sm" variant="outline" className="w-fit" onClick={props.onStop}>
            {t("stopWaiting")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

function Footer(props: {
  status: UpdaterStatus;
  installed: string | null;
  checking: boolean;
  onCheck: () => void;
}) {
  const t = useT(messages);
  const format = useFormatter();
  return (
    <div className="text-muted-foreground mt-3 grid gap-1 border-t pt-3 text-xs">
      <p>
        {t("installedFooter", {
          version: props.installed ?? t("development"),
          channel: t(props.status.channel),
        })}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span>
          {props.status.checkedAt ? t("checked", { time: format.relative(props.status.checkedAt) }) : null}
        </span>
        <Button
          variant="link"
          size="xs"
          className="h-auto px-0 has-[>svg]:px-0"
          onClick={props.onCheck}
          disabled={props.checking}
        >
          {t("checkNow")}
        </Button>
      </div>
    </div>
  );
}

type Confirm = { version: string; attention: boolean; url: string | null };

/**
 * The update button in the header, for superadmins: shows whether an update
 * is available, installs it on request and follows the installation.
 */
export function UpdateButton() {
  const t = useT(messages);
  const appName = useAuthConfig()?.appName || "Helpdesk";
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const showFailure = useCallback(() => setOpen(true), []);
  const watch = useInstallWatch(showFailure);
  const query = useUpdates({ polling: !watch.pending });
  const check = useCheckUpdates();
  const install = useInstallUpdate();
  const { adopt } = watch;

  const data = query.data;
  // Follow an installation that a poll, a check or a refused install reports.
  useEffect(() => {
    if (data) adopt(data);
  }, [data, adopt]);

  const state = buttonState({
    data,
    loadFailed: query.isError,
    checking: check.isPending,
    pending: watch.pending,
    failure: watch.failure,
    restarting: watch.restarting,
    now: watch.now,
  });
  if (!state) return null;

  const status = data?.reachable ? data.updater : null;
  const installed = status?.installed ?? data?.app.version ?? null;
  const popover = hasPopover(state);
  const label = tooltip(state, t);

  const runCheck = () =>
    check.mutate(undefined, {
      onSuccess: (result) => {
        const problem = result.error ?? result.updater?.error;
        if (problem) toast.error(t("checkFailed", { error: problem }));
      },
      onError: (error) => toast.error(errorMessage(error)),
    });

  const startInstall = async ({ version }: Confirm) => {
    // Remembered before the request: a platform can restart the app before it answers.
    const attempt = watch.begin(version, query.data?.app.version ?? null);
    setOpen(false);
    let answer: InstallAnswer;
    try {
      answer = { data: await install.mutateAsync(version) };
    } catch (error) {
      answer = { error };
    }
    const error = watch.settle(attempt, answer);
    if (error) toast.error(error);
  };

  const ask = (version: string, url: string | null, attention: boolean) => {
    setOpen(false);
    setConfirm({ version, attention, url });
  };

  return (
    <>
      <Popover open={open && popover} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative rounded-full"
                aria-label={label}
                data-state-kind={state.kind}
                onClick={(event) => {
                  if (popover) return;
                  // No popover: the click checks (Radix skips its toggle).
                  event.preventDefault();
                  if (state.kind === "unreachable") void query.refetch();
                  else if (state.kind !== "checking") runCheck();
                }}
              >
                <StateIcon state={state} />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
          {state.kind === "available" ? (
            <AvailableView
              update={state.update}
              action={installAction(status, state.update.version)}
              appName={appName}
              onInstall={() => ask(state.update.version, state.update.url, false)}
            />
          ) : state.kind === "attention" ? (
            <AttentionView
              update={state.update}
              action={installAction(status, state.update.version)}
              appName={appName}
              onInstall={() => ask(state.update.version, state.update.url, true)}
            />
          ) : state.kind === "failed" ? (
            <FailedView
              version={state.version}
              message={state.message}
              running={installed}
              action={installAction(status, state.version)}
              appName={appName}
              onRetry={() =>
                ask(
                  state.version,
                  state.update?.url ?? null,
                  installAction(status, state.version) === "install-anyway",
                )
              }
            />
          ) : state.kind === "installing" ? (
            <InstallingView
              state={state}
              running={watch.pending?.fromVersion ?? installed}
              appName={appName}
              onStop={watch.stop}
            />
          ) : null}
          {status ? (
            <Footer status={status} installed={installed} checking={check.isPending} onCheck={runCheck} />
          ) : null}
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={
          confirm
            ? t(confirm.attention ? "confirmAttentionTitle" : "confirmTitle", { version: confirm.version })
            : ""
        }
        description={
          confirm ? t(confirm.attention ? "confirmAttentionText" : "confirmText", { app: appName }) : ""
        }
        confirmLabel={t("install")}
        destructive={confirm?.attention}
        onConfirm={() => (confirm ? startInstall(confirm) : undefined)}
      >
        {confirm?.attention && confirm.url ? <ReleaseNotesLink url={confirm.url} /> : null}
      </ConfirmDialog>
    </>
  );
}
