"use strict";

// Self-contained UI transcript parser for the omp_local adapter.
// Contract: paperclip.adapterUiParser 1.0.0 — zero imports, served verbatim
// to the browser and eval'd by the Paperclip UI.
//
// OMP runs in `-p --mode json` so stdout is JSONL of pi-style agent events.

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asString(value, fallback) {
  return typeof value === "string" ? value : fallback === undefined ? "" : fallback;
}

function extractTextContent(content) {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && c.text) text += c.text;
    if (c.type === "thinking" && c.thinking) thinking += c.thinking;
  }
  return { text, thinking };
}

function stringifyToolPayload(value, extractor) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const extracted = extractor(value);
    return extracted.text || JSON.stringify(value);
  }
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    const extracted = extractor(value.content);
    return extracted.text || JSON.stringify(value);
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function createStdoutParser() {
  const pendingToolCalls = new Map();

  function parseLine(line, ts) {
    const parsed = asRecord(safeJsonParse(line));
    if (!parsed) {
      const trimmed = line.trim();
      if (!trimmed) return [];
      return [{ kind: "stdout", ts, text: trimmed }];
    }

    const type = asString(parsed.type);

    // Internal RPC plumbing — never user-facing.
    if (
      type === "response" ||
      type === "extension_ui_request" ||
      type === "extension_ui_response" ||
      type === "extension_error" ||
      type === "turn_start" ||
      type === "message_start" ||
      type === "tool_execution_update"
    ) {
      return [];
    }

    if (type === "agent_start") {
      return [{ kind: "system", ts, text: "🚀 OMP agent started" }];
    }

    if (type === "agent_end") {
      const entries = [];
      const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
      const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : null;
      if (lastMessage && lastMessage.role === "assistant") {
        const { text, thinking } = extractTextContent(lastMessage.content);
        if (thinking) entries.push({ kind: "thinking", ts, text: thinking });
        if (text) entries.push({ kind: "assistant", ts, text });

        const usage = asRecord(lastMessage.usage);
        if (usage) {
          const inputTokens = usage.inputTokens || usage.input || 0;
          const outputTokens = usage.outputTokens || usage.output || 0;
          const cachedTokens = usage.cacheRead || usage.cachedInputTokens || 0;
          const costRecord = asRecord(usage.cost);
          const costUsd = (costRecord && costRecord.total) || usage.costUsd || 0;
          if (inputTokens > 0 || outputTokens > 0) {
            entries.push({
              kind: "result",
              ts,
              text: "Run completed",
              inputTokens,
              outputTokens,
              cachedTokens,
              costUsd,
              subtype: "end",
              isError: false,
              errors: [],
            });
          }
        }
      }
      if (entries.length === 0) {
        entries.push({ kind: "system", ts, text: "✅ OMP agent finished" });
      }
      return entries;
    }

    if (type === "turn_end") {
      const entries = [];
      const message = asRecord(parsed.message);
      if (message) {
        const { text, thinking } = extractTextContent(message.content);
        if (thinking) entries.push({ kind: "thinking", ts, text: thinking });
        if (text) entries.push({ kind: "assistant", ts, text });
      }
      const toolResults = Array.isArray(parsed.toolResults) ? parsed.toolResults : [];
      for (const tr of toolResults) {
        if (!tr || typeof tr !== "object") continue;
        const toolCallId = asString(tr.toolCallId, "tool-" + Date.now());
        const pendingCall = pendingToolCalls.get(toolCallId);
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          toolName: asString(tr.toolName, (pendingCall && pendingCall.toolName) || "tool"),
          content: stringifyToolPayload(tr.content, extractTextContent),
          isError: tr.isError === true,
        });
        pendingToolCalls.delete(toolCallId);
      }
      return entries;
    }

    if (type === "message_update") {
      const assistantEvent = asRecord(parsed.assistantMessageEvent);
      if (!assistantEvent) return [];
      const msgType = asString(assistantEvent.type);
      const delta = asString(assistantEvent.delta);
      const content = asString(assistantEvent.content);
      if (msgType === "thinking_delta" && delta) {
        return [{ kind: "thinking", ts, text: delta, delta: true }];
      }
      if (msgType === "text_delta" && delta) {
        return [{ kind: "assistant", ts, text: delta, delta: true }];
      }
      if (msgType === "thinking_end" && content) {
        return [{ kind: "thinking", ts, text: content }];
      }
      if (msgType === "text_end" && content) {
        return [{ kind: "assistant", ts, text: content }];
      }
      return [];
    }

    if (type === "message_end") {
      const message = asRecord(parsed.message);
      if (!message) return [];
      const entries = [];
      const { text, thinking } = extractTextContent(message.content);
      if (thinking) entries.push({ kind: "thinking", ts, text: thinking });
      if (text) entries.push({ kind: "assistant", ts, text });
      return entries;
    }

    if (type === "tool_execution_start") {
      const toolCallId = asString(parsed.toolCallId, "tool-" + Date.now());
      const toolName = asString(parsed.toolName, "tool");
      pendingToolCalls.set(toolCallId, { toolName, args: parsed.args });
      return [{ kind: "tool_call", ts, name: toolName, input: parsed.args, toolUseId: toolCallId }];
    }

    if (type === "tool_execution_end") {
      const toolCallId = asString(parsed.toolCallId, "tool-" + Date.now());
      const toolName = asString(parsed.toolName, "tool");
      pendingToolCalls.delete(toolCallId);
      return [
        {
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          toolName,
          content: stringifyToolPayload(parsed.result, extractTextContent),
          isError: parsed.isError === true,
        },
      ];
    }

    return [{ kind: "stdout", ts, text: line }];
  }

  function reset() {
    pendingToolCalls.clear();
  }

  return { parseLine, reset };
}

// Stateless convenience entry point (host may call either export).
const defaultParser = createStdoutParser();
function parseStdoutLine(line, ts) {
  return defaultParser.parseLine(line, ts);
}

module.exports = { createStdoutParser, parseStdoutLine };
