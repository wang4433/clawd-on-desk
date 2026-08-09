"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSlackNotifyClient, isCompletion, dedupeKey, classifyHttpStatus } = require("../src/slack-notify-client");

const WEBHOOK = "https://hooks.slack.com/services/T/B/xxx";

function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, headers: (opts && opts.headers) || {}, body, opts: opts || {} });
    return responder(url, opts);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function okWebhook() {
  return { ok: true, status: 200, text: async () => "ok" };
}

function baseClient(overrides = {}) {
  return createSlackNotifyClient({
    getConfig: () => ({
      enabled: true,
      channelId: "",
      notifyOnDone: true,
      notifyOnError: true,
      notifyOnPermission: true,
      outputMode: "off",
      ...overrides.config,
    }),
    getSecrets: () => ({ webhookUrl: WEBHOOK, botToken: "", ...overrides.secrets }),
    getLang: () => "en",
    fetchImpl: overrides.fetchImpl || makeFetch(okWebhook),
  });
}

test("isCompletion / dedupeKey gate on badge + completion event", () => {
  assert.ok(isCompletion({ id: "s", badge: "done", lastEvent: { rawEvent: "Stop", at: 1 } }));
  assert.ok(!isCompletion({ id: "s", badge: "thinking", lastEvent: { rawEvent: "Stop", at: 1 } }));
  assert.ok(!isCompletion({ id: "s", badge: "done", lastEvent: { rawEvent: "Random", at: 1 } }));
  assert.equal(dedupeKey({ id: "s", lastEvent: { rawEvent: "Stop", at: 5 } }), "s:Stop:5");
});

test("classifyHttpStatus maps common failures", () => {
  assert.equal(classifyHttpStatus(429), "rate-limited");
  assert.equal(classifyHttpStatus(403), "unauthorized");
  assert.equal(classifyHttpStatus(404), "not-found");
  assert.equal(classifyHttpStatus(500), "http-500");
});

test("getStatus reflects readiness and transport", () => {
  const client = baseClient();
  const s = client.getStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.configured, true);
  assert.equal(s.ready, true);
  assert.equal(s.transport, "webhook");
  assert.equal(s.supportsApproval, false);
});

test("sendTest posts a webhook payload and reports ok", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const res = await client.sendTest();
  assert.equal(res.status, "ok");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
  // The framing attachment has to survive to the wire, or Slack draws no
  // colour bar and every card runs into the next one.
  const sent = fetchImpl.calls[0].body;
  assert.ok(Array.isArray(sent.attachments), "attachments must be forwarded");
  assert.ok(Array.isArray(sent.attachments[0].blocks));
  assert.ok(sent.attachments[0].color);

  // Top-level `text` is NOT a silent fallback once attachments are present —
  // Slack renders it as the message body above the attachment, so sending both
  // prints the title twice. The summary belongs in the attachment's `fallback`.
  assert.equal(sent.text, undefined, "top-level text would render as a duplicate title");
  assert.ok(sent.attachments[0].fallback, "notifications still need a plain-text summary");
});

test("bot transport posts to chat.postMessage with auth + channel", async () => {
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "hi", blocks: [] });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, "1.2");
  const call = fetchImpl.calls[0];
  assert.ok(call.url.includes("chat.postMessage"));
  assert.equal(call.body.channel, "C99");
  assert.match(call.headers.authorization, /^Bearer xoxb-/);
});

test("chat.postMessage ok:false surfaces the slack error", async () => {
  const fetchImpl = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: "channel_not_found" }) }));
  const client = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "hi", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "slack-channel_not_found");
});

test("unconfigured client degrades without throwing", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = createSlackNotifyClient({
    getConfig: () => ({ enabled: true }),
    getSecrets: () => ({}),
    fetchImpl,
  });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "missing-secret");
  assert.equal(fetchImpl.calls.length, 0); // never hit the network
  const test = await client.sendTest();
  assert.equal(test.status, "error");
});

// A 3xx from either endpoint would otherwise move the request — and, on the bot
// transport, the Authorization header — to a host the webhook pin never vetted.
test("outbound requests refuse to follow redirects", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(fetchImpl.calls[0].opts.redirect, "error");

  const botFetch = makeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ts: "1.2" }) }));
  const bot = baseClient({
    config: { channelId: "C99" },
    secrets: { webhookUrl: "", botToken: "xoxb-123456789-abcdefghij" },
    fetchImpl: botFetch,
  });
  await bot.sendMessage({ text: "x", blocks: [] });
  assert.equal(botFetch.calls[0].opts.redirect, "error");
});

test("a redirect rejection is caught like any other transport failure", async () => {
  // What fetch actually does with redirect: "error" — reject, not resolve.
  const fetchImpl = makeFetch(() => { throw new TypeError("unexpected redirect"); });
  const client = baseClient({ fetchImpl });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "network");
});

test("network failure is caught and classified", async () => {
  const fetchImpl = makeFetch(() => { throw new Error("boom"); });
  const client = baseClient({ fetchImpl });
  const res = await client.sendMessage({ text: "x", blocks: [] });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "network");
});

test("onSnapshot primes on first call, then sends once per new event", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const snap = (at) => ({ sessions: [{ id: "s1", badge: "done", displayTitle: "T", lastEvent: { rawEvent: "Stop", at } }] });
  client.onSnapshot(snap(1)); // prime — no send
  client.onSnapshot(snap(1)); // same event — deduped
  client.onSnapshot(snap(2)); // new event — one send
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchImpl.calls.length, 1);
});

test("onSnapshot honors per-event gating", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ config: { notifyOnError: false }, fetchImpl });
  // prime with an unrelated running session so the map is primed
  client.onSnapshot({ sessions: [] });
  client.onSnapshot({ sessions: [{ id: "e1", badge: "interrupted", displayTitle: "T", lastEvent: { rawEvent: "ApiError", at: 1 } }] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchImpl.calls.length, 0); // error notifications disabled
});

test("notifyPermissionRequest respects the toggle and readiness", async () => {
  const fetchImpl = makeFetch(okWebhook);
  const client = baseClient({ fetchImpl });
  const res = await client.notifyPermissionRequest({ title: "needs you", toolName: "Bash" });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls.length, 1);

  const fetchImpl2 = makeFetch(okWebhook);
  const off = baseClient({ config: { notifyOnPermission: false }, fetchImpl: fetchImpl2 });
  const res2 = await off.notifyPermissionRequest({ title: "x" });
  assert.equal(res2.ok, false);
  assert.equal(fetchImpl2.calls.length, 0);
});
