import { useId } from "react";
import { ExternalLink, Info, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { UpdateChannel, UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { Page, PageHeader } from "@/components/layout/page";
import { ErrorState, LoadingState } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useCheckUpdates, useSetUpdateChannel, useUpdates } from "./api";
import { messages } from "./messages";
import { buttonState, formatCooldown, parseWindow } from "./state";

export const DEPLOYMENT_GUIDE_URL =
  "https://github.com/meldgrove/helpdesk/blob/main/docs/deployment.md#automatic-updates";

type Translate = ReturnType<typeof useT<typeof messages.en>>;

/** The status line: what the update button shows, in words. */
function statusText(data: UpdatesResponse, t: Translate): string {
  const state = buttonState({
    data,
    loadFailed: false,
    checking: false,
    pending: null,
    restarting: false,
    now: Date.now(),
  });
  const status = data.updater;
  switch (state?.kind) {
    case "installing":
      return t("installing", { version: state.version });
    case "failed":
      return t("failedTitle", { version: state.update.version });
    case "attention":
      return t("needsSteps", { version: state.update.version });
    case "available":
      return t("availableVersion", { version: state.update.version });
    default:
      // Checking: still name an update the updater found.
      return status?.available
        ? t("availableVersion", { version: status.available.version })
        : status?.attention
          ? t("needsSteps", { version: status.attention.version })
          : t("upToDate");
  }
}

/** "On: releases install automatically after 3 days, between 02:00 and 05:00 (UTC)." and its variants. */
export function automaticInstallsText(status: UpdaterStatus, t: Translate): string {
  if (status.mode === "off" || !status.automatic) return t("automaticOff");
  const range = parseWindow(status.window);
  const window = range ? { start: range[0], end: range[1], timezone: status.timezone } : null;
  const cooldown = status.cooldown ? formatCooldown(status.cooldown) : null;
  const line =
    status.channel === "preview"
      ? window
        ? t("automaticPreviewWindow", window)
        : t("automaticPreview")
      : cooldown
        ? window
          ? t("automaticOnWindow", { ...window, cooldown })
          : t("automaticOn", { cooldown })
        : window
          ? t("automaticOnNoCooldownWindow", window)
          : t("automaticOnNoCooldown");
  return status.mode === "platform" ? `${line} ${t("automaticPlatform")}` : line;
}

function GuideLink() {
  const t = useT(messages);
  return (
    <a
      href={DEPLOYMENT_GUIDE_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary whitespace-nowrap underline-offset-4 hover:underline"
    >
      {t("deploymentGuide")}
      <ExternalLink className="ml-1 inline size-3" aria-hidden />
    </a>
  );
}

function VersionCard({ data }: { data: UpdatesResponse }) {
  const t = useT(messages);
  const format = useFormatter();
  const status = data.reachable ? data.updater : null;
  const update = status?.available ?? status?.attention ?? null;
  const [before, after] = t("unreachableText").split("{guide}");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("versionTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted-foreground">{t("installed")}</dt>
          <dd className="min-w-0 break-all">{data.app.version ?? t("development")}</dd>
          {status ? (
            <>
              <dt className="text-muted-foreground">{t("channel")}</dt>
              <dd>{t(status.channel)}</dd>
              <dt className="text-muted-foreground">{t("status")}</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="break-all">{statusText(data, t)}</span>
                {update?.preview ? <Badge variant="secondary">{t("preview")}</Badge> : null}
              </dd>
              <dt className="text-muted-foreground">{t("lastCheck")}</dt>
              <dd>
                {status.checkedAt ? (
                  <time dateTime={status.checkedAt} title={format.dateTime(status.checkedAt)}>
                    {format.relative(status.checkedAt)}
                  </time>
                ) : (
                  t("never")
                )}
              </dd>
              <dt className="text-muted-foreground">{t("automaticTitle")}</dt>
              <dd>{automaticInstallsText(status, t)}</dd>
            </>
          ) : null}
        </dl>
        {status?.error ? (
          <p className="text-destructive flex gap-2" role="status">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="break-words">{t("checkFailed", { error: status.error })}</span>
          </p>
        ) : null}
        {!status ? (
          <Alert>
            <Info aria-hidden />
            <AlertDescription>
              <p>
                {before}
                <GuideLink />
                {after}
              </p>
              {data.error ? <p className="text-xs break-words">{data.error}</p> : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One choice of a radio group, as a bordered card with a title and a hint. */
function Choice(props: { id: string; value: string; title: string; hint: string; disabled: boolean }) {
  return (
    <FieldLabel htmlFor={props.id}>
      <Field orientation="horizontal" data-disabled={props.disabled ? true : undefined}>
        <RadioGroupItem value={props.value} id={props.id} disabled={props.disabled} />
        <FieldContent>
          <FieldTitle>{props.title}</FieldTitle>
          <FieldDescription>{props.hint}</FieldDescription>
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}

function ChannelCard({ data }: { data: UpdatesResponse }) {
  const t = useT(messages);
  const id = useId();
  const save = useSetUpdateChannel();
  const status = data.reachable ? data.updater : null;
  const disabled = !status || status.channelLocked !== null || save.isPending;
  // Unknown without the updater: neither is chosen.
  const value = (save.isPending ? save.variables : undefined) ?? status?.channel ?? "";

  const choose = (channel: UpdateChannel) => {
    if (channel === status?.channel) return;
    save.mutate(channel, {
      onSuccess: (result) => {
        if (result.error || !result.reachable) toast.error(result.error ?? t("unreachable"));
        else toast.success(t("channelSaved"));
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id={`${id}-title`} className="flex items-center gap-2">
            {t("channel")}
            {save.isPending ? <Spinner /> : null}
          </h2>
        </CardTitle>
        <CardDescription>{t("switchBack")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <RadioGroup
          value={value}
          onValueChange={(next) => choose(next as UpdateChannel)}
          aria-labelledby={`${id}-title`}
          disabled={disabled}
          className="grid gap-3 sm:grid-cols-2"
        >
          <Choice
            id={`${id}-stable`}
            value="stable"
            title={`${t("stable")} (${t("recommended")})`}
            hint={
              status?.cooldown
                ? t("stableHint", { cooldown: formatCooldown(status.cooldown) })
                : t("stableHintNoCooldown")
            }
            disabled={disabled}
          />
          <Choice
            id={`${id}-preview`}
            value="preview"
            title={t("preview")}
            hint={t("previewHint")}
            disabled={disabled}
          />
        </RadioGroup>
        {status?.channelLocked ? (
          <p className="text-muted-foreground flex gap-2 text-sm" role="status">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="break-words">{status.channelLocked}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Superadmins: the installed version, the update channel and automatic installs. */
export function UpdatesPage() {
  const t = useT(messages);
  const query = useUpdates();
  const check = useCheckUpdates();

  const runCheck = () =>
    check.mutate(undefined, {
      onSuccess: (result) => {
        const problem = result.error ?? result.updater?.error;
        if (problem) toast.error(t("checkFailed", { error: problem }));
      },
      onError: (error) => toast.error(errorMessage(error)),
    });

  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button variant="outline" onClick={runCheck} disabled={check.isPending || query.isPending}>
            {check.isPending ? <Spinner /> : <RefreshCw aria-hidden />}
            {t("checkForUpdates")}
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <VersionCard data={query.data} />
          <ChannelCard data={query.data} />
        </>
      )}
    </Page>
  );
}
