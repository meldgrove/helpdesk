import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "My settings",
    description: "Your account and how the helpdesk reaches you.",
    account: "Account",
    accountHint:
      "Your name, email and role come from your organization's sign-in. Your role follows your groups there; ask your IT team to change it.",
    name: "Name",
    email: "Email",
    role: "Role",
    language: "Language",
    languageHint: "Applies in this browser. Emails to you follow when you choose English or Deutsch.",
    browser: "Browser language",
    notifications: "Notifications",
    notifyQuestion: "How do you want to hear about tickets assigned to you and replies from requesters?",
    notifyEmail: "Email",
    notifyEmailHint: "To {email}.",
    notifySlack: "Slack direct message",
    notifySlackHint: "From the helpdesk's Slack bot. Your Slack account must use the same email address.",
    slackUnavailable: "Slack isn't set up for the helpdesk yet.",
    slackFallback: "Slack isn't connected right now, so you get emails until it is.",
    requesterNote: "You get emails about your requests: when they're received, answered and done.",
  },
  de: {
    title: "Meine Einstellungen",
    description: "Dein Konto und wie der Helpdesk dich erreicht.",
    account: "Konto",
    accountHint:
      "Name, E-Mail und Rolle kommen aus der Anmeldung deiner Organisation. Deine Rolle folgt deinen Gruppen dort; wende dich an dein IT-Team, um sie zu ändern.",
    name: "Name",
    email: "E-Mail",
    role: "Rolle",
    language: "Sprache",
    languageHint: "Gilt in diesem Browser. E-Mails an dich folgen, wenn du English oder Deutsch wählst.",
    browser: "Sprache des Browsers",
    notifications: "Benachrichtigungen",
    notifyQuestion:
      "Wie möchtest du von Tickets erfahren, die dir zugewiesen sind, und von Antworten anfragender Personen?",
    notifyEmail: "E-Mail",
    notifyEmailHint: "An {email}.",
    notifySlack: "Slack-Direktnachricht",
    notifySlackHint: "Vom Slack-Bot des Helpdesks. Dein Slack-Konto muss dieselbe E-Mail-Adresse nutzen.",
    slackUnavailable: "Slack ist für den Helpdesk noch nicht eingerichtet.",
    slackFallback: "Slack ist gerade nicht verbunden, deshalb bekommst du bis dahin E-Mails.",
    requesterNote:
      "Du bekommst E-Mails zu deinen Anfragen: wenn sie eingegangen, beantwortet und erledigt sind.",
  },
});
