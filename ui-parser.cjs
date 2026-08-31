"use strict";

// Self-contained UI transcript parser for the omp_local adapter.
// Contract: paperclip.adapterUiParser 1.0.0 — zero imports, served verbatim
// to the browser and eval'd by the Paperclip UI.
//
// OMP runs under `-p --mode json`, so stdout is JSONL of pi-style agent
// events. Rendering that stream naively produces an unreadable transcript,
// because OMP reports the same content through several channels:
//
//   1. Streamed `text_delta` / `thinking_delta` events (the live view).
//   2. A `text_end` / `thinking_end` event carrying the same full block.
//   3. A `message_end` event carrying the whole assembled message.
//   4. A `turn_end` event carrying that message a third time.
//
// The Paperclip UI already coalesces consecutive `delta: true` entries into
// one block, so deltas are the channel to keep; every later restatement is a
// duplicate. This parser therefore treats deltas as the source of truth and
// suppresses the finals, falling back to the finals only when a message
// produced no deltas at all (non-streaming runs).
//
// Two more sources of noise are handled here:
//
//   * `message_start`/`message_end` also fire for `role: "toolResult"`, whose
//     "content" is the entire file or command output. Rendering those as
//     assistant prose dumps whole files into the chat.
//   * Chunk boundaries split JSON objects mid-line, so a naive parse fails and
//     the raw fragment gets printed. Incomplete lines are buffered instead.

var MAX_TOOL_RESULT_CHARS = 4000;

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
  var text = "";
  var thinking = "";
  for (var i = 0; i < content.length; i++) {
    var c = content[i];
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && c.text) text += c.text;
    if (c.type === "thinking" && c.thinking) thinking += c.thinking;
  }
  return { text: text, thinking: thinking };
}

function truncate(text) {
  if (typeof text !== "string") text = String(text);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  var omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n… [" + omitted + " more characters truncated]";
}

function stringifyToolPayload(value) {
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) {
    var extracted = extractTextContent(value);
    return truncate(extracted.text || JSON.stringify(value));
  }
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    var inner = extractTextContent(value.content);
    return truncate(inner.text || JSON.stringify(value));
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return truncate(JSON.stringify(value));
  return truncate(String(value));
}

// Event types that carry no user-facing content. Rendering them (or letting
// them reach the raw-line fallback) is what fills the transcript with JSON.
var SILENT_TYPES = {
  response: 1,
  extension_ui_request: 1,
  extension_ui_response: 1,
  extension_error: 1,
  turn_start: 1,
  tool_execution_update: 1,
  advisor_cost_changed: 1,
  thinking_level_changed: 1,
  session: 1,
  message_start: 1,
};

function createStdoutParser() {
  var pendingToolCalls = new Map();
  var emittedToolResults = new Set();
  var emittedToolCalls = new Set();
  // Per-message streaming state: when a message streamed deltas, its final
  // restatements are duplicates and must not be emitted again.
  var sawTextDelta = false;
  var sawThinkingDelta = false;
  var buffer = "";

  function resetMessageState() {
    sawTextDelta = false;
    sawThinkingDelta = false;
  }

  function parseLine(line, ts) {
    var raw = typeof line === "string" ? line : "";
    if (!buffer && !raw.trim()) return [];

    // Reassemble JSON objects split across chunk boundaries. The raw text is
    // concatenated verbatim: trimming the fragments would drop whitespace
    // that falls inside a split string literal and corrupt the JSON.
    var candidate = buffer ? buffer + raw : raw;
    var parsed = asRecord(safeJsonParse(candidate));
    if (!parsed && buffer) {
      // The held fragment never completed — it was junk, or the stream
      // resynchronised on a fresh object. Drop it rather than let it swallow
      // every subsequent event, and reconsider the current line on its own.
      var standalone = asRecord(safeJsonParse(raw));
      if (standalone) {
        buffer = "";
        parsed = standalone;
        candidate = raw;
      }
    }
    if (!parsed) {
      if (candidate.trimStart().charAt(0) === "{") {
        // Looks like the start of an object that has not finished arriving.
        // Hold it, bounded, so a malformed line cannot consume the stream.
        if (candidate.length < 262144) {
          buffer = candidate;
          return [];
        }
        buffer = "";
        return [{ kind: "stdout", ts: ts, text: truncate(candidate.trim()) }];
      }
      buffer = "";
      // Genuine plain-text output, e.g. "[paperclip] …" preamble lines.
      var plain = candidate.trim();
      return plain ? [{ kind: "stdout", ts: ts, text: plain }] : [];
    }
    buffer = "";

    var type = asString(parsed.type);
    if (SILENT_TYPES[type] === 1) {
      if (type === "message_start") resetMessageState();
      return [];
    }

    if (type === "agent_start") {
      return [{ kind: "system", ts: ts, text: "OMP agent started" }];
    }

    if (type === "agent_end") {
      var endEntries = [];
      var messages = Array.isArray(parsed.messages) ? parsed.messages : null;
      var last = messages && messages.length > 0 ? messages[messages.length - 1] : null;
      if (last && last.role === "assistant") {
        var usage = asRecord(last.usage);
        if (usage) {
          var inputTokens = usage.inputTokens || usage.input || 0;
          var outputTokens = usage.outputTokens || usage.output || 0;
          var cachedTokens = usage.cacheRead || usage.cachedInputTokens || 0;
          var costRecord = asRecord(usage.cost);
          var costUsd = (costRecord && costRecord.total) || usage.costUsd || 0;
          if (inputTokens > 0 || outputTokens > 0) {
            endEntries.push({
              kind: "result",
              ts: ts,
              text: "Run completed",
              inputTokens: inputTokens,
              outputTokens: outputTokens,
              cachedTokens: cachedTokens,
              costUsd: costUsd,
              subtype: "end",
              isError: false,
              errors: [],
            });
          }
        }
      }
      if (endEntries.length === 0) {
        endEntries.push({ kind: "system", ts: ts, text: "OMP agent finished" });
      }
      return endEntries;
    }

    if (type === "message_update") {
      var ev = asRecord(parsed.assistantMessageEvent);
      if (!ev) return [];
      var evType = asString(ev.type);
      var delta = asString(ev.delta);
      var content = asString(ev.content);

      if (evType === "thinking_delta" && delta) {
        sawThinkingDelta = true;
        return [{ kind: "thinking", ts: ts, text: delta, delta: true }];
      }
      if (evType === "text_delta" && delta) {
        sawTextDelta = true;
        return [{ kind: "assistant", ts: ts, text: delta, delta: true }];
      }
      // *_end restates the block that the deltas already streamed.
      if (evType === "thinking_end") {
        if (sawThinkingDelta || !content) return [];
        return [{ kind: "thinking", ts: ts, text: content }];
      }
      if (evType === "text_end") {
        if (sawTextDelta || !content) return [];
        return [{ kind: "assistant", ts: ts, text: content }];
      }
      // toolcall_start / toolcall_end duplicate tool_execution_* events.
      return [];
    }

    if (type === "message_end") {
      var msg = asRecord(parsed.message);
      // Read the streaming flags BEFORE clearing them for the next message.
      var streamedText = sawTextDelta;
      var streamedThinking = sawThinkingDelta;
      resetMessageState();
      if (!msg) return [];
      // A toolResult "message" is the tool's output, already rendered as a
      // tool_result entry. Emitting it here dumps whole files as prose.
      if (msg.role !== "assistant") return [];
      if (streamedText || streamedThinking) return [];
      var parts = extractTextContent(msg.content);
      var out = [];
      if (parts.thinking) out.push({ kind: "thinking", ts: ts, text: parts.thinking });
      if (parts.text) out.push({ kind: "assistant", ts: ts, text: parts.text });
      return out;
    }

    if (type === "turn_end") {
      // turn_end restates the turn's assistant message and its tool results.
      // Both were already emitted; only surface tool results never seen.
      var results = Array.isArray(parsed.toolResults) ? parsed.toolResults : [];
      var entries = [];
      for (var j = 0; j < results.length; j++) {
        var tr = results[j];
        if (!tr || typeof tr !== "object") continue;
        var trId = asString(tr.toolCallId);
        if (!trId || emittedToolResults.has(trId)) continue;
        emittedToolResults.add(trId);
        var pending = pendingToolCalls.get(trId);
        entries.push({
          kind: "tool_result",
          ts: ts,
          toolUseId: trId,
          toolName: asString(tr.toolName, (pending && pending.toolName) || "tool"),
          content: stringifyToolPayload(tr.content),
          isError: tr.isError === true,
        });
        pendingToolCalls.delete(trId);
      }
      resetMessageState();
      return entries;
    }

    if (type === "tool_execution_start") {
      var startId = asString(parsed.toolCallId, "tool-" + Date.now());
      if (emittedToolCalls.has(startId)) return [];
      emittedToolCalls.add(startId);
      var startName = asString(parsed.toolName, "tool");
      pendingToolCalls.set(startId, { toolName: startName });
      return [
        { kind: "tool_call", ts: ts, name: startName, input: parsed.args, toolUseId: startId },
      ];
    }

    if (type === "tool_execution_end") {
      var endId = asString(parsed.toolCallId, "tool-" + Date.now());
      if (emittedToolResults.has(endId)) return [];
      emittedToolResults.add(endId);
      var endName = asString(parsed.toolName, "tool");
      pendingToolCalls.delete(endId);
      return [
        {
          kind: "tool_result",
          ts: ts,
          toolUseId: endId,
          toolName: endName,
          content: stringifyToolPayload(parsed.result),
          isError: parsed.isError === true,
        },
      ];
    }

    // Unknown structured event: drop it. Printing the raw JSON is what made
    // the transcript unreadable; an unrecognised control event has no place
    // in a human-facing chat view.
    return [];
  }

  function reset() {
    pendingToolCalls.clear();
    emittedToolResults.clear();
    emittedToolCalls.clear();
    resetMessageState();
    buffer = "";
  }

  return { parseLine: parseLine, reset: reset };
}

// Stateless convenience entry point (the host may call either export).
var defaultParser = createStdoutParser();
function parseStdoutLine(line, ts) {
  return defaultParser.parseLine(line, ts);
}

module.exports = { createStdoutParser: createStdoutParser, parseStdoutLine: parseStdoutLine };
