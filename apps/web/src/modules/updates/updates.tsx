import type { ReactNode } from "react";
import { UpdatesProvider } from "@meldgrove/ui/updates";
import { useHasRole } from "@/hooks/use-me";
import { apiUrl, sessionEnded } from "@/lib/api";

/** Section "Automatic updates" of the deployment guide, for superadmins without an update service. */
const DEPLOYMENT_GUIDE =
  "https://github.com/meldgrove/helpdesk/blob/main/docs/deployment.md#automatic-updates";

/**
 * Superadmins: the update status that the header button and the Updates page
 * share (polling, installing, following the restart). Everyone else gets 403
 * from the routes, so nothing asks for them.
 */
export function SuperadminUpdates({ appName, children }: { appName: string; children: ReactNode }) {
  if (!useHasRole("superadmin")) return children;
  return (
    <UpdatesProvider
      appName={appName}
      // The systemd unit of a server set up as in docs/deployment.md.
      project="helpdesk"
      url={apiUrl("/updates")}
      guideUrl={DEPLOYMENT_GUIDE}
      // US English dates, as everywhere in the app.
      dateLocale="en-US"
      // An ended session (401, sign-in page): the app's sign-in handling, as for a 401 of any
      // API request. A lost superadmin role (403, 404) only stops the requests.
      onSignedOut={(reason) => {
        if (reason === "signed-out") sessionEnded();
      }}
    >
      {children}
    </UpdatesProvider>
  );
}
