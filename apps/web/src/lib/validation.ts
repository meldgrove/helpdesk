import { useMemo } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FieldValues, Path, Resolver, UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { defineMessages, translate, useLocale, type Messages } from "@/i18n";
import type { Locale } from "@/i18n/locales";
import { ApiError } from "./api";

/**
 * Validation messages. The shared schemas carry English messages; the German
 * catalog translates them by their English text (`known`). Zod's own
 * messages are replaced by plain ones (`issueMessage`).
 */
const known = defineMessages({
  en: {
    "A Slack channel ID, e.g. C0123456789": "A Slack channel ID, e.g. C0123456789",
    "A bot token starts with xoxb-": "A bot token starts with xoxb-",
    "Could not reach Slack. Try again.": "Could not reach Slack. Try again.",
    "Enter the sender address": "Enter the sender address",
    "Enter the mail server": "Enter the mail server",
    "Enter the API token": "Enter the API token",
    "Enter a title": "Enter a title",
    "Enter a name": "Enter a name",
    "Enter a label": "Enter a label",
    "Enter a question": "Enter a question",
    "Enter a date": "Enter a date",
    "Choose a category": "Choose a category",
    "Choose an urgency": "Choose an urgency",
    "Choose a person with access": "Choose a person with access",
    "Choose an operator, admin or superadmin": "Choose an operator, admin or superadmin",
    "Choose a question that comes earlier": "Choose a question that comes earlier",
    "Choose a value": "Choose a value",
    "Choose one of the question's choices": "Choose one of the question's choices",
    "This comparison does not fit the question": "This comparison does not fit the question",
    "Add at least one choice": "Add at least one choice",
    "Two choices have this id": "Two choices have this id",
    "Two pages have this id": "Two pages have this id",
    "Two questions have this id": "Two questions have this id",
    "The first page is always shown": "The first page is always shown",
    "Write a message or add a file": "Write a message or add a file",
    "A file is missing. Upload it again.": "A file is missing. Upload it again.",
    "Answer this question": "Answer this question",
    "Check this answer": "Check this answer",
    "This answer is too long": "This answer is too long",
    "Choose one of the options": "Choose one of the options",
    "Too many files": "Too many files",
    "Use 1 to 40 lowercase letters, digits, - or _": "Use 1 to 40 lowercase letters, digits, - or _",
  },
  de: {
    "A Slack channel ID, e.g. C0123456789": "Eine Slack-Kanal-ID, z. B. C0123456789",
    "A bot token starts with xoxb-": "Ein Bot-Token beginnt mit xoxb-",
    "Could not reach Slack. Try again.": "Slack ist nicht erreichbar. Versuche es erneut.",
    "Enter the sender address": "Gib die Absenderadresse ein",
    "Enter the mail server": "Gib den Mailserver ein",
    "Enter the API token": "Gib den API-Token ein",
    "Enter a title": "Gib einen Titel ein",
    "Enter a name": "Gib einen Namen ein",
    "Enter a label": "Gib eine Bezeichnung ein",
    "Enter a question": "Gib eine Frage ein",
    "Enter a date": "Gib ein Datum ein",
    "Choose a category": "Wähle eine Kategorie",
    "Choose an urgency": "Wähle eine Dringlichkeit",
    "Choose a person with access": "Wähle eine Person mit Zugang",
    "Choose an operator, admin or superadmin": "Wähle eine Person aus Bearbeitung, Admin oder Superadmin",
    "Choose a question that comes earlier": "Wähle eine Frage, die vorher kommt",
    "Choose a value": "Wähle einen Wert",
    "Choose one of the question's choices": "Wähle eine der Antworten der Frage",
    "This comparison does not fit the question": "Dieser Vergleich passt nicht zur Frage",
    "Add at least one choice": "Füge mindestens eine Antwort hinzu",
    "Two choices have this id": "Zwei Antworten haben diese ID",
    "Two pages have this id": "Zwei Seiten haben diese ID",
    "Two questions have this id": "Zwei Fragen haben diese ID",
    "The first page is always shown": "Die erste Seite wird immer gezeigt",
    "Write a message or add a file": "Schreib eine Nachricht oder füge eine Datei hinzu",
    "A file is missing. Upload it again.": "Eine Datei fehlt. Lade sie erneut hoch.",
    "Answer this question": "Beantworte diese Frage",
    "Check this answer": "Prüfe diese Antwort",
    "This answer is too long": "Diese Antwort ist zu lang",
    "Choose one of the options": "Wähle eine der Möglichkeiten",
    "Too many files": "Zu viele Dateien",
    "Use 1 to 40 lowercase letters, digits, - or _": "1 bis 40 Kleinbuchstaben, Ziffern, - oder _",
  },
});

const generic = defineMessages({
  en: {
    required: "Required",
    tooLong: "At most {max} characters",
    tooFew: "Choose at least {min}",
    tooMany: "At most {max}",
    min: "At least {min}",
    max: "At most {max}",
    url: "Enter a full address, e.g. https://example.org",
    email: "Enter an email address",
    format: "Check the format",
    number: "Enter a number",
    choose: "Choose an option",
    invalid: "Check this value",
  },
  de: {
    required: "Pflichtfeld",
    tooLong: "Höchstens {max} Zeichen",
    tooFew: "Wähle mindestens {min}",
    tooMany: "Höchstens {max}",
    min: "Mindestens {min}",
    max: "Höchstens {max}",
    url: "Gib eine vollständige Adresse ein, z. B. https://example.org",
    email: "Gib eine E-Mail-Adresse ein",
    format: "Prüfe das Format",
    number: "Gib eine Zahl ein",
    choose: "Wähle eine Option",
    invalid: "Prüfe diesen Wert",
  },
});

/** A message from the shared schemas or the server, in the interface language when known. */
export function translateMessage(message: string, locale: Locale): string {
  const catalog = known[locale] as Record<string, string>;
  return catalog[message] ?? message;
}

type Issue = {
  code: string;
  origin?: string;
  format?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  expected?: string;
  input?: unknown;
};

/** A plain message for zod's built-in checks (custom messages of the schemas win). */
export function issueMessage(issue: Issue, locale: Locale): string {
  const t = translate(generic as Messages<typeof generic.en>, locale);
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string")
        return Number(issue.minimum) <= 1 ? t("required") : t("min", { min: String(issue.minimum) });
      if (issue.origin === "array") return t("tooFew", { min: String(issue.minimum) });
      return t("min", { min: String(issue.minimum) });
    case "too_big":
      if (issue.origin === "string") return t("tooLong", { max: String(issue.maximum) });
      if (issue.origin === "array") return t("tooMany", { max: String(issue.maximum) });
      return t("max", { max: String(issue.maximum) });
    case "invalid_format":
      if (issue.format === "url") return t("url");
      if (issue.format === "email") return t("email");
      return t("format");
    case "invalid_type":
      if (issue.expected === "number") return t("number");
      if (issue.input === null || issue.input === undefined || issue.input === "") return t("required");
      return t("invalid");
    case "invalid_value":
      return t("choose");
    default:
      return t("invalid");
  }
}

/**
 * A react-hook-form resolver for a shared schema, with messages in the
 * interface language. `Values` are the form's values (text fields stay
 * strings; the schema turns blanks into null), `Output` the API input.
 */
export function useSchemaResolver<Values extends FieldValues, Output>(
  schema: z.ZodType<Output, unknown>,
): Resolver<Values, unknown, Output> {
  const locale = useLocale();
  return useMemo(() => schemaResolver<Values, Output>(schema, locale), [schema, locale]);
}

export function schemaResolver<Values extends FieldValues, Output>(
  schema: z.ZodType<Output, unknown>,
  locale: Locale,
): Resolver<Values, unknown, Output> {
  const resolve = zodResolver(schema as never, {
    error: (issue: Issue) => issueMessage(issue, locale),
  }) as unknown as Resolver<Values, unknown, Output>;
  return async (values, context, options) => {
    const result = await resolve(values, context, options);
    translateErrors(result.errors, locale);
    return result;
  };
}

/** Plain error objects and lists, never the field's element (`ref`). */
function childErrors(error: object): object[] {
  return Object.entries(error)
    .filter(([key, value]) => key !== "ref" && key !== "types" && isPlain(value))
    .map(([, value]) => value as object);
}

function isPlain(value: unknown): value is object {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

function translateErrors(errors: object, locale: Locale) {
  for (const value of childErrors(errors)) {
    const error = value as { message?: unknown };
    if (typeof error.message === "string") error.message = translateMessage(error.message, locale);
    translateErrors(value, locale);
  }
}

/**
 * Shows the field messages of a failed request next to the fields
 * (`fields` keys are paths such as `config.url`). Returns the messages
 * that match no field, to show elsewhere.
 */
export function applyServerErrors<Values extends FieldValues>(
  form: Pick<UseFormReturn<Values>, "setError" | "getValues">,
  error: unknown,
  locale: Locale,
  aliases: Record<string, Path<Values>> = {},
): string[] {
  if (!(error instanceof ApiError) || !error.fields) return [];
  const unmatched: string[] = [];
  const values = form.getValues() as Record<string, unknown>;
  for (const [key, message] of Object.entries(error.fields)) {
    const path = aliases[key] ?? key;
    const root = path.split(".")[0]!;
    const text = translateMessage(message, locale);
    if (root in values) form.setError(path as Path<Values>, { type: "server", message: text });
    else unmatched.push(text);
  }
  return unmatched;
}

/** The first message of a field error, also of a list field whose items have errors. */
export function firstMessage(error: unknown): string | undefined {
  if (!isPlain(error)) return undefined;
  const value = error as { message?: unknown };
  if (typeof value.message === "string" && value.message) return value.message;
  for (const child of childErrors(error)) {
    const message = firstMessage(child);
    if (message) return message;
  }
  return undefined;
}
