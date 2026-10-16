/**
 * Slack (spec §11, §14, task 2.6): strict incoming-webhook validation, message
 * escaping, how Slack's answers are classified, the sender (timeout, never logs
 * the link, permanent 4xx kept + error stored, success clears it) and the
 * once-per-period send used by the Monday summary.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb, Row } from "./helpers/fake-prisma";

vi.mock("../app/db.server", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  const db = createFakePrisma({ ownerEmailLog: ["shop", "kind", "periodKey"] });
  return { default: db.client, __fake: db };
});

import * as dbModule from "../app/db.server";
import { normalizeSlackWebhook, slackErrorGroup, slackEscape, slackFailure, slackLink, buildSlackTest } from "../app/lib/slack-shared";
import { deliverSlack, deliverSlackOnce, postSlack } from "../app/services/slack.server";
import { encryptSecret } from "../app/lib/crypto.server";
import { readSettings } from "../app/lib/settings-shared";

const db = (dbModule as unknown as { __fake: FakeDb }).__fake;
const S = "acme.myshopify.com";
const HOOK = "https://hooks.slack.com/services/" + "T0ABCDEF1/B0ABCDEF2/abcdefghijklmnopqrstuvwx";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = "22".repeat(32);
});

// The fake's create doesn't enforce unique keys; OwnerEmailLog's (shop, kind, periodKey) is unique.
function enforceUniqueLog() {
  const model = db.client.ownerEmailLog as { create: (a: { data: Row }) => Promise<Row> };
  const create = model.create;
  model.create = async (args) => {
    const d = args.data;
    if ((db.tables.ownerEmailLog ?? []).some((r) => r.shop === d.shop && r.kind === d.kind && r.periodKey === d.periodKey))
      throw new Error("Unique constraint failed");
    return create({ data: { status: "SENT", error: null, ...d } });
  };
}

describe("normalizeSlackWebhook", () => {
  it("accepts a real incoming-webhook link (trimmed)", () => {
    expect(normalizeSlackWebhook(HOOK)).toBe(HOOK);
    expect(normalizeSlackWebhook(`  ${HOOK}\n`)).toBe(HOOK);
  });
  it.each([
    ["http", HOOK.replace("https:", "http:")],
    ["other host", HOOK.replace("hooks.slack.com", "hooks.slack.com.evil.test")],
    ["subdomain trick", HOOK.replace("hooks.slack.com", "evil.test/hooks.slack.com")],
    ["port", HOOK.replace("hooks.slack.com", "hooks.slack.com:8443")],
    ["user info", HOOK.replace("https://", "https://me@")],
    ["query", `${HOOK}?x=1`],
    ["fragment", `${HOOK}#x`],
    ["extra path", `${HOOK}/more`],
    ["workflow link", "https://hooks.slack.com/workflows/" + "T0ABCDEF1/A0ABCDEF2/123/abcdefghijklmnopqrstuvwx"],
    ["lowercase team id", HOOK.replace("T0ABCDEF1", "t0abcdef1")],
    ["short secret", "https://hooks.slack.com/services/" + "T0ABCDEF1/B0ABCDEF2/abc"],
    ["empty", ""],
  ])("rejects %s", (_name, url) => {
    expect(normalizeSlackWebhook(url)).toBeNull();
  });
});

describe("message helpers", () => {
  it("escapes mrkdwn control characters and keeps links intact", () => {
    expect(slackEscape("Tom & <Jerry>")).toBe("Tom &amp; &lt;Jerry&gt;");
    expect(slackLink("https://x.test/a?b=1|2", "Open > now")).toBe("<https://x.test/a?b=1%7C2|Open &gt; now>");
  });
  it("classifies Slack's answers", () => {
    expect(slackFailure(403, "invalid_token")).toEqual({ code: "invalid_token", permanent: true });
    expect(slackFailure(404, "channel_not_found")).toEqual({ code: "channel_not_found", permanent: true });
    expect(slackFailure(404, "<html>gone</html>")).toEqual({ code: "http_404", permanent: true });
    expect(slackFailure(410, "channel_is_archived")).toEqual({ code: "channel_is_archived", permanent: true });
    expect(slackFailure(429, "rate_limited")).toEqual({ code: "rate_limited", permanent: false });
    expect(slackFailure(500, "")).toEqual({ code: "http_500", permanent: false });
    expect(slackErrorGroup("invalid_token")).toBe("link");
    expect(slackErrorGroup("http_404")).toBe("link");
    expect(slackErrorGroup("channel_not_found")).toBe("channel");
    expect(slackErrorGroup("not_readable")).toBe("unreadable");
    expect(slackErrorGroup("invalid_payload")).toBe("other");
  });
  it("test message is translated and escaped", () => {
    expect(buildSlackTest("de", "A&B").text).toBe(
      "Keha Inventory Intelligence ist für A&amp;B verbunden. Die Montagsübersicht und dringende Bestandswarnungen erscheinen hier.",
    );
  });
});

// ---------------------------------------------------------------- sender

const fetchMock = vi.fn();
let logs: string[] = [];

beforeEach(() => {
  db.reset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  logs = [];
  for (const level of ["log", "warn", "error", "info"] as const)
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Never log the link (spec §14): it is a secret.
  expect(logs.join("\n")).not.toContain("hooks.slack.com/services");
  expect(logs.join("\n")).not.toContain("abcdefghijklmnopqrstuvwx");
});

const answer = (status: number, body = "") => new Response(body, { status });

describe("postSlack", () => {
  it("POSTs JSON with a timeout", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, "ok"));
    expect(await postSlack(HOOK, { text: "hi" })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ text: "hi" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("never posts to anything but a Slack webhook", async () => {
    expect(await postSlack("https://evil.test/x", { text: "hi" })).toEqual({ ok: false, code: "not_readable", permanent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("maps errors, timeouts and network failures", async () => {
    fetchMock.mockResolvedValueOnce(answer(404, "no_service"));
    expect(await postSlack(HOOK, { text: "x" })).toEqual({ ok: false, code: "no_service", permanent: true });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await postSlack(HOOK, { text: "x" })).toEqual({ ok: false, code: "timeout", permanent: false });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await postSlack(HOOK, { text: "x" })).toEqual({ ok: false, code: "network_error", permanent: false });
  });
});

function seedShop(alerts: Record<string, unknown> = {}) {
  db.tables.shop = [{ domain: S, settings: { leadTimeDays: 21, alerts: { slackWebhook: encryptSecret(HOOK), ...alerts } } }];
  return readSettings(db.tables.shop[0].settings);
}
const storedAlerts = () => readSettings(db.tables.shop[0].settings).alerts;

describe("deliverSlack", () => {
  it("not connected: skipped, nothing sent", async () => {
    db.tables.shop = [{ domain: S, settings: {} }];
    expect(await deliverSlack(S, readSettings({}), { text: "x" })).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a permanent 4xx keeps the link and stores the error; success clears it", async () => {
    const settings = seedShop();
    fetchMock.mockResolvedValueOnce(answer(403, "invalid_token"));
    const at = new Date("2026-10-16T09:00:00Z");
    expect(await deliverSlack(S, settings, { text: "x" }, at)).toEqual({ ok: false, code: "invalid_token", permanent: true });
    expect(storedAlerts().slackWebhook).toBe(settings.alerts.slackWebhook);
    expect(storedAlerts().slackError).toEqual({ code: "invalid_token", at: at.toISOString() });
    expect((db.tables.shop[0].settings as Row).leadTimeDays).toBe(21);

    fetchMock.mockResolvedValueOnce(answer(200, "ok"));
    expect(await deliverSlack(S, readSettings(db.tables.shop[0].settings), { text: "x" })).toEqual({ ok: true });
    expect(storedAlerts().slackError).toBeNull();
  });

  it("a temporary failure stores nothing", async () => {
    const settings = seedShop();
    fetchMock.mockResolvedValueOnce(answer(503, ""));
    expect(await deliverSlack(S, settings, { text: "x" })).toEqual({ ok: false, code: "http_503", permanent: false });
    expect(storedAlerts().slackError).toBeNull();
  });

  it("an unreadable stored link (key changed) is reported as such", async () => {
    db.tables.shop = [{ domain: S, settings: { alerts: { slackWebhook: "gcm:AAAA:BBBB:CCCC" } } }];
    expect(await deliverSlack(S, readSettings(db.tables.shop[0].settings), { text: "x" })).toEqual({
      ok: false,
      code: "not_readable",
      permanent: true,
    });
    expect(storedAlerts().slackError?.code).toBe("not_readable");
  });
});

describe("deliverSlackOnce (Monday summary)", () => {
  const key = { kind: "monday_slack", periodKey: "2026-W43" };
  const at = (iso: string) => new Date(iso);

  beforeEach(() => enforceUniqueLog());

  it("sends once per period", async () => {
    const settings = seedShop();
    fetchMock.mockResolvedValue(answer(200, "ok"));
    expect(await deliverSlackOnce(S, key, settings, { text: "x" }, at("2026-10-19T07:00:00Z"))).toBe("sent");
    expect(await deliverSlackOnce(S, key, settings, { text: "x" }, at("2026-10-19T09:00:00Z"))).toBe("skipped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a temporary failure once, an hour later", async () => {
    const settings = seedShop();
    fetchMock.mockResolvedValueOnce(answer(500, "")).mockResolvedValueOnce(answer(200, "ok"));
    expect(await deliverSlackOnce(S, key, settings, { text: "x" }, at("2026-10-19T07:00:00Z"))).toBe("failed");
    expect(await deliverSlackOnce(S, key, settings, { text: "x" }, at("2026-10-19T07:30:00Z"))).toBe("skipped");
    expect(await deliverSlackOnce(S, key, settings, { text: "x" }, at("2026-10-19T08:00:00Z"))).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.tables.ownerEmailLog).toEqual([expect.objectContaining({ status: "SENT", error: null })]);
  });

  it("a permanent failure is final for the period", async () => {
    const settings = seedShop();
    fetchMock.mockResolvedValue(answer(404, "channel_not_found"));
    expect(await deliverSlackOnce(S, key, settings, { text: "x" }, at("2026-10-19T07:00:00Z"))).toBe("failed");
    expect(await deliverSlackOnce(S, key, settings, { text: "x" }, at("2026-10-19T10:00:00Z"))).toBe("skipped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("not connected: no log row", async () => {
    db.tables.shop = [{ domain: S, settings: {} }];
    expect(await deliverSlackOnce(S, key, readSettings({}), { text: "x" })).toBe("skipped");
    expect(db.tables.ownerEmailLog ?? []).toEqual([]);
  });
});
