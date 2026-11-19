import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatesResponse, UpdaterStatus } from "@helpdesk/shared/api/updates";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithProviders } from "@/test-utils";
import { updatesKey } from "./api";
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

type Reply = { status?: number; body?: unknown; text?: string; contentType?: string };
type Answer = Reply | Response | Error | undefined;
type Route = (method: string, path: string, body: unknown) => Answer | Promise<Answer>;

/**
 * Stubs fetch by route (an Error: no answer; a promise: an answer that comes
 * later or never; a Response: as it is); /auth-config is answered for every test.
 */
function routeFetch(route: Route) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace(/^\/api\/v1/, "").split("?")[0]!;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply =
      path === "/auth-config"
        ? { body: { appName: "Helpdesk", providerName: "Keycloak" } }
        : ((await route(method, path, body)) ?? {
            status: 404,
            body: { error: { code: "not_found", message: "Not found" } },
          });
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return new Response(reply.text ?? JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": reply.contentType ?? "application/json" },
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

const stored = () => JSON.parse(window.sessionStorage.getItem("helpdesk.updates.installing") ?? "null");

/** Fake timers that also run on their own, for Testing Library's waiting. */
function fakeClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

async function confirmInstall(button: string, action: string, user: Pick<UserEvent, "click"> = userEvent) {
  await user.click(await screen.findByRole("button", { name: button }));
  await user.click(await screen.findByRole("button", { name: action }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
}

/** An attempt remembered by an earlier page load. */
function storeAttempt(overrides: Record<string, unknown> = {}) {
  window.sessionStorage.setItem(
    "helpdesk.updates.installing",
    JSON.stringify({
      version: "0.2.1",
      startedAt: Date.now(),
      confirmed: true,
      serverStartedAt: null,
      reason: null,
      fromVersion: "0.2.0",
      outage: false,
      ...overrides,
    }),
  );
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

  it("follows an installation the updater accepted, also when its answer cannot be read", async () => {
    routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status()) };
      if (path === "/updates/install") return { status: 202, text: "{", contentType: "text/plain" };
    });
    renderButton();

    await confirmInstall("Update available · 0.2.1", "Install now");

    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: true });
  });

  it("follows an installation the updater accepted, also when reading its answer fails", async () => {
    routeFetch((method, path) => {
      if (path === "/updates") return { body: answer(status()) };
      if (path === "/updates/install") {
        const broken = new ReadableStream({
          start: (stream) => stream.error(new TypeError("Connection lost")),
        });
        return new Response(broken, { status: 202, headers: { "content-type": "application/json" } });
      }
    });
    renderButton();

    await confirmInstall("Update available · 0.2.1", "Install now");

    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: true });
  });

  describe("an attempt without a clear answer", () => {
    /** The install request gets no answer; from then on, status requests get `poll`. */
    function unclearInstall(poll: Route) {
      let sent = false;
      return routeFetch((method, path, body) => {
        if (method === "POST" && path === "/updates/install") {
          sent = true;
          return new TypeError("Failed to fetch");
        }
        if (path === "/updates") return sent ? poll(method, path, body) : { body: answer(status()) };
      });
    }

    it("could not be confirmed after 60 s while every status request fails", async () => {
      const user = fakeClock();
      const error = vi.spyOn(toast, "error");
      unclearInstall(() => new TypeError("Network is down"));
      renderButton();

      await confirmInstall("Update available · 0.2.1", "Install now", user);
      await act(() => vi.advanceTimersByTimeAsync(4_000));
      expect(stored()).toMatchObject({ confirmed: false, outage: true });
      await act(() => vi.advanceTimersByTimeAsync(51_000));
      expect(error).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(5_000));

      expect(error).toHaveBeenCalledWith("The installation could not be confirmed: Network is down");
      expect(stored()).toBeNull();
      expect(await screen.findByRole("button", { name: "Update available · 0.2.1" })).toBeInTheDocument();
    });

    it("takes no status requested before the install request answered as proof that it did not start", async () => {
      const user = fakeClock();
      const error = vi.spyOn(toast, "error");
      let gets = 0;
      let answerInstall: (() => void) | undefined;
      let deliverEarly: ((reply: Reply) => void) | undefined;
      routeFetch((method, path) => {
        if (method === "POST" && path === "/updates/install") {
          // Answers (without a clear answer) only once the first status poll is under way.
          return new Promise<Answer>((resolve) => {
            answerInstall = () => resolve(new TypeError("Failed to fetch"));
            if (gets >= 2) answerInstall();
          });
        }
        if (path !== "/updates") return;
        gets += 1;
        if (gets === 1) return { body: answer(status()) }; // the page load
        if (gets === 2) {
          // Requested before the install request answered; its answer arrives afterwards.
          answerInstall?.();
          return new Promise<Answer>((resolve) => (deliverEarly = resolve));
        }
        return new TypeError("Network is down");
      });
      renderButton();

      await confirmInstall("Update available · 0.2.1", "Install now", user);
      await waitFor(() => expect(stored()).toMatchObject({ confirmed: false, reason: "Failed to fetch" }));
      await act(async () => deliverEarly!({ body: answer(status()) }));
      await act(() => vi.advanceTimersByTimeAsync(4_000));
      expect(stored()).toMatchObject({ confirmed: false, answered: false });
      await act(() => vi.advanceTimersByTimeAsync(60_000));

      expect(error).toHaveBeenCalledWith("The installation could not be confirmed: Network is down");
    });

    it("ends after 60 s also while a status request never returns", async () => {
      const user = fakeClock();
      const error = vi.spyOn(toast, "error");
      unclearInstall(() => new Promise<never>(() => {}));
      renderButton();

      await confirmInstall("Update available · 0.2.1", "Install now", user);
      await act(() => vi.advanceTimersByTimeAsync(60_000));

      expect(error).toHaveBeenCalledWith("The installation could not be confirmed: Failed to fetch");
      expect(stored()).toBeNull();
    });

    it("did not start when the updater answered without it", async () => {
      const user = fakeClock();
      const error = vi.spyOn(toast, "error");
      unclearInstall(() => ({ body: answer(status()) }));
      renderButton();

      await confirmInstall("Update available · 0.2.1", "Install now", user);
      await act(() => vi.advanceTimersByTimeAsync(60_000));

      expect(error).toHaveBeenCalledWith("The installation did not start: Failed to fetch");
      expect(stored()).toBeNull();
    });
  });

  it("stops every automatic status request at a sign-in page and keeps the attempt", async () => {
    fakeClock();
    storeAttempt();
    const fetch = routeFetch((method, path) => {
      if (path === "/updates")
        return { text: "<!doctype html><title>Sign in</title>", contentType: "text/html" };
    });
    renderButton();

    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    await waitFor(() => expect(calls(fetch)).toHaveLength(2)); // the page load and the first poll
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(calls(fetch)).toHaveLength(2);
    expect(stored()).toMatchObject({ version: "0.2.1" });
    act(() => focusManager.setFocused(undefined));
  });

  it("stops its automatic status requests at a sign-in page, also without an installation", async () => {
    fakeClock();
    const fetch = routeFetch((method, path) => {
      if (path === "/updates")
        return { text: "<!doctype html><title>Sign in</title>", contentType: "text/html" };
    });
    renderButton();

    expect(
      await screen.findByRole("button", { name: "No update service. See the deployment guide." }),
    ).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(calls(fetch)).toEqual(["GET /api/v1/updates"]);
    act(() => focusManager.setFocused(undefined));
  });

  it("stops every status observer of the page, also later ones, once the install watch finds a sign-in page", async () => {
    fakeClock();
    storeAttempt();
    let signedIn = true;
    const fetch = routeFetch((method, path) => {
      if (path !== "/updates") return;
      return signedIn
        ? { body: answer(status()) }
        : { text: "<!doctype html><title>Sign in</title>", contentType: "text/html" };
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const page = (later: boolean) => (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <UpdateButton />
          <UpdatesPage />
          {later ? <UpdatesPage /> : null}
        </TooltipProvider>
      </QueryClientProvider>
    );
    const view = render(page(false));

    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    signedIn = false;
    // The install watch's next poll finds the sign-in page.
    await act(() => vi.advanceTimersByTimeAsync(2_500));
    const requests = calls(fetch).length;
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    view.rerender(page(true));
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(calls(fetch)).toHaveLength(requests);
    expect(stored()).toMatchObject({ version: "0.2.1" });
    act(() => focusManager.setFocused(undefined));
  });

  it("keeps an unclear attempt past its deadline once another request finds a sign-in page", async () => {
    const user = fakeClock();
    const error = vi.spyOn(toast, "error");
    storeAttempt({ confirmed: false, reason: "Failed to fetch" });
    const fetch = routeFetch((method, path) => {
      // The install watch's status request stays under way.
      if (path === "/updates") return new Promise<never>(() => {});
      if (path === "/updates/check")
        return { text: "<!doctype html><title>Sign in</title>", contentType: "text/html" };
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(updatesKey, answer(status()));
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <UpdateButton />
          <UpdatesPage />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    await waitFor(() => expect(calls(fetch)).toContain("GET /api/v1/updates"));
    // The Updates page's check finds the sign-in page while the watch's request is under way.
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Sign in again."));
    await act(() => vi.advanceTimersByTimeAsync(61_000));

    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: false });
    expect(error).not.toHaveBeenCalledWith(expect.stringMatching(/^The installation/));
    expect(calls(fetch).filter((call) => call === "GET /api/v1/updates")).toHaveLength(1);
  });

  it("does not follow the installation again after Stop waiting while the updater is away", async () => {
    const startedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    storeAttempt({ startedAt: Date.now() - 16 * 60_000, serverStartedAt: startedAt });
    let back = false;
    const running = { version: "0.2.1", startedAt, manual: true, stage: "starting" } as const;
    routeFetch((method, path) => {
      if (path === "/updates" || path === "/updates/check")
        return { body: back ? answer(status({ installing: running })) : answer(null, "No connection.") };
    });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Restarting…" }));
    const popover = await screen.findByRole("dialog");
    await userEvent.click(await within(popover).findByRole("button", { name: "Stop waiting" }));
    expect(stored()).toBeNull();

    // The updater is back and still reports that installation.
    back = true;
    await userEvent.click(
      await screen.findByRole("button", { name: "No update service. See the deployment guide." }),
    );
    const button = await screen.findByRole("button", { name: "Installing 0.2.1…" });
    // The popover stayed open from Stop waiting.
    if (button.getAttribute("aria-expanded") !== "true") await userEvent.click(button);

    expect(stored()).toBeNull();
    const shown = await screen.findByRole("dialog");
    expect(within(shown).getByText("Installing 0.2.1…")).toBeInTheDocument();
    expect(within(shown).queryByText(/This page reloads/)).toBeNull();
    expect(within(shown).queryByRole("button", { name: "Stop waiting" })).toBeNull();
  });

  it("shows a newer offer over an earlier failure, with the failure as a line", async () => {
    routeFetch(() => ({
      body: answer(
        status({
          available: { ...status().available!, version: "0.2.2" },
          last: {
            version: "0.2.1",
            result: "rolled-back",
            message: "migrate failed. 0.2.0 runs again.",
            finishedAt: new Date().toISOString(),
          },
        }),
      ),
    }));
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.2" }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByText("0.2.1 failed: migrate failed. 0.2.0 runs again.")).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Install now" })).toBeInTheDocument();
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
