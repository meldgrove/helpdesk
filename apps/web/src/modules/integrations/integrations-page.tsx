import { Page, PageHeader } from "@/components/layout/page";
import { useT } from "@/i18n";
import { DeliveriesCard } from "./deliveries-card";
import { EmailCard } from "./email-card";
import { messages } from "./messages";
import { SlackCard } from "./slack-card";

export function IntegrationsPage() {
  const t = useT(messages);
  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />
      <EmailCard />
      <SlackCard />
      <DeliveriesCard />
    </Page>
  );
}
