"use strict";

// One-way Slack notifier. Unlike the Feishu approval client this holds NO
// persistent connection: Incoming Webhooks (and chat.postMessage) are stateless
// HTTP, so the "client" just reads the current config/secrets on each send.
//
// It plugs into two existing seams:
//   - onSnapshot(snapshot): driven off main.js broadcastSessionSnapshot, same as
//     the Telegram companion — one ping per session that reaches a done/
//     interrupted badge on a completion event (deduped by id:rawEvent:at).
//   - notifyPermissionRequest(payload): a read-only heads-up when a gated tool
//     needs approval. Slack cannot resolve the approval here (that needs Socket
//     Mode); `supportsApproval` is the flag a future interactive client flips.
//
// Every path is best-effort: sends are fire-and-forget on the sync broadcast
// path, never throw, and degrade to { ok: false, errorClass } when unconfigured
// or when the network fails.

const settings = require("./slack-notify-settings");
const {
  buildCompletionMessage,
  buildPermissionMessage,
  buildTestMessage,
} = require("./slack-message-format");

const DONE_BADGES = new Set(["done", "interrupted"]);
const COMPLETION_EVENTS = new Set(["Stop", "StopFailure", "ApiError", "event_msg:task_complete"]);
const CHAT_POST_URL = "https://slack.com/api/chat.postMessage";
const DEFAULT_TIMEOUT_MS = 10000;

function dedupeKey(entry) {
  const le = entry && entry.lastEvent;
  return `${entry.id}:${le ? le.rawEvent : ""}:${le ? le.at : ""}`;
}

function isCompletion(entry) {
  if (!entry || !DONE_BADGES.has(entry.badge)) return false;
  const le = entry.lastEvent;
  return !!(le && COMPLETION_EVENTS.has(le.rawEvent));
}

function classifyHttpStatus(status) {
  if (status === 429) return "rate-limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  return `http-${status}`;
}

// Cards ship as a coloured attachment so Slack frames each message. Note that
// top-level `text` is NOT a silent fallback once attachments are present —
// Slack renders it as the message body above the attachment, so sending both
// shows the title twice. The plain-text summary that drives notifications goes
// in the attachment's `fallback` instead.
//
// `fallback` is documented as plain text, but a probe against a real workspace
// showed Slack still parses control sequences there (a <url|label> arrived
// clickable), so it keeps the escaped string: mention syntax in a session title
// must not survive into the notification either.
//
// A caller may still build an unframed message; blocks then own the render and
// top-level text goes back to being a true fallback.
function toWireBody(message) {
  const body = {};
  if (Array.isArray(message.attachments)) {
    body.attachments = message.attachments.map((attachment, i) => (
      i === 0 && message.text && !attachment.fallback
        ? { ...attachment, fallback: message.text }
        : attachment
    ));
  } else if (message.text) {
    body.text = message.text;
  }
  if (Array.isArray(message.blocks)) body.blocks = message.blocks;
  return body;
}

function createSlackNotifyClient({
  getConfig = () => settings.cloneDefaultSlackNotify(),
  getSecrets = () => ({ webhookUrl: "", botToken: "" }),
  getLang = () => "en",
  log = () => {},
  fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const lastNotified = new Map(); // session id -> last dedupe key
  let primed = false;

  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function readConfig() {
    try { return settings.normalizeSlackNotify(getConfig()); } catch { return settings.cloneDefaultSlackNotify(); }
  }
  function readSecrets() {
    try {
      const value = getSecrets() || {};
      return { webhookUrl: value.webhookUrl || "", botToken: value.botToken || "" };
    } catch {
      return { webhookUrl: "", botToken: "" };
    }
  }
  function readLang() {
    try {
      const value = getLang();
      return typeof value === "string" && value ? value : "en";
    } catch { return "en"; }
  }

  function isEnabled() {
    return readConfig().enabled === true;
  }

  function describeReadiness() {
    return settings.readiness(readConfig(), readSecrets());
  }

  function isReady() {
    return describeReadiness().ready === true;
  }

  function getStatus() {
    const config = readConfig();
    const secrets = readSecrets();
    const ready = settings.readiness(config, secrets);
    return {
      enabled: config.enabled === true,
      configured: !!(secrets.webhookUrl || secrets.botToken),
      ready: ready.ready === true,
      reason: ready.ready ? "ready" : ready.reason,
      transport: ready.transport || null,
      supportsApproval,
    };
  }

  function resolveFetch() {
    if (typeof fetchImpl === "function") return fetchImpl;
    if (typeof fetch === "function") return fetch;
    return null;
  }

  async function postJson(url, headers, bodyObject) {
    const doFetch = resolveFetch();
    if (!doFetch) return { ok: false, errorClass: "no-transport" };
    let controller = null;
    let timer = null;
    if (typeof AbortController === "function" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
        body: JSON.stringify(bodyObject),
        // The webhook host is pinned to hooks.slack.com, but a redirect would
        // let the response move the request (and, for the bot transport, the
        // Authorization header) to an arbitrary host. Slack never redirects
        // these endpoints, so treat one as a hard failure instead of following.
        redirect: "error",
        signal: controller ? controller.signal : undefined,
      });
      const status = res && typeof res.status === "number" ? res.status : 0;
      let bodyText = "";
      try { bodyText = typeof res.text === "function" ? await res.text() : ""; } catch { bodyText = ""; }
      return { ok: !!(res && res.ok), status, bodyText };
    } catch (err) {
      const aborted = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
      return { ok: false, errorClass: aborted ? "timeout" : "network", error: err && err.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Send a { text, blocks } message via whichever transport the config resolves
  // to. Returns { ok, errorClass?, messageId? } and never throws.
  async function sendMessage(message) {
    if (!message || (!message.text && !Array.isArray(message.blocks) && !Array.isArray(message.attachments))) {
      return { ok: false, errorClass: "empty-message" };
    }
    const config = readConfig();
    const secrets = readSecrets();
    const ready = settings.readiness(config, secrets);
    if (!ready.ready) return { ok: false, errorClass: ready.reason || "not-configured" };

    const wire = toWireBody(message);

    if (ready.transport === "webhook") {
      const res = await postJson(secrets.webhookUrl, {}, wire);
      if (res.errorClass) return { ok: false, errorClass: res.errorClass, error: res.error };
      // Incoming webhooks answer 200 with the literal body "ok" on success.
      if (res.ok) return { ok: true };
      return { ok: false, errorClass: classifyHttpStatus(res.status), detail: (res.bodyText || "").slice(0, 200) };
    }

    // Bot transport: chat.postMessage. Errors surface in the JSON body, not the
    // HTTP status, so a 200 with { ok: false } is still a failure.
    const res = await postJson(
      CHAT_POST_URL,
      { authorization: `Bearer ${secrets.botToken}` },
      { channel: config.channelId, ...wire },
    );
    if (res.errorClass) return { ok: false, errorClass: res.errorClass, error: res.error };
    let parsed = null;
    try { parsed = res.bodyText ? JSON.parse(res.bodyText) : null; } catch { parsed = null; }
    if (parsed && parsed.ok === true) return { ok: true, messageId: parsed.ts };
    if (parsed && parsed.ok === false) return { ok: false, errorClass: `slack-${parsed.error || "error"}` };
    if (!res.ok) return { ok: false, errorClass: classifyHttpStatus(res.status) };
    return { ok: false, errorClass: "bad-response" };
  }

  // Completion pings off the snapshot fanout. Sync + fire-and-forget + never
  // throw (mirrors telegram-companion). First snapshot only primes the dedupe
  // map so enabling later does not backfill old completions.
  function onSnapshot(snapshot) {
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const config = readConfig();
    const enabled = config.enabled === true;
    const priming = !primed;
    const seenIds = new Set();
    const toSend = [];

    for (const entry of sessions) {
      if (!entry || !entry.id) continue;
      seenIds.add(entry.id);
      if (!isCompletion(entry)) continue;
      const key = dedupeKey(entry);
      if (lastNotified.get(entry.id) === key) continue;
      lastNotified.set(entry.id, key);
      if (priming || !enabled) continue;
      // Per-event gating: "interrupted" is the error/aborted family.
      const interrupted = entry.badge === "interrupted";
      if (interrupted && !config.notifyOnError) continue;
      if (!interrupted && !config.notifyOnDone) continue;
      toSend.push(entry);
    }

    for (const id of Array.from(lastNotified.keys())) {
      if (!seenIds.has(id)) lastNotified.delete(id);
    }

    primed = true;
    if (!toSend.length) return;
    if (!isReady()) return;

    const lang = readLang();
    const includeOutput = config.outputMode === "full";
    for (const entry of toSend) {
      let message = null;
      try {
        message = buildCompletionMessage(entry, { lang, includeOutput, mentionUserId: config.mentionUserId });
      } catch (err) {
        safeLog("warn", "slack completion format threw", { id: entry.id, error: err && err.message });
        continue;
      }
      if (!message) continue;
      Promise.resolve()
        .then(() => sendMessage(message))
        .then((res) => {
          if (res && res.ok === false) {
            safeLog("warn", "slack completion notification not delivered", { id: entry.id, errorClass: res.errorClass });
          }
        })
        .catch((err) => {
          safeLog("warn", "slack completion notification threw", { id: entry.id, error: err && err.message });
        });
    }
  }

  // Read-only "permission needed" heads-up. Best-effort; returns a promise for
  // callers that want it but is safe to ignore.
  function notifyPermissionRequest(payload) {
    const config = readConfig();
    if (!config.enabled || !config.notifyOnPermission) return Promise.resolve({ ok: false, errorClass: "disabled" });
    if (!isReady()) return Promise.resolve({ ok: false, errorClass: "not-configured" });
    let message = null;
    try {
      message = buildPermissionMessage(payload, { lang: readLang(), mentionUserId: config.mentionUserId });
    } catch (err) {
      safeLog("warn", "slack permission format threw", { error: err && err.message });
      return Promise.resolve({ ok: false, errorClass: "format-error" });
    }
    return Promise.resolve()
      .then(() => sendMessage(message))
      .then((res) => {
        if (res && res.ok === false) {
          safeLog("warn", "slack permission notification not delivered", { errorClass: res.errorClass });
        }
        return res;
      })
      .catch((err) => {
        safeLog("warn", "slack permission notification threw", { error: err && err.message });
        return { ok: false, errorClass: "threw" };
      });
  }

  // Settings "send test" button. Surfaces a structured result the UI localizes.
  async function sendTest() {
    const ready = describeReadiness();
    if (!ready.ready) {
      return { status: "error", code: ready.reason || "not-configured", message: ready.message || "Slack notifications are not configured" };
    }
    let res;
    try {
      res = await sendMessage(buildTestMessage({
        lang: readLang(),
        mentionUserId: readConfig().mentionUserId,
      }));
    } catch (err) {
      return { status: "error", code: "threw", message: err && err.message };
    }
    if (res && res.ok) return { status: "ok", transport: ready.transport };
    return { status: "error", code: (res && res.errorClass) || "send-failed", message: (res && res.detail) || "Slack rejected the message" };
  }

  const supportsApproval = false;

  return {
    isEnabled,
    isReady,
    getStatus,
    onSnapshot,
    notifyPermissionRequest,
    sendMessage,
    sendTest,
    supportsApproval,
    _lastNotified: lastNotified,
  };
}

module.exports = {
  createSlackNotifyClient,
  isCompletion,
  dedupeKey,
  classifyHttpStatus,
  COMPLETION_EVENTS,
};
