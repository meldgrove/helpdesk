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
  buttonState,
  hasPopover,
  installOutcome,
  isOutage,
  readPendingInstall,
  visibleNotes,
  writePendingInstall,
  type ButtonState,
  type PendingInstall,
} from "./state";

const POLL_MS = 2_000;
const RELOAD_MS = 1_500;

type Translate = ReturnType<typeof useT<typeof messages.en>>;

/**
 * Follows an installation this page started: polls every 2 s, takes failed
 * polls as the restart, and ends with a toast and a reload, or the failure.
 * `onFailed` must be stable.
 */
function useInstallWatch(onFailed: () => void) {
  const client = useQueryClient();
  const t = useT(messages);
  const [pending, setPendingState] = useState<PendingInstall | null>(readPendingInstall);
  const [restarting, setRestarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pendingRef = useRef(pending);

  const setPending = (value: PendingInstall | null) => {
    pendingRef.current = value;
    writePendingInstall(value);
    setPendingState(value);
  };

  const key = pending ? `${pending.version}@${pending.startedAt}` : null;
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
        if (isOutage(error) && pendingRef.current && !pendingRef.current.outage) {
          pendingRef.current = { ...pendingRef.current, outage: true };
          writePendingInstall(pendingRef.current);
        }
        setRestarting(isOutage(error));
      }
      if (stopped) return;
      setNow(Date.now());
      if (data && pendingRef.current) {
        setRestarting(false);
        client.setQueryData(updatesKey, data);
        const outcome = installOutcome(pendingRef.current, data);
        if (outcome === "done") {
          const { version } = pendingRef.current;
          writePendingInstall(null);
          toast.success(t("updated", { version }));
          setTimeout(() => window.location.reload(), RELOAD_MS);
          return;
        }
        if (outcome === "failed") {
          pendingRef.current = null;
          writePendingInstall(null);
          setPendingState(null);
          onFailed();
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
  }, [key, client, t, onFailed]);

  return { pending, setPending, restarting, now };
}

function tooltip(state: ButtonState, t: Translate): string {
  switch (state.kind) {
    case "checking":
      return t("checking");
    case "up-to-date":
      return state.installed ? t("upToDateVersion", { version: state.installed }) : t("upToDate");
    case "available":
      return t("availableVersion", { version: state.update.version });
    case "attention":
      return t("needsSteps", { version: state.update.version });
    case "installing":
      return state.restarting ? t("restarting") : t("installing", { version: state.version });
    case "failed":
      return t("failedTitle", { version: state.update.version });
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

/** In mode off, in place of the install buttons: nothing can install from here. */
function OffNote() {
  const t = useT(messages);
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

function AvailableView({ update, onInstall }: { update: Update; onInstall: (() => void) | null }) {
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
      {onInstall ? (
        <Button size="sm" onClick={onInstall}>
          {t("installNow")}
        </Button>
      ) : (
        <OffNote />
      )}
    </div>
  );
}

function AttentionView({ update, onInstall }: { update: Update; onInstall: (() => void) | null }) {
  const t = useT(messages);
  return (
    <div className="grid gap-3">
      <Title>{t("needsSteps", { version: update.version })}</Title>
      <p className="text-muted-foreground text-sm">{t("needsStepsText")}</p>
      {update.url ? <ReleaseNotesLink url={update.url} /> : null}
      {onInstall ? (
        <Button size="sm" variant="outline" onClick={onInstall}>
          {t("installAnyway")}
        </Button>
      ) : (
        <OffNote />
      )}
    </div>
  );
}

function FailedView(props: {
  update: Update;
  message: string | null;
  running: string | null;
  onRetry: (() => void) | null;
}) {
  const t = useT(messages);
  return (
    <div className="grid gap-3">
      <Title>{t("failedTitle", { version: props.update.version })}</Title>
      {props.message ? (
        <p className="text-destructive text-sm break-words whitespace-pre-line">{props.message}</p>
      ) : null}
      {props.running ? (
        <p className="text-muted-foreground text-sm">{t("stillRunning", { version: props.running })}</p>
      ) : null}
      {props.onRetry ? (
        <Button size="sm" onClick={props.onRetry}>
          {t("tryAgain")}
        </Button>
      ) : (
        <OffNote />
      )}
    </div>
  );
}

function InstallingView(props: {
  state: Extract<ButtonState, { kind: "installing" }>;
  running: string | null;
  appName: string;
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
        <p className="flex gap-2 text-sm">
          <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="break-words">{t("slow")}</span>
        </p>
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

  const data = query.data;
  const state = buttonState({
    data,
    loadFailed: query.isError,
    checking: check.isPending,
    pending: watch.pending,
    restarting: watch.restarting,
    now: watch.now,
  });
  if (!state) return null;

  const status = data?.reachable ? data.updater : null;
  const installed = status?.installed ?? data?.app.version ?? null;
  const popover = hasPopover(state);
  // Mode off: the popover shows the update, but nothing can install from here.
  const installable = status?.mode !== "off";
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
    const before = query.data;
    let result: UpdatesResponse;
    try {
      result = await install.mutateAsync(version);
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
    if (!result.reachable || result.error) {
      toast.error(result.error ?? t("unreachable"));
      return;
    }
    setOpen(false);
    watch.setPending({
      version,
      startedAt: Date.now(),
      fromVersion: before?.app.version ?? null,
      lastBefore: before?.updater?.last?.finishedAt ?? null,
      outage: false,
    });
  };

  const ask = (update: Update, attention: boolean) => {
    setOpen(false);
    setConfirm({ version: update.version, attention, url: update.url });
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
              onInstall={installable ? () => ask(state.update, false) : null}
            />
          ) : state.kind === "attention" ? (
            <AttentionView
              update={state.update}
              onInstall={installable ? () => ask(state.update, true) : null}
            />
          ) : state.kind === "failed" ? (
            <FailedView
              update={state.update}
              message={state.message}
              running={installed}
              onRetry={
                installable
                  ? () => ask(state.update, status?.attention?.version === state.update.version)
                  : null
              }
            />
          ) : state.kind === "installing" ? (
            <InstallingView
              state={state}
              running={watch.pending?.fromVersion ?? installed}
              appName={appName}
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
