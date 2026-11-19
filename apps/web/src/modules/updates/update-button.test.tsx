import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

type Route = (method: string, path: string, body: unknown) => { status?: number; body: unknown } | undefined;

/** Stubs fetch by route; /auth-config is answered for every test. */
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
  window.sessionStorage.clear();
});

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
    expect(screen.getByRole("button", { name: "Update available · 0.2.1" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("helpdesk.updates.installing")).toBeNull();
  });

  it("says when there is no update service", async () => {
    routeFetch(() => ({ body: answer(null, "The update service is not reachable.") }));
    renderButton();
    expect(
      await screen.findByRole("button", { name: "No update service. See the deployment guide." }),
    ).toBeInTheDocument();
  });

  it("says when updates are off", async () => {
    routeFetch(() => ({ body: answer(status({ mode: "off", automatic: false })) }));
    renderButton();
    expect(
      await screen.findByRole("button", { name: "Automatic updates are off on this server" }),
    ).toBeInTheDocument();
  });

  it("keeps waiting for an installation after a reload", async () => {
    window.sessionStorage.setItem(
      "helpdesk.updates.installing",
      JSON.stringify({
        version: "0.2.1",
        startedAt: Date.now(),
        fromVersion: "0.2.0",
        lastBefore: null,
        outage: true,
      }),
    );
    routeFetch(() => ({ body: answer(status()) }));
    renderButton();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
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
