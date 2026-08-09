"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const settings = require("../src/slack-notify-settings");

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-slack-notify-"));
  tempDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test("normalizeSlackNotify fills defaults and coerces types", () => {
  assert.deepEqual(settings.normalizeSlackNotify(undefined), {
    enabled: false,
    channelId: "",
    mentionUserId: "",
    notifyOnDone: true,
    notifyOnError: true,
    notifyOnPermission: true,
    outputMode: "off",
  });
  assert.deepEqual(settings.normalizeSlackNotify({
    enabled: true,
    channelId: "  C123  ",
    notifyOnDone: false,
    outputMode: "tail", // legacy alias -> full
  }), {
    enabled: true,
    channelId: "C123",
    mentionUserId: "",
    notifyOnDone: false,
    notifyOnError: true,
    notifyOnPermission: true,
    outputMode: "full",
  });
});

test("validateSlackNotify rejects unknown keys and bad types", () => {
  assert.equal(settings.validateSlackNotify({ enabled: false }).status, "ok");
  assert.equal(settings.validateSlackNotify({ enabled: "no" }).status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, nope: 1 }).status, "error");
  assert.equal(settings.validateSlackNotify({ enabled: false, outputMode: "tail" }).status, "error");
  assert.equal(settings.validateSlackNotify("x").status, "error");
});

test("isValidWebhookUrl pins the Slack host over https", () => {
  assert.ok(settings.isValidWebhookUrl("https://hooks.slack.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("http://hooks.slack.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("https://evil.example.com/services/T/B/xxx"));
  assert.ok(!settings.isValidWebhookUrl("not a url"));
  assert.ok(!settings.isValidWebhookUrl(""));
});

// The host check must be equality, never "contains"/"endsWith" — each of these
// would slip past a sloppier match and send the webhook body to someone else.
test("isValidWebhookUrl rejects hosts that merely look like the Slack host", () => {
  for (const url of [
    "https://hooks.slack.com.evil.com/x",       // real host as a prefix label
    "https://evil-slack.com/x",                 // suffix confusion: ...-slack.com
    "https://hooks-slack.com/x",                // dash instead of the dot
    "https://evil.com/hooks.slack.com/x",       // real host in the path
    "https://notthehooks.slack.com/x",          // different subdomain
    "https://hooks.slack.com.co/x",             // different TLD
    "https://hooks.slack.com@evil.com/x",       // userinfo trick: host is evil.com
    "https://evil.com#hooks.slack.com",         // real host in the fragment
    "https://evil.com?x=hooks.slack.com",       // real host in the query
  ]) {
    assert.ok(!settings.isValidWebhookUrl(url), `must reject ${url}`);
  }
});

// The settings field is labelled "Bot token", so only xoxb- is honored. User
// (xoxp-) and app-config (xoxe-) tokens carry broader authority than the
// chat:write scope this feature needs and are rejected outright.
test("isValidBotToken accepts xoxb- bot tokens only", () => {
  assert.equal(settings.BOT_TOKEN_PREFIX, "xoxb-");
  assert.ok(settings.isValidBotToken("xoxb-123456789-abcdefghij"));
  assert.ok(settings.isValidBotToken("  xoxb-123456789-abcdefghij  ")); // trimmed
  assert.ok(!settings.isValidBotToken("xoxp-123456789-abcdefghij"));
  assert.ok(!settings.isValidBotToken("xoxe-123456789-abcdefghij"));
  assert.ok(!settings.isValidBotToken("xoxr-123"));
  assert.ok(!settings.isValidBotToken("xoxb-short"));
  assert.ok(!settings.isValidBotToken("https://hooks.slack.com/services/T/B/x"));
  assert.ok(!settings.isValidBotToken(""));
});

test("a user token in the bot-token field never resolves a transport", () => {
  const userToken = "xoxp-123456789-abcdefghij";
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { botToken: userToken }), null);
  const ready = settings.readiness({ enabled: true, channelId: "C1" }, { botToken: userToken });
  assert.equal(ready.ready, false);
  assert.equal(ready.reason, "invalid-secret");
  assert.match(ready.message, /xoxb-/);
});

test("resolveSlackTransport prefers webhook, falls back to bot+channel", () => {
  const webhook = "https://hooks.slack.com/services/T/B/xxx";
  const bot = "xoxb-123456789-abcdefghij";
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { webhookUrl: webhook, botToken: bot }), "webhook");
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, { botToken: bot }), "bot");
  assert.equal(settings.resolveSlackTransport({ channelId: "" }, { botToken: bot }), null); // bot without channel
  assert.equal(settings.resolveSlackTransport({ channelId: "C1" }, {}), null);
});

test("readiness reports the right stable reason at each stage", () => {
  const webhook = "https://hooks.slack.com/services/T/B/xxx";
  assert.equal(settings.readiness({ enabled: false }, { webhookUrl: webhook }).reason, "disabled");
  assert.equal(settings.readiness({ enabled: true }, {}).reason, "missing-secret");
  // webhook present but malformed -> invalid-secret
  assert.equal(settings.readiness({ enabled: true }, { webhookUrl: "https://evil.com/x" }).reason, "invalid-secret");
  // bot token present but no channel -> invalid-config
  assert.equal(
    settings.readiness({ enabled: true, channelId: "" }, { botToken: "xoxb-1-abcdefghij" }).reason,
    "invalid-config",
  );
  const ok = settings.readiness({ enabled: true }, { webhookUrl: webhook });
  assert.equal(ok.ready, true);
  assert.equal(ok.transport, "webhook");
});

test("writeSecretsEnvFile round-trips, masks, and preserves untouched keys", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir);
  assert.ok(filePath.endsWith("slack-notify.env"));

  const webhook = "https://hooks.slack.com/services/T/B/secretpath";
  const write1 = settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: webhook } });
  assert.equal(write1.status, "ok");
  let read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, webhook);
  assert.equal(read.botToken, "");

  // Writing only the bot token must not wipe the stored webhook.
  const bot = "xoxb-123456789-abcdefghij";
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { botToken: bot } });
  read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, webhook);
  assert.equal(read.botToken, bot);

  const masked = settings.readMaskedSecrets({ fs, filePath });
  assert.equal(masked.configured, true);
  assert.ok(masked.webhookUrl.includes("......"));
  assert.ok(!masked.webhookUrl.includes("secretpath"));

  // Explicit empty string clears a field.
  settings.writeSecretsEnvFile({ fs, path, filePath, secrets: { webhookUrl: "" } });
  read = settings.readSecretsEnvFile({ fs, filePath });
  assert.equal(read.webhookUrl, "");
  assert.equal(read.botToken, bot);
});

test("readSecretsEnvFile degrades gracefully when the file is missing", () => {
  const dir = tempDir();
  const filePath = settings.defaultSecretsEnvFilePath(dir); // never written
  assert.deepEqual(settings.readSecretsEnvFile({ fs, filePath }), { webhookUrl: "", botToken: "" });
  assert.equal(settings.readMaskedSecrets({ fs, filePath }).configured, false);
});

test("member id validation is a strict allowlist, not a sanitiser", () => {
  // Clawd emits this id as <@ID> WITHOUT escaping — that is the only way a
  // mention notifies anyone. The escape hatch is therefore the validator: if a
  // hostile value could pass, it would smuggle mention syntax straight past
  // every other defence in the formatter.
  assert.ok(settings.isValidSlackMemberId("U01234567"));
  assert.ok(settings.isValidSlackMemberId("W012ABC3DEF"), "Enterprise Grid ids start with W");
  assert.ok(settings.isValidSlackMemberId("  U01234567  "), "surrounding space is trimmed");

  for (const hostile of [
    "!channel",
    "U123>ping<!channel",
    "<@U01234567>",
    "U01234567|evil",
    "u01234567",       // must be upper-case
    "U123",            // too short
    "B01234567",       // bot id, not a member
    "",
    null,
    undefined,
    123,
  ]) {
    assert.equal(settings.isValidSlackMemberId(hostile), false, JSON.stringify(hostile));
  }
});

test("mentionUserId round-trips through config normalisation", () => {
  assert.equal(settings.normalizeSlackNotify({ mentionUserId: "U01234567" }).mentionUserId, "U01234567");
  // An invalid id is dropped rather than stored — nothing downstream should
  // have to re-check it.
  assert.equal(settings.normalizeSlackNotify({ mentionUserId: "<!channel>" }).mentionUserId, "");
  assert.equal(settings.validateSlackNotify({ enabled: true, mentionUserId: "U01234567" }).status, "ok");
  assert.equal(settings.validateSlackNotify({ enabled: true, mentionUserId: "<!channel>" }).status, "error");
});

test("webhook host pinning rejects suffix-confusion lookalikes", () => {
  // Exact hostname equality is the whole defence here — a substring or endsWith
  // check would accept every one of these.
  const hostile = [
    "https://evil-slack.com/services/T/B/x",
    "https://hooks.slack.com.evil.com/services/T/B/x",
    "https://hooks-slack.com/services/T/B/x",
    "https://evil.com/hooks.slack.com/services/T/B/x",
    "https://hooks.slack.com.br/services/T/B/x",
    "https://nothooks.slack.com/services/T/B/x",
    "http://hooks.slack.com/services/T/B/x", // downgraded to plaintext
  ];
  for (const url of hostile) {
    assert.equal(settings.isValidWebhookUrl(url), false, url);
  }
  assert.equal(settings.isValidWebhookUrl("https://hooks.slack.com/services/T/B/x"), true);
});

test("redactionSecretsForSlackNotify lists non-empty secrets", () => {
  assert.deepEqual(
    settings.redactionSecretsForSlackNotify({}, { webhookUrl: "w", botToken: "" }),
    ["w"],
  );
});
