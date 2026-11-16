import { LOCALES, type Locale } from "@helpdesk/shared/roles";

/** The first supported language of an Accept-Language header, or null. */
export function pickLocaleFromHeader(header: string | undefined): Locale | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase().slice(0, 2);
    if ((LOCALES as readonly string[]).includes(tag ?? "")) return tag as Locale;
  }
  return null;
}
