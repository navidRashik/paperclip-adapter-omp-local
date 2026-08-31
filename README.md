# paperclip-adapter-omp-local

[![npm](https://img.shields.io/npm/v/paperclip-adapter-omp-local.svg)](https://www.npmjs.com/package/paperclip-adapter-omp-local)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A [Paperclip](https://paperclip.ing) **external adapter** that runs [OMP ("Oh My Pi")](https://github.com/badlogic/pi-mono) as a first-class local agent runtime.

Paperclip ships native adapters for Claude Code, Codex, OpenCode, pi, Gemini, Grok, Kimi and Cursor — but not OMP. The usual workaround is a `process` adapter pointing at a hand-rolled shell script, which gives you no model list, no session resume, no skill sync, and a run log that renders as undifferentiated plain text.

This adapter makes OMP a real citizen: structured transcripts, model discovery, session continuity across heartbeats, and Paperclip skill sync.

---

## Features

| Capability | Supported | Notes |
|---|---|---|
| Structured run transcripts | ✅ | Parses OMP's `--mode json` JSONL into tool calls, tool results, thinking blocks, assistant text, and token/cost totals |
| Session resume across heartbeats | ✅ | Paperclip-managed `--session-dir` + `--resume <sessionId>`, guarded by a cwd match |
| Model discovery | ✅ | `omp models ls --json`, cached, surfaced in the agent settings dropdown |
| Fuzzy model selection | ✅ | `opus`, `claude-sonnet-5`, or a full `provider/model` selector |
| Paperclip skill sync | ✅ | `paperclipSkillSync.desiredSkills` materialized to disk for OMP to discover |
| Managed instructions bundle | ✅ | `AGENTS.md` appended via `--append-system-prompt` |
| Local agent JWT | ✅ | `PAPERCLIP_API_KEY` injected as a short-lived run token |
| Remote execution targets | ✅ | ssh / sandbox execution targets with workspace round-trip |
| Thinking levels | ✅ | `off, minimal, low, medium, high, xhigh, max, auto` |

## Requirements

- Paperclip with external adapter plugin support (`@paperclipai/adapter-utils >= 2026.831.0-canary.13`)
- The `omp` CLI on `PATH` of whatever machine executes runs
- Node.js >= 22

> OMP is distributed as a standalone binary, not an npm package, so this adapter is **detect-only**: if `omp` is missing, Paperclip reports it as missing rather than attempting an `npm install -g`. Install OMP yourself first and verify with `omp --version`.

## Install

### From npm

Via the Paperclip UI: **Settings → Adapters → Install from npm** → `paperclip-adapter-omp-local`

Or via the API:

```bash
curl -X POST "$PAPERCLIP_API_URL/api/adapters" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"packageName": "paperclip-adapter-omp-local"}'
```

### From a local checkout (development)

```bash
git clone https://github.com/navidRashik/paperclip-adapter-omp-local
cd paperclip-adapter-omp-local
npm install
npm run build

curl -X POST "$PAPERCLIP_API_URL/api/adapters" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"localPath\": \"$PWD\"}"
```

### By hand

Add a record to `$PAPERCLIP_HOME/adapter-plugins.json` (defaults to `~/.paperclip/adapter-plugins.json`):

```json
[
  {
    "packageName": "paperclip-adapter-omp-local",
    "localPath": "/absolute/path/to/paperclip-adapter-omp-local",
    "type": "omp_local",
    "installedAt": "2026-01-01T00:00:00.000Z"
  }
]
```

Restart the Paperclip server. You should see:

```
Loading external adapter package {"packageName":"paperclip-adapter-omp-local","hasUiParser":true}
Loaded UI parser from adapter package
Loaded external adapters from plugin store {"count":1,"adapters":["omp_local"]}
```

Confirm it registered:

```bash
curl -s "$PAPERCLIP_API_URL/api/adapters" | jq '.[] | select(.type=="omp_local")'
```

## Usage

Create or edit an agent with `adapterType: "omp_local"`.

### Minimal config

```json
{
  "adapterType": "omp_local",
  "adapterConfig": {
    "model": "google-vertex/claude-opus-4-8@default"
  }
}
```

### Full config reference

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | OMP model id. Full selector (`provider/model`) or fuzzy alias (`opus`). Passed as `--model`. |
| `command` | string | | Path or name of the OMP binary. Defaults to `omp`. |
| `cwd` | string | | Absolute default working directory. Created if missing when possible. Overridden by the issue's execution workspace. |
| `instructionsFilePath` | string | | Absolute path to a markdown instructions file appended via `--append-system-prompt`. Managed for you when the instructions bundle is enabled. |
| `promptTemplate` | string | | Template for the user prompt; `{{variable}}` substitution. |
| `thinking` | string | | `off, minimal, low, medium, high, xhigh, max, auto` |
| `env` | object | | Extra environment variables, e.g. `{"OMP_ROLE": {"type": "plain", "value": "qa"}}` |
| `timeoutSec` | number | | Run timeout in seconds. `0` disables. |
| `graceSec` | number | | SIGTERM grace period before SIGKILL. |
| `paperclipSkillSync.desiredSkills` | string[] | | Skills materialized for the run, e.g. `["paperclipai/paperclip/paperclip"]` |

### Migrating off a `process` shim

If you currently run OMP through a shell script on the `process` adapter, replace the whole thing:

```diff
- "adapterType": "process",
- "adapterConfig": {
-   "command": "/path/to/omp-runner.sh",
-   "cwd": "/path/to/repo",
-   "timeoutSec": 3600
- }
+ "adapterType": "omp_local",
+ "adapterConfig": {
+   "model": "google-vertex/claude-opus-4-8@default",
+   "timeoutSec": 3600
+ }
```

You can delete the script's prompt-building, checkout, comment-posting, stall watchdog, and concurrency-slot logic — Paperclip's heartbeat runtime already does all of it.

## How it works

The adapter invokes OMP in non-interactive JSON mode:

```
omp -p --mode json --model <model> --session-dir <paperclip-managed> [--resume <id>] \
    [--append-system-prompt <instructions>] [--thinking <level>] <prompt>
```

- **stdout** is JSONL. `src/server/parse.ts` extracts session id, token usage, cost, and errors for the server; `ui-parser.cjs` converts the same stream into UI transcript entries.
- **Sessions** persist in `sessionParams` between heartbeats and are only resumed when the recorded cwd matches the current execution workspace, so a moved worktree starts fresh instead of replaying stale context.
- **Unknown-session errors** are detected and retried once with a fresh session (`clearSession: true`).

### Package layout

```
src/
  index.ts              # type/label/doc metadata + createServerAdapter re-export
  server/
    index.ts            # createServerAdapter() factory, session codec
    execute.ts          # process spawn, session/prompt/env assembly
    models.ts           # `omp models ls --json` discovery + cache
    parse.ts            # JSONL → usage, session id, errors
    skills.ts           # Paperclip skill sync
    test.ts             # environment diagnostics
    runtime-config.ts
  ui/                   # in-tree transcript helpers
  cli/                  # terminal event formatter
ui-parser.cjs           # zero-import UI parser served to the browser
```

## Troubleshooting

**Adapter doesn't appear after restart.** Check the server log for `Failed to dynamically load external adapter`. Most often the package root is missing the `createServerAdapter` export, or `dist/` was never built.

**Transcript renders as flat text.** The UI parser did not load. Verify `GET /api/adapters/omp_local/ui-parser.js` returns 200 and that `package.json` has both `exports["./ui-parser"]` and `paperclip.adapterUiParser: "1.0.0"`.

**"omp: command not found".** The adapter is detect-only by design. Install OMP on the execution host, or set `adapterConfig.command` to an absolute path.

**Sessions never resume.** Expected when the execution workspace changes between heartbeats — the cwd guard forces a fresh session. The run log states this explicitly.

## Contributing

Issues and PRs welcome — especially for OMP event shapes this parser doesn't cover yet.

```bash
npm install
npm run typecheck
npm run build
```

For local iteration, register the adapter by `localPath` and restart Paperclip to pick up changes.

## Credits

Derived from the `pi-local` adapter in [Paperclip](https://github.com/paperclipai/paperclip) (MIT, © Paperclip AI), adapted for OMP's CLI surface and event stream.

## License

MIT — see [LICENSE](./LICENSE).
