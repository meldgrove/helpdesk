import { useId } from "react";
import { Info } from "lucide-react";
import { toast } from "sonner";
import type { Me } from "@helpdesk/shared/api/users";
import type { NotifyChannel } from "@helpdesk/shared/roles";
import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useHasRole, useMe } from "@/hooks/use-me";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { useLocaleChoice, type LocaleChoice } from "@/i18n/provider";
import { errorMessage } from "@/lib/api";
import { useRoleLabel } from "@/lib/labels";
import { useUpdateMe } from "./api";
import { messages } from "./messages";

/** One choice of a radio group, as a bordered card with a title and a hint. */
function Choice(props: { id: string; value: string; title: string; hint?: string; disabled?: boolean }) {
  return (
    <FieldLabel htmlFor={props.id}>
      <Field orientation="horizontal" data-disabled={props.disabled ? true : undefined}>
        <RadioGroupItem value={props.value} id={props.id} disabled={props.disabled} />
        <FieldContent>
          <FieldTitle>{props.title}</FieldTitle>
          {props.hint ? <FieldDescription>{props.hint}</FieldDescription> : null}
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}

function AccountCard({ me }: { me: Me }) {
  const t = useT(messages);
  const roleLabel = useRoleLabel();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("account")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted-foreground">{t("name")}</dt>
          <dd className="min-w-0 break-words">{me.name}</dd>
          <dt className="text-muted-foreground">{t("email")}</dt>
          <dd className="min-w-0 break-all">{me.email}</dd>
          <dt className="text-muted-foreground">{t("role")}</dt>
          <dd>{roleLabel(me.role)}</dd>
        </dl>
        <p className="text-muted-foreground flex gap-2">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{t("accountHint")}</span>
        </p>
      </CardContent>
    </Card>
  );
}

function LanguageCard() {
  const t = useT(messages);
  const id = useId();
  const { choice, setChoice } = useLocaleChoice();
  const update = useUpdateMe();

  const choose = (value: LocaleChoice) => {
    setChoice(value);
    // Emails follow the language chosen here.
    if (value === "en" || value === "de") {
      update.mutate({ locale: value }, { onError: (error) => toast.error(errorMessage(error)) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id={`${id}-title`}>{t("language")}</h2>
        </CardTitle>
        <CardDescription id={`${id}-hint`}>{t("languageHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={choice}
          onValueChange={(value) => choose(value as LocaleChoice)}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          className="grid gap-3 sm:grid-cols-3"
        >
          <Choice id={`${id}-browser`} value="browser" title={t("browser")} />
          <Choice id={`${id}-en`} value="en" title="English" />
          <Choice id={`${id}-de`} value="de" title="Deutsch" />
        </RadioGroup>
      </CardContent>
    </Card>
  );
}

function NotificationsCard({ me }: { me: Me }) {
  const t = useT(messages);
  const tc = useT(common);
  const id = useId();
  const update = useUpdateMe();
  const value = (update.isPending ? update.variables.notifyVia : undefined) ?? me.notifyVia;

  const choose = (notifyVia: NotifyChannel) => {
    if (notifyVia === me.notifyVia) return;
    update.mutate(
      { notifyVia },
      {
        onSuccess: () => toast.success(tc("saved")),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("notifications")}</h2>
        </CardTitle>
        <CardDescription id={`${id}-question`}>{t("notifyQuestion")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <RadioGroup
          value={value}
          onValueChange={(next) => choose(next as NotifyChannel)}
          aria-labelledby={`${id}-question`}
          disabled={update.isPending}
          className="grid gap-3 sm:grid-cols-2"
        >
          <Choice
            id={`${id}-email`}
            value="email"
            title={t("notifyEmail")}
            hint={t("notifyEmailHint", { email: me.email })}
          />
          <Choice
            id={`${id}-slack`}
            value="slack"
            title={t("notifySlack")}
            hint={me.slackAvailable ? t("notifySlackHint") : t("slackUnavailable")}
            disabled={!me.slackAvailable && me.notifyVia !== "slack"}
          />
        </RadioGroup>
        {me.notifyVia === "slack" && !me.slackAvailable ? (
          <p className="text-muted-foreground flex gap-2 text-sm" role="status">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t("slackFallback")}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequesterNote() {
  const t = useT(messages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("notifications")}</h2>
        </CardTitle>
        <CardDescription>{t("requesterNote")}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export function SettingsPage() {
  const t = useT(messages);
  const me = useMe();
  const staff = useHasRole("operator");
  return (
    <Page className="max-w-3xl">
      <PageHeader title={t("title")} description={t("description")} />
      <AccountCard me={me} />
      <LanguageCard />
      {staff ? <NotificationsCard me={me} /> : <RequesterNote />}
    </Page>
  );
}
