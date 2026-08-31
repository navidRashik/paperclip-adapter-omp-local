import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

// Required by the plugin-loader convention: the package root must export a
// createServerAdapter() factory that returns the ServerAdapterModule.
export { createServerAdapter } from "./server/index.js";

export const type = "omp_local";
export const label = "OMP";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@latest";

export const models: Array<{ id: string; label: string }> = [];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# omp_local agent configuration

Adapter: omp_local

OMP ("Oh My Pi") is the pi-based coding agent CLI. This adapter runs the \`omp\`
binary as the local agent runtime. It is the first-class, native path for
running OMP agents in Paperclip (no shell shim).

Use when:
- You want Paperclip to run OMP (Oh My Pi) locally as the agent runtime
- You want fuzzy model routing in OMP format (--model <provider/model> or a fuzzy alias)
- You want OMP session resume across heartbeats via --session-dir + --resume
- You need OMP's tool set (read, bash, edit, write, grep, glob, etc.)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- The \`omp\` CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed as the final message argument
- model (string, required): OMP model id. Accepts provider/model (e.g. anthropic/claude-opus) or a fuzzy alias (e.g. opus). Passed as --model.
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh, max, auto)
- command (string, optional): defaults to "omp"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- OMP resolves models with fuzzy matching, so an explicit provider flag is not required; pass the full id via \`model\`.
- Sessions are stored under a Paperclip-managed --session-dir and resumed with --resume <sessionId>.
- Tools are enabled by default; Paperclip does not restrict the OMP tool set.
- Agent instructions are appended to OMP's system prompt via --append-system-prompt, while the user task is sent as the final message argument in --print (-p) mode with --mode json.
`;
