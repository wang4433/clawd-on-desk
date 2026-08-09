"use strict";

// Slack Block Kit message builders for the one-way notifier. Kept dependency-free
// on purpose: Slack messages are plain JSON (`{ text, blocks }`), so unlike the
// Telegram formatter this needs no markdown engine. `text` is the notification
// fallback (shown in the OS/Slack push preview); `blocks` is the rich card.
//
// Every user/agent-derived string is run through redactSecrets before it leaves
// the desktop, matching the Telegram/Feishu renderers.

const { redactSecrets } = require("./secret-redact");

// Slack hard limits: header plain_text <= 150, section mrkdwn <= 3000. Stay a
// little under. Assistant output is middle-truncated so both ends survive.
const HEADER_MAX = 150;
const SECTION_MAX = 2900;
const OUTPUT_MAX = 2600;
const FALLBACK_MAX = 3000;

// Block Kit draws no border, so consecutive cards run together in a busy
// channel. Wrapping the blocks in an attachment with a `color` gives each
// message a vertical bar down its left edge — the only framing Slack offers.
// Attachments are labelled legacy in Slack's docs but remain fully supported,
// and nothing in Block Kit replaces the colour bar.
//
// Slack's own brand palette, so the bars sit naturally in both themes.
const FRAME = Object.freeze({
  done: "#2eb67d",         // green
  interrupted: "#e01e5a",  // red
  permission: "#ecb22e",   // amber — something is waiting on you
  info: "#36c5f0",         // blue
});

const SLACK_LOCALES = Object.freeze({
  en: {
    session: "session",
    done: "done",
    interrupted: "interrupted",
    assistantOutput: "Assistant output",
    truncated: "truncated",
    permissionTitle: "Permission needed",
    permissionHint: "Approve or deny in the desktop app.",
    tool: "Tool",
    folder: "Folder",
    agent: "Agent",
    host: "Host",
    testTitle: "Slack notifications connected",
    testBody: "This is a test message from Clawd on Desk. If you can read this, notifications are working.",
    wrapStatus: (status) => `(${status})`,
  },
  zh: {
    session: "会话",
    done: "已完成",
    interrupted: "已中断",
    assistantOutput: "Assistant 输出",
    truncated: "已截断",
    permissionTitle: "需要审批",
    permissionHint: "请在桌面 App 中批准或拒绝。",
    tool: "工具",
    folder: "目录",
    agent: "Agent",
    host: "主机",
    testTitle: "Slack 通知已连接",
    testBody: "这是来自 Clawd on Desk 的测试消息。如果你能看到它，说明通知已正常工作。",
    wrapStatus: (status) => `（${status}）`,
  },
  "zh-TW": {
    session: "工作階段",
    done: "已完成",
    interrupted: "已中斷",
    assistantOutput: "Assistant 輸出",
    truncated: "已截斷",
    permissionTitle: "需要審批",
    permissionHint: "請在桌面 App 中核准或拒絕。",
    tool: "工具",
    folder: "目錄",
    agent: "Agent",
    host: "主機",
    testTitle: "Slack 通知已連線",
    testBody: "這是來自 Clawd on Desk 的測試訊息。如果你能看到它，代表通知已正常運作。",
    wrapStatus: (status) => `（${status}）`,
  },
  ko: {
    session: "세션",
    done: "완료",
    interrupted: "중단됨",
    assistantOutput: "Assistant 출력",
    truncated: "잘림",
    permissionTitle: "승인 필요",
    permissionHint: "데스크톱 앱에서 승인하거나 거부하세요.",
    tool: "도구",
    folder: "폴더",
    agent: "Agent",
    host: "호스트",
    testTitle: "Slack 알림 연결됨",
    testBody: "Clawd on Desk에서 보낸 테스트 메시지입니다. 이 메시지가 보이면 알림이 정상 작동합니다.",
    wrapStatus: (status) => `(${status})`,
  },
  ja: {
    session: "セッション",
    done: "完了",
    interrupted: "中断",
    assistantOutput: "Assistant 出力",
    truncated: "省略",
    permissionTitle: "承認が必要",
    permissionHint: "デスクトップアプリで承認または拒否してください。",
    tool: "ツール",
    folder: "フォルダ",
    agent: "Agent",
    host: "ホスト",
    testTitle: "Slack 通知が接続されました",
    testBody: "Clawd on Desk からのテストメッセージです。これが表示されていれば通知は正常に動作しています。",
    wrapStatus: (status) => `（${status}）`,
  },
  "pt-BR": {
    session: "sessão",
    done: "concluída",
    interrupted: "interrompida",
    assistantOutput: "Saída do assistente",
    truncated: "truncado",
    permissionTitle: "Aprovação necessária",
    permissionHint: "Aprove ou recuse no aplicativo de desktop.",
    tool: "Ferramenta",
    folder: "Pasta",
    agent: "Agente",
    host: "Host",
    testTitle: "Notificações do Slack conectadas",
    testBody: "Esta é uma mensagem de teste do Clawd on Desk. Se você consegue ler isto, as notificações estão funcionando.",
    wrapStatus: (status) => `(${status})`,
  },
});

function getLocale(lang) {
  return SLACK_LOCALES[lang] || SLACK_LOCALES.en;
}

function safeText(value) {
  return (typeof value === "string" ? value : String(value == null ? "" : value))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, " ");
}

// Slack mrkdwn only requires &, <, > to be escaped; everything else is literal.
// Escaping < is what stops an agent-derived string containing `<!channel>` or
// `<@U123>` from turning a notification into a real broadcast/mention — Slack
// renders the entities back as literal text.
function escapeMrkdwn(value) {
  return safeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Two sanitizers, because Slack treats the two text types differently:
//
//   - `plain_text` fields (header blocks) are NOT mrkdwn. Escaping there would
//     surface a literal "&amp;", and no mention syntax is interpreted — so they
//     need redaction only.
//   - `mrkdwn` fields AND the top-level fallback `text` ARE parsed (`mrkdwn`
//     defaults to true), so they need redaction *and* escaping.
//
// Every user/agent-derived string — session title, folder, host, agent id, tool
// name, detail, assistant output, and the fallback text built from them — goes
// through one of these before it leaves the desktop.
function redactPlain(value) {
  return redactSecrets(safeText(value));
}

function redactMrkdwn(value) {
  return escapeMrkdwn(redactSecrets(safeText(value)));
}

// The single deliberate exception to "escape everything before it leaves the
// desktop". An escaped mention is inert text that notifies nobody, so this must
// go out raw — which is safe only because the id is validated against a strict
// allowlist (slack-notify-settings.isValidSlackMemberId) before it is stored.
// Re-checked here so a bad value can never become mention syntax, even if it
// somehow reached the formatter unvalidated.
function mentionLine(options) {
  const id = options && typeof options.mentionUserId === "string" ? options.mentionUserId.trim() : "";
  return /^[UW][A-Z0-9]{6,20}$/.test(id) ? `<@${id}>` : "";
}

function withMention(text, options) {
  const mention = mentionLine(options);
  if (!mention) return text;
  return text ? `${mention}\n${text}` : mention;
}

function clip(value, maxLength) {
  const text = safeText(value);
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  let result = "";
  let length = 0;
  for (const character of text) {
    if (length + character.length > maxLength) break;
    result += character;
    length += character.length;
  }
  return result;
}

function truncateMiddle(text, maxLen) {
  const value = safeText(text);
  if (value.length <= maxLen) return { text: value, truncated: false };
  const marker = "\n...[truncated]...\n";
  if (maxLen <= marker.length + 20) {
    return { text: clip(value, maxLen), truncated: true };
  }
  const keep = maxLen - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const safeHead = clip(value, head);
  let safeTail = "";
  let safeTailLength = 0;
  for (const character of Array.from(value).reverse()) {
    if (safeTailLength + character.length > tail) break;
    safeTail = `${character}${safeTail}`;
    safeTailLength += character.length;
  }
  return { text: `${safeHead}${marker}${safeTail}`, truncated: true };
}

function folderName(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function shortId(id) {
  const s = String(id || "");
  return s.length > 6 ? s.slice(0, 6) : s;
}

// Clipping escaped text can land inside an entity ("...&am"), which Slack would
// render as literal garbage instead of the character it stands for. Escaping is
// what makes <!channel> inert, so dropping the half-entity is the safe end:
// worst case one character of content is lost. A complete "&amp;" ends in ";"
// and is left alone.
function clipMrkdwn(value, maxLength) {
  return clip(value, maxLength).replace(/&[A-Za-z]{0,4}$/, "");
}

function headerBlock(text) {
  return { type: "header", text: { type: "plain_text", text: clip(text, HEADER_MAX) || " ", emoji: true } };
}

function sectionBlock(mrkdwnText) {
  return { type: "section", text: { type: "mrkdwn", text: clipMrkdwn(mrkdwnText, SECTION_MAX) } };
}

function contextBlock(mrkdwnText) {
  return { type: "context", elements: [{ type: "mrkdwn", text: clipMrkdwn(mrkdwnText, SECTION_MAX) }] };
}

// Break any embedded ``` so it can't close our fenced code block early.
function neutralizeFences(text) {
  return safeText(text).replace(/`/g, "`\u200b");
}

function prepareAssistantOutput(entry) {
  const raw = entry && typeof entry.assistantLastOutput === "string" ? entry.assistantLastOutput : "";
  let text = safeText(raw).replace(/[ \t]+\n/g, "\n").trim();
  if (!text) return null;
  text = redactSecrets(text);
  const limited = truncateMiddle(text, OUTPUT_MAX);
  return {
    text: limited.text,
    truncated: limited.truncated || !!(entry && entry.assistantLastOutputTruncated === true),
  };
}

function metaLine(entry) {
  const meta = [];
  if (entry.agentId) meta.push(redactMrkdwn(entry.agentId));
  const folder = folderName(entry.cwd);
  if (folder) meta.push(redactMrkdwn(folder));
  if (entry.host) meta.push(redactMrkdwn(entry.host));
  if (entry.id) meta.push(`#${redactMrkdwn(shortId(entry.id))}`);
  return meta.join(" · ");
}

// Completion ping. `includeOutput` mirrors the Telegram companion's
// outputMode === "full"; when false, only the title + metadata are sent.
function buildCompletionMessage(entry, options = {}) {
  if (!entry) return null;
  const locale = getLocale(options.lang);
  const interrupted = entry.badge === "interrupted";
  const icon = interrupted ? "⚠️" : "✅";
  const status = interrupted ? locale.interrupted : locale.done;
  // The session title is derived from the user's own prompt, so it gets the
  // same treatment as assistant output — redacted everywhere, and escaped in
  // the two mrkdwn-parsed places (there are none in a header block).
  const rawTitle = entry.displayTitle || (entry.id ? `${shortId(entry.id)}..` : locale.session);
  const wrapStatus = typeof locale.wrapStatus === "function" ? locale.wrapStatus(status) : `(${status})`;

  const blocks = [headerBlock(`${icon} ${redactPlain(rawTitle)}`)];
  const meta = metaLine(entry);
  const statusLine = `*${escapeMrkdwn(status)}*${meta ? `  ·  ${meta}` : ""}`;
  blocks.push(sectionBlock(withMention(statusLine, options)));

  const prepared = options.includeOutput ? prepareAssistantOutput(entry) : null;
  if (prepared) {
    const label = prepared.truncated ? `${locale.assistantOutput} (${locale.truncated})` : locale.assistantOutput;
    blocks.push(sectionBlock(`*${escapeMrkdwn(label)}:*`));
    // Slack still parses &, < and > inside a fenced block, so escape there too —
    // a code fence is not a mention-proof container.
    const body = escapeMrkdwn(neutralizeFences(prepared.text));
    blocks.push(sectionBlock("```\n" + clipMrkdwn(body, SECTION_MAX - 8) + "\n```"));
  }

  const fallbackFolder = redactMrkdwn(folderName(entry.cwd));
  const fallback = clipMrkdwn(
    `${icon} ${redactMrkdwn(rawTitle)} ${wrapStatus}${fallbackFolder ? ` — ${fallbackFolder}` : ""}`,
    FALLBACK_MAX
  );
  return {
    text: fallback,
    attachments: [{ color: interrupted ? FRAME.interrupted : FRAME.done, blocks }],
  };
}

// Read-only "permission needed" heads-up. Slack cannot resolve the approval in
// this build, so the message tells the user to act in the desktop app.
function buildPermissionMessage(payload, options = {}) {
  const locale = getLocale(options.lang);
  const p = payload && typeof payload === "object" ? payload : {};
  // The header is what people scan in a busy channel, so it carries the two
  // things that tell one request apart from another — who is asking and for
  // what. A generic "Permission needed" on every card makes a scrolling channel
  // unreadable. Agent and tool appear here and nowhere else; repeating them as
  // Tool:/Agent: fields below only pushed the actual reason further down.
  const agentId = redactPlain(p.agentId).trim();
  const toolName = redactPlain(p.toolName).trim();
  const identity = [agentId, toolName].filter(Boolean).join(" · ");
  const heading = identity || redactPlain(p.title).trim() || locale.permissionTitle;
  const blocks = [headerBlock(`⏳ ${heading}`)];

  // The description is why a human is being interrupted — give it the body to
  // itself. Fall back to the title when the agent sent no description.
  const detail = safeText(p.detail || p.summary).trim();
  const body = detail || safeText(p.title).trim();
  const bodyText = withMention(body ? clipMrkdwn(redactMrkdwn(body), SECTION_MAX) : "", options);
  if (bodyText) blocks.push(sectionBlock(bodyText));

  // Folder is orientation, not the decision — it belongs beside the hint rather
  // than in the body.
  const folder = folderName(p.folder || p.cwd);
  const contextParts = [];
  if (folder) contextParts.push(`📁 ${redactMrkdwn(folder)}`);
  contextParts.push(`ℹ️ ${escapeMrkdwn(locale.permissionHint)}`);
  blocks.push(contextBlock(contextParts.join("  ·  ")));

  // Push previews are the other place people triage from, so the fallback has
  // to distinguish requests too.
  const fallbackSubject = identity || safeText(p.title).trim();
  return {
    text: clipMrkdwn(`⏳ ${escapeMrkdwn(locale.permissionTitle)}: ${redactMrkdwn(fallbackSubject)}`, FALLBACK_MAX),
    attachments: [{ color: FRAME.permission, blocks }],
  };
}

function buildTestMessage(options = {}) {
  const locale = getLocale(options.lang);
  return {
    text: locale.testTitle,
    attachments: [{
      color: FRAME.info,
      blocks: [
        headerBlock(`🦀 ${locale.testTitle}`),
        sectionBlock(withMention(escapeMrkdwn(locale.testBody), options)),
      ],
    }],
  };
}

module.exports = {
  buildCompletionMessage,
  buildPermissionMessage,
  buildTestMessage,
  prepareAssistantOutput,
  neutralizeFences,
  escapeMrkdwn,
  redactPlain,
  redactMrkdwn,
  truncateMiddle,
  getLocale,
  SLACK_LOCALES,
  HEADER_MAX,
  SECTION_MAX,
  OUTPUT_MAX,
  FRAME,
};
