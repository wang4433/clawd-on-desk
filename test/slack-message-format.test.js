"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const fmt = require("../src/slack-message-format");

// Blocks live inside the framing attachment (see "messages are framed" below).
const blocksOf = (msg) => (msg.attachments ? msg.attachments[0].blocks : blocksOf(msg));

test("buildCompletionMessage renders a done card with fallback text", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "abc123def", displayTitle: "Build", badge: "done", cwd: "/x/proj", agentId: "claude" },
    { lang: "en" },
  );
  assert.ok(msg.text.startsWith("✅"));
  assert.equal(blocksOf(msg)[0].type, "header");
  assert.ok(blocksOf(msg)[0].text.text.includes("Build"));
  // metadata line includes the folder + short id
  const section = blocksOf(msg)[1].text.text;
  assert.ok(section.includes("proj"));
  assert.ok(section.includes("#abc123"));
});

test("interrupted sessions use the warning icon", () => {
  const msg = fmt.buildCompletionMessage({ id: "s1", badge: "interrupted", displayTitle: "T" }, { lang: "en" });
  assert.ok(msg.text.startsWith("⚠️"));
});

test("includeOutput appends a fenced, redacted, fence-safe code block", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "T",
      assistantLastOutput: "token xoxb-123456789-abcdefghij and ```danger``` here",
    },
    { lang: "en", includeOutput: true },
  );
  const joined = blocksOf(msg).map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(joined.includes("```")); // a code block was added
  // Secret scrubbed. The marker itself is mrkdwn-escaped: Slack parses <…:…>
  // as link syntax even inside a fence, and renders &lt;…&gt; back as literal.
  assert.ok(joined.includes("&lt;redacted:token&gt;"));
  assert.ok(!joined.includes("xoxb-123456789-abcdefghij"));
  // The embedded fence must be broken so it can't terminate our block early.
  assert.ok(!joined.includes("```danger```"));
});

test("assistant output cannot smuggle a broadcast out of the code fence", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", assistantLastOutput: "ping <!channel> and <@U123>" },
    { lang: "en", includeOutput: true },
  );
  const joined = blocksOf(msg).map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(!joined.includes("<!channel>"));
  assert.ok(!joined.includes("<@U123>"));
  assert.ok(joined.includes("&lt;!channel&gt;"));
});

test("output is omitted when includeOutput is false", () => {
  const withOut = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", assistantLastOutput: "hello" },
    { lang: "en", includeOutput: false },
  );
  const joined = blocksOf(withOut).map((b) => (b.text ? b.text.text : "")).join("\n");
  assert.ok(!joined.includes("hello"));
});

test("buildPermissionMessage announces and points at the desktop app", () => {
  const msg = fmt.buildPermissionMessage(
    { title: "claude needs approval", toolName: "Bash", agentId: "claude", folder: "/x/proj", detail: "rm -rf" },
    { lang: "en" },
  );
  assert.ok(msg.text.startsWith("⏳"));
  const joined = blocksOf(msg).map((b) => {
    if (b.text) return b.text.text;
    if (b.elements) return b.elements.map((e) => e.text).join(" ");
    return "";
  }).join("\n");
  assert.ok(joined.includes("Bash"));
  assert.ok(/desktop app/i.test(joined));
});

test("mrkdwn special characters are escaped", () => {
  const msg = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "a<b>&c" }, { lang: "en" });
  const header = blocksOf(msg)[0].text.text; // plain_text header is not escaped
  assert.ok(header.includes("a<b>&c"));
  assert.equal(fmt.escapeMrkdwn("a<b>&c"), "a&lt;b&gt;&amp;c");
});

// The session title is derived from the user's own prompt, so it is as
// untrusted as assistant output — in the header (plain_text: redact only) and
// in the top-level fallback `text`, which Slack parses as mrkdwn.
test("the session title is redacted in the header and escaped in the fallback text", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "deploy with xoxb-123456789-abcdefghij <!channel>",
      cwd: "/x/proj",
    },
    { lang: "en" },
  );
  // Header: plain_text, so the secret is gone but nothing is HTML-escaped.
  const header = blocksOf(msg)[0].text.text;
  assert.ok(!header.includes("xoxb-123456789-abcdefghij"));
  assert.ok(header.includes("<redacted:token>"));
  // Fallback text: mrkdwn-parsed, so the secret is gone AND <!channel> is inert.
  assert.ok(!msg.text.includes("xoxb-123456789-abcdefghij"));
  assert.ok(!msg.text.includes("<!channel>"));
  assert.ok(msg.text.includes("&lt;!channel&gt;"));
});

test("session metadata (folder, host, agent) is redacted and escaped", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "T",
      agentId: "<!here>",
      cwd: "/srv/xoxb-123456789-abcdefghij",
      host: "box<&>1",
    },
    { lang: "en" },
  );
  const section = blocksOf(msg)[1].text.text;
  assert.ok(!section.includes("xoxb-123456789-abcdefghij"));
  assert.ok(!section.includes("<!here>"));
  assert.ok(section.includes("&lt;!here&gt;"));
  assert.ok(section.includes("box&lt;&amp;&gt;1"));
});

test("the completion fallback text carries no raw folder either", () => {
  const msg = fmt.buildCompletionMessage(
    { id: "s1", badge: "done", displayTitle: "T", cwd: "/srv/<!channel>" },
    { lang: "en" },
  );
  assert.ok(!msg.text.includes("<!channel>"));
  assert.ok(msg.text.includes("&lt;!channel&gt;"));
});

test("permission announcements redact and escape every agent-derived field", () => {
  const msg = fmt.buildPermissionMessage(
    {
      title: "claude <!channel> needs approval for xoxb-123456789-abcdefghij",
      toolName: "Bash <@U123>",
      agentId: "claude<&>code",
      folder: "/x/<!here>",
      detail: "curl -H 'authorization: Bearer sk-ant-abcdefghijkl'",
    },
    { lang: "en" },
  );
  const blocks = blocksOf(msg);
  const textOf = (b) => (b.text ? b.text.text : (b.elements || []).map((e) => e.text).join(" "));
  const everywhere = [msg.text, ...blocks.map(textOf)].join("\n");

  // Secrets must be gone from every field regardless of block type.
  assert.ok(!everywhere.includes("xoxb-123456789-abcdefghij"));
  assert.ok(!everywhere.includes("sk-ant-abcdefghijkl"));

  // Mention syntax is neutralised by escaping, which only applies where Slack
  // parses mrkdwn: section and context blocks, and the top-level fallback text.
  const mrkdwn = [msg.text, ...blocks.filter((b) => b.type !== "header").map(textOf)].join("\n");
  assert.ok(!mrkdwn.includes("<!channel>"));
  assert.ok(!mrkdwn.includes("<!here>"));
  assert.ok(!mrkdwn.includes("<@U123>"));
  // The title now lands in the body rather than the fallback (the fallback
  // carries agent · tool so push previews stay distinguishable), so look for the
  // escaped form wherever mrkdwn is rendered.
  // The agent-supplied description supersedes the title in the body (the header
  // already says who wants what), so this title is dropped rather than shown —
  // either way none of its control sequences reach a parsed field.
  assert.ok(mrkdwn.includes("&lt;!here&gt;"), "the folder is still shown, escaped");

  // The header is plain_text, where Slack renders control sequences literally
  // (verified against a real workspace — see the header test above). It is
  // redacted but deliberately not escaped, so a tool name may still read
  // "Bash <@U123>" there. That is inert text, not a mention.
  const header = blocks[0].text.text;
  assert.equal(blocks[0].text.type, "plain_text");
  assert.ok(!header.includes("xoxb-123456789-abcdefghij"), "redaction still applies to the header");
});

// A cut that lands inside "&lt;" would render as literal "&l" rubbish, and the
// escape is what makes mention syntax inert — so the half-entity is dropped.
test("truncation never leaves a half-written escape entity", () => {
  const msg = fmt.buildCompletionMessage(
    {
      id: "s1",
      badge: "done",
      displayTitle: "T",
      // Nothing but '<' — every escaped character is a 4-char entity, so the
      // section limit is guaranteed to fall inside one.
      assistantLastOutput: "<".repeat(2000),
    },
    { lang: "en", includeOutput: true },
  );
  for (const block of blocksOf(msg)) {
    const text = block.text ? block.text.text : "";
    assert.ok(!/&[A-Za-z]{0,4}$/.test(text), `dangling entity in: ${text.slice(-12)}`);
  }
});

test("truncateMiddle keeps both ends and marks truncation", () => {
  const long = "A".repeat(100) + "B".repeat(100);
  const out = fmt.truncateMiddle(long, 60);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 60);
  assert.ok(out.text.startsWith("A"));
  assert.ok(out.text.endsWith("B"));
  assert.ok(out.text.includes("[truncated]"));
});

test("locales fall back to English and translate the status word", () => {
  assert.equal(fmt.getLocale("zz").done, "done");
  const zh = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "T" }, { lang: "zh" });
  assert.ok(blocksOf(zh)[1].text.text.includes("已完成"));
});

test("buildTestMessage produces a simple two-block card", () => {
  const msg = fmt.buildTestMessage({ lang: "en" });
  assert.equal(blocksOf(msg).length, 2);
  assert.equal(blocksOf(msg)[0].type, "header");
});

test("null entry yields null (caller skips)", () => {
  assert.equal(fmt.buildCompletionMessage(null, { lang: "en" }), null);
});

// Slack draws no border around Block Kit blocks. The one way to frame a whole
// message is an attachment with a `color` — it renders a vertical bar down the
// left edge, which also separates consecutive messages from each other.
test("messages are framed by a coloured attachment", () => {
  const done = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "T" }, { lang: "en" });
  assert.equal(done.blocks, undefined, "blocks move inside the attachment");
  assert.equal(done.attachments.length, 1);
  assert.ok(/^#[0-9a-f]{6}$/i.test(done.attachments[0].color), "needs a hex colour to draw the bar");
  assert.ok(Array.isArray(done.attachments[0].blocks));
  assert.ok(done.text, "the summary survives as the notification fallback");
});

test("the frame colour reflects what happened", () => {
  const colourOf = (msg) => msg.attachments[0].color.toLowerCase();
  const done = fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "T" }, { lang: "en" });
  const bad = fmt.buildCompletionMessage({ id: "s1", badge: "interrupted", displayTitle: "T" }, { lang: "en" });
  const perm = fmt.buildPermissionMessage({ toolName: "Bash", agentId: "claude-code" }, { lang: "en" });

  assert.notEqual(colourOf(done), colourOf(bad), "success and failure must not look alike");
  assert.notEqual(colourOf(done), colourOf(perm), "a request for you is not a completion");
});

test("an opt-in mention is emitted unescaped so it actually notifies", () => {
  // The one deliberate exception to "escape everything": this id is Clawd's own
  // output, validated on the way in, never agent data.
  const opts = { lang: "en", mentionUserId: "U01234567" };
  for (const msg of [
    fmt.buildCompletionMessage({ id: "s1", badge: "done", displayTitle: "T" }, opts),
    fmt.buildPermissionMessage({ toolName: "Bash", agentId: "claude-code" }, opts),
    fmt.buildTestMessage(opts),
  ]) {
    const wire = JSON.stringify(msg);
    assert.ok(wire.includes("<@U01234567>"), "mention must reach Slack unescaped");
    assert.ok(!wire.includes("&lt;@U01234567&gt;"), "escaping it would show text and notify nobody");
  }
});

test("no mention is emitted when none is configured, or when it is malformed", () => {
  const plain = fmt.buildPermissionMessage({ toolName: "Bash" }, { lang: "en" });
  assert.ok(!JSON.stringify(plain).includes("<@"), "default must stay silent");

  // Defence in depth: even if a bad value reached the formatter, it must not
  // become mention syntax.
  for (const bad of ["<!channel>", "u01234567", "U1", "", null]) {
    const msg = fmt.buildPermissionMessage({ toolName: "Bash" }, { lang: "en", mentionUserId: bad });
    const wire = JSON.stringify(msg);
    assert.ok(!wire.includes("<@"), `built a mention from ${JSON.stringify(bad)}`);
    assert.ok(!wire.includes("<!channel>"), `leaked mention syntax from ${JSON.stringify(bad)}`);
  }
});

test("permission headers distinguish one request from another at a glance", () => {
  // Every card used to open with the same generic "Permission needed", so a
  // channel full of them was unreadable — you had to open each one to see which
  // agent wanted what. The header is the line people scan.
  const a = fmt.buildPermissionMessage(
    { title: "claude-code requests Bash", toolName: "Bash", agentId: "claude-code" }, { lang: "en" });
  const b = fmt.buildPermissionMessage(
    { title: "codex requests Write", toolName: "Write", agentId: "codex" }, { lang: "en" });

  assert.notEqual(blocksOf(a)[0].text.text, blocksOf(b)[0].text.text, "headers must differ");
  assert.ok(blocksOf(a)[0].text.text.includes("Bash"));
  assert.ok(blocksOf(a)[0].text.text.includes("claude-code"));
  assert.ok(blocksOf(b)[0].text.text.includes("Write"));
  // The push preview is the other place people triage from.
  assert.notEqual(a.text, b.text, "fallback text must differ too");
});

test("permission message states the tool and agent once, not three times", () => {
  const msg = fmt.buildPermissionMessage(
    { title: "claude-code requests Bash", toolName: "Bash", agentId: "claude-code",
      folder: "clawd-on-desk", summary: "Remove the dist directory" },
    { lang: "en" },
  );
  const body = JSON.stringify(blocksOf(msg));
  assert.equal((body.match(/Bash/g) || []).length, 1, "tool name should appear once");
  assert.equal((body.match(/claude-code/g) || []).length, 1, "agent should appear once");
  // The description is the reason a human is being interrupted — keep it.
  assert.ok(body.includes("Remove the dist directory"));
  assert.ok(body.includes("clawd-on-desk"));
});
