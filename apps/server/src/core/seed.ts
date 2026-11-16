import { count } from "drizzle-orm";
import { DEFAULT_FORM, DEFAULT_FORM_DE } from "@helpdesk/shared/form";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { categories, formVersions } from "../db/schema";
import { logger } from "../logger";

/** A new installation starts with the default form and one category, in DEFAULT_LOCALE. */
export async function ensureDefaults(db: DbOrTx) {
  const [forms] = await db.select({ value: count() }).from(formVersions);
  if (!forms?.value) {
    const definition = config().DEFAULT_LOCALE === "de" ? DEFAULT_FORM_DE : DEFAULT_FORM;
    await db.insert(formVersions).values({ version: 1, definition }).onConflictDoNothing();
    logger.info("default request form created");
  }
  const [existing] = await db.select({ value: count() }).from(categories);
  if (!existing?.value) {
    await db
      .insert(categories)
      .values({ name: config().DEFAULT_LOCALE === "de" ? "Allgemein" : "General", position: 1 });
    logger.info("default category created");
  }
}
