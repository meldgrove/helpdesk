import { Card, CardContent } from "@meldgrove/ui/card";
import { UpdatesSettings, useUpdatesController, useUpdatesSnapshot } from "@meldgrove/ui/updates";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { useHasRole } from "@/hooks/use-me";

/** Superadmins: the installed version, the update channel and automatic installs. */
export function UpdatesPage() {
  // The update status exists for superadmins only (SuperadminUpdates); the route checks the role on
  // load, this covers a role that changes while the page is open.
  return useHasRole("superadmin") ? <UpdatesContent /> : null;
}

function UpdatesContent() {
  const controller = useUpdatesController();
  // Renders again when the app's name arrives (auth config) or changes.
  useUpdatesSnapshot();
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={controller.t("updates")}
        description={controller.t("sectionText", { app: controller.appName })}
      />
      <Card>
        <CardContent>
          <UpdatesSettings />
        </CardContent>
      </Card>
    </Page>
  );
}
