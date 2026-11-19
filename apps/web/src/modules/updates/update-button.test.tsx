import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithProviders } from "@/test-utils";
import { UpdateButton } from "./update-button";
import { UpdatesPage } from "./updates-page";

function status(overrides: Partial<UpdaterStatus> = {}): UpdaterStatus {
  return {
    updater: "0.2.0",
    mode: "host",
    channel: "stable",
    channelLocked: null,
    installed: "0.2.0",
    available: {
      version: "0.2.1",
      preview: false,
      publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      url: "https://github.com/meldgrove/helpdesk/releases/tag/v0.2.1",
      notes: ["Fix the board filters", "Show who changed a ticket"],
      changes: 12,
      installsAt: new Date(Date.now() + 86_400_000).toISOString(),
      failed: null,
    },
    attention: null,
    installing: null,
    last: null,
    checking: false,
    checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    error: null,
    automatic: true,
    cooldown: "3d",
    window: "02:00-05:00",
    timezone: "UTC",
    ...overrides,
  };
}

const answer = (updater: UpdaterStatus | null, error: string | null = null): UpdatesResponse => ({
  app: { version: "0.2.0" },
  reachable: updater !== null,
  updater,
  error,
});

type Route = (
  method: string,
  path: string,
  body: unknown,
) => { status?: number; body: unknown } | Error | undefined;

/** Stubs fetch by route (an Error: no answer); /auth-config is answered for every test. */
function routeFetch(route: Route) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace(/^\/api\/v1/, "").split("?")[0]!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply =
      path === "/auth-config"
        ? { body: { appName: "Helpdesk", providerName: "Keycloak" } }
        : (route(method, path, body) ?? {
            status: 404,
            body: { error: { code: "not_found", message: "Not found" } },
          });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const calls = (mock: ReturnType<typeof routeFetch>) =>
  mock.mock.calls
    .map(([url, init]) => `${init?.method ?? "GET"} ${url}`)
    .filter((call) => !call.endsWith("/auth-config"));

function renderButton() {
  return renderWithProviders(
    <TooltipProvider>
      <UpdateButton />
    </TooltipProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

const stored = () => JSON.parse(window.sessionStorage.getItem("helpdesk.updates.installing") ?? "null");

async function confirmInstall(button: string, action: string) {
  await userEvent.click(await screen.findByRole("button", { name: button }));
  await userEvent.click(await screen.findByRole("button", { name: action }));
  await userEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
}

describe("UpdateButton", () => {
  it("shows an available update and installs it after confirming", async () => {
    let current = status();
    const fetch = routeFetch((method, path, body) => {
      if (method === "GET" && path === "/updates") return { body: answer(current) };
      if (method === "POST" && path === "/updates/install") {
        expect(body).toEqual({ version: "0.2.1" });
        current = status({
          installing: {
            version: "0.2.1",
            startedAt: new Date().toISOString(),
            manual: true,
            stage: "pulling",
          },
        });
        return { status: 202, body: answer(current) };
      }
    });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByText("Update available")).toBeInTheDocument();
    expect(within(popover).getByText(/0\.2\.1 · 2 days ago/)).toBeInTheDocument();
    expect(within(popover).getByText("Show who changed a ticket")).toBeInTheDocument();
    expect(within(popover).getByText("and 10 more changes")).toBeInTheDocument();
    expect(within(popover).getByRole("link", { name: /Release notes/ })).toHaveAttribute("target", "_blank");
    expect(within(popover).getByText(/^Installs automatically on /)).toBeInTheDocument();
    expect(within(popover).getByText("Installed: 0.2.0 · Stable")).toBeInTheDocument();
    expect(within(popover).getByText("Checked 5 minutes ago")).toBeInTheDocument();

    await userEvent.click(within(popover).getByRole("button", { name: "Install now" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Install 0.2.1 now?")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Helpdesk restarts and is unavailable for a moment. Database changes run automatically.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Install" }));

    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(calls(fetch)).toContain("POST /api/v1/updates/install");
    expect(JSON.parse(window.sessionStorage.getItem("helpdesk.updates.installing")!)).toMatchObject({
      version: "0.2.1",
      fromVersion: "0.2.0",
    });
  });

  it("shows the error of a failed check instead of up to date", async () => {
    const error = vi.spyOn(toast, "error");
    routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status({ available: null })) };
      if (path === "/updates/check")
        return { body: answer(status({ available: null, error: "registry down" })) };
    });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Up to date · 0.2.0" }));

    expect(
      await screen.findByRole("button", { name: "The check failed: registry down" }),
    ).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("The check failed: registry down");
  });

  it("checks on click when up to date", async () => {
    const fetch = routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status({ available: null })) };
      if (path === "/updates/check") return { body: answer(status({ available: null })) };
    });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Up to date · 0.2.0" }));

    await waitFor(() => expect(calls(fetch)).toContain("POST /api/v1/updates/check"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains a failed installation", async () => {
    routeFetch(() => ({
      body: answer(
        status({
          available: { ...status().available!, failed: "migrate failed", installsAt: null },
          last: {
            version: "0.2.1",
            result: "rolled-back",
            message: 'service "migrate" didn\'t complete successfully: exit 1. 0.2.0 runs again.',
            finishedAt: new Date().toISOString(),
          },
        }),
      ),
    }));
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update to 0.2.1 failed" }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByText(/didn't complete successfully/)).toBeInTheDocument();
    expect(within(popover).getByText("0.2.0 is still running.")).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows why an installation it follows failed, before the offer says so", async () => {
    const attention = { ...status().available!, version: "0.3.0", installsAt: null };
    let current = status({ available: null, attention });
    routeFetch((method, path) => {
      if (method === "GET" && path === "/updates") return { body: answer(current) };
      if (method === "POST" && path === "/updates/install") {
        const startedAt = new Date().toISOString();
        const accepted = answer(
          status({
            available: null,
            attention,
            installing: { version: "0.3.0", startedAt, manual: true, stage: "requested" },
          }),
        );
        // The next status: rolled back, and the offer does not say so yet.
        current = status({
          available: null,
          attention,
          last: {
            version: "0.3.0",
            result: "rolled-back",
            message: "migrate failed. 0.2.0 runs again.",
            finishedAt: new Date(Date.now() + 1_000).toISOString(),
          },
        });
        return { status: 202, body: accepted };
      }
    });
    renderButton();

    await confirmInstall("0.3.0 needs upgrade steps", "Install anyway…");

    const popover = await screen.findByRole("dialog", undefined, { timeout: 5_000 });
    expect(within(popover).getByText("Update to 0.3.0 failed")).toBeInTheDocument();
    expect(within(popover).getByText("migrate failed. 0.2.0 runs again.")).toBeInTheDocument();
    await userEvent.click(within(popover).getByRole("button", { name: "Try again" }));
    expect(
      within(await screen.findByRole("alertdialog")).getByText("Install 0.3.0 without its upgrade steps?"),
    ).toBeInTheDocument();
    expect(stored()).toBeNull();
  });

  it("explains that the image tag does not reach a release with upgrade steps", async () => {
    const attention = { ...status().available!, version: "0.3.0", installsAt: null };
    routeFetch(() => ({
      body: answer(
        status({ mode: "platform", channelLocked: "The tag decides.", available: null, attention }),
      ),
    }));
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "0.3.0 needs upgrade steps" }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).queryByRole("button", { name: "Install anyway…" })).toBeNull();
    expect(
      within(popover).getByText(
        "The image tag set where Helpdesk is deployed does not reach 0.3.0. Take the upgrade steps, then change the tag there.",
      ),
    ).toBeInTheDocument();
  });

  it("asks before installing an update that needs upgrade steps", async () => {
    const attention = { ...status().available!, version: "0.3.0", installsAt: null };
    routeFetch(() => ({ body: answer(status({ available: null, attention })) }));
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "0.3.0 needs upgrade steps" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install anyway…" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Install 0.3.0 without its upgrade steps?")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Release notes/ })).toBeInTheDocument();
  });

  it("shows the updater's refusal", async () => {
    routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status()) };
      if (path === "/updates/install")
        return { status: 409, body: answer(status(), "0.2.1 is not offered; check again.") };
    });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install now" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Update available · 0.2.1" })).toBeInTheDocument();
    expect(stored()).toBeNull();
  });

  it("follows the installation a refusal reports", async () => {
    const running = {
      version: "0.3.0",
      startedAt: new Date().toISOString(),
      manual: true,
      stage: "pulling",
    } as const;
    routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status()) };
      if (path === "/updates/install")
        return { status: 409, body: answer(status({ installing: running }), "An installation runs.") };
    });
    renderButton();

    await confirmInstall("Update available · 0.2.1", "Install now");

    expect(await screen.findByRole("button", { name: "Installing 0.3.0…" })).toBeInTheDocument();
    expect(stored()).toMatchObject({ version: "0.3.0", confirmed: true, serverStartedAt: running.startedAt });
  });

  it("keeps the attempt when the install request gets no answer", async () => {
    routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status()) };
      if (path === "/updates/install") return new TypeError("Failed to fetch");
    });
    renderButton();

    await confirmInstall("Update available · 0.2.1", "Install now");

    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: false, reason: "Failed to fetch" });
  });

  it("says when there is no update service", async () => {
    routeFetch(() => ({ body: answer(null, "The update service is not reachable.") }));
    renderButton();
    expect(
      await screen.findByRole("button", { name: "No update service. See the deployment guide." }),
    ).toBeInTheDocument();
  });

  it("says when updates are off", async () => {
    routeFetch(() => ({ body: answer(status({ mode: "off", automatic: false, available: null })) }));
    renderButton();
    expect(
      await screen.findByRole("button", { name: "Automatic updates are off on this server" }),
    ).toBeInTheDocument();
  });

  it("shows an update while updates are off, without installing it", async () => {
    routeFetch(() => ({ body: answer(status({ mode: "off", automatic: false })) }));
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByText("Fix the board filters")).toBeInTheDocument();
    expect(within(popover).getByRole("link", { name: /Release notes/ })).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: "Install now" })).toBeNull();
    expect(
      within(popover).getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            "Automatic updates are off on this server, so it cannot install from here. See the deployment guide.",
      ),
    ).toBeInTheDocument();
    expect(within(popover).getByRole("link", { name: "deployment guide" })).toHaveAttribute(
      "href",
      expect.stringContaining("docs/deployment.md"),
    );
  });

  it("keeps waiting for an installation after a reload", async () => {
    window.sessionStorage.setItem(
      "helpdesk.updates.installing",
      JSON.stringify({
        version: "0.2.1",
        startedAt: Date.now(),
        confirmed: true,
        serverStartedAt: null,
        reason: null,
        fromVersion: "0.2.0",
        outage: true,
      }),
    );
    routeFetch(() => ({ body: answer(status()) }));
    renderButton();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
  });

  it("stops waiting after 15 minutes on request", async () => {
    window.sessionStorage.setItem(
      "helpdesk.updates.installing",
      JSON.stringify({
        version: "0.2.1",
        startedAt: Date.now() - 16 * 60_000,
        confirmed: true,
        serverStartedAt: null,
        reason: null,
        fromVersion: "0.2.0",
        outage: false,
      }),
    );
    routeFetch(() => ({ body: answer(status()) }));
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Installing 0.2.1…" }));
    const popover = await screen.findByRole("dialog");
    expect(await within(popover).findByText(/This takes longer than expected/)).toBeInTheDocument();
    await userEvent.click(within(popover).getByRole("button", { name: "Stop waiting" }));

    expect(await screen.findByRole("button", { name: "Update available · 0.2.1" })).toBeInTheDocument();
    expect(stored()).toBeNull();
  });
});

describe("UpdatesPage", () => {
  it("shows the version and switches the channel", async () => {
    let current = status();
    const fetch = routeFetch((method, path, body) => {
      if (path === "/updates") return { body: answer(current) };
      if (path === "/updates/channel") {
        expect(body).toEqual({ channel: "preview" });
        current = status({ channel: "preview", cooldown: null });
        return { body: answer(current) };
      }
    });
    renderWithProviders(<UpdatesPage />);

    expect(await screen.findByText("Update available · 0.2.1")).toBeInTheDocument();
    expect(
      screen.getByText("On: releases install automatically after 3 days, between 02:00 and 05:00 (UTC)."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Releases. Updates that need no action install automatically after 3 days."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Stable \(recommended\)/ })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: /Preview/ }));

    await waitFor(() => expect(calls(fetch)).toContain("POST /api/v1/updates/channel"));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Preview/ })).toBeChecked());
    expect(
      screen.getByText("On: updates install automatically within the hour, between 02:00 and 05:00 (UTC)."),
    ).toBeInTheDocument();
  });

  it("names a failed update", async () => {
    routeFetch(() => ({
      body: answer(
        status({
          available: { ...status().available!, failed: "migrate failed" },
          last: {
            version: "0.2.1",
            result: "failed",
            message: "migrate failed",
            finishedAt: new Date().toISOString(),
          },
        }),
      ),
    }));
    renderWithProviders(<UpdatesPage />);

    expect(await screen.findByText("Update to 0.2.1 failed")).toBeInTheDocument();
  });

  it("says when the updater did not save the channel", async () => {
    const error = vi.spyOn(toast, "error");
    routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status()) };
      if (path === "/updates/channel") return { body: answer(status()) };
    });
    renderWithProviders(<UpdatesPage />);

    await userEvent.click(await screen.findByRole("radio", { name: /Preview/ }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("The update service did not save the channel. Check again later."),
    );
    expect(screen.getByRole("radio", { name: /Stable/ })).toBeChecked();
  });

  it("disables the channel with the reason when it is locked", async () => {
    const reason = "The platform's image tag latest decides which updates install. Change it there.";
    routeFetch(() => ({ body: answer(status({ mode: "platform", channelLocked: reason })) }));
    renderWithProviders(<UpdatesPage />);

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Preview/ })).toBeDisabled();
    expect(screen.getByText(/The platform installs them \(deploy link\)\.$/)).toBeInTheDocument();
  });

  it("explains an unreachable update service", async () => {
    routeFetch(() => ({
      body: { ...answer(null, "The update service is not reachable."), app: { version: null } },
    }));
    renderWithProviders(<UpdatesPage />);

    expect(
      await screen.findByText(/The update service is not reachable\. Automatic updates need/),
    ).toBeInTheDocument();
    expect(screen.getByText("development")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Stable/ })).toBeDisabled();
    expect(screen.getByRole("link", { name: /deployment guide/ })).toHaveAttribute(
      "href",
      expect.stringContaining("docs/deployment.md#automatic-updates"),
    );
  });
});
