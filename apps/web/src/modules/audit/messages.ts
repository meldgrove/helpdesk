import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Audit log",
    description:
      "Who changed the request form, categories, email and Slack, and every directory sync. Entries never contain secrets.",
    empty: "No entries yet",
    emptyHint: "Changes appear here as they happen.",
    colWhen: "When",
    colWho: "Who",
    colWhat: "What",
    system: "System",
  },
  de: {
    title: "Protokoll",
    description:
      "Wer Anfrageformular, Kategorien, E-Mail und Slack geändert hat, und jeder Verzeichnis-Abgleich. Einträge enthalten nie Geheimnisse.",
    empty: "Noch keine Einträge",
    emptyHint: "Änderungen erscheinen hier, sobald sie passieren.",
    colWhen: "Wann",
    colWho: "Wer",
    colWhat: "Was",
    system: "System",
  },
});
