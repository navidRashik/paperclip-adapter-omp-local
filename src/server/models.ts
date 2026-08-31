import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { asString, parseJson, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const MODELS_CACHE_TTL_MS = 60_000;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

// OMP: `omp models ls --json` emits `{ "models": [{ selector, id, provider, name, ... }] }`.
// The `selector` (e.g. "anthropic/claude-opus") is the canonical, resume-stable id.
function parseModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  // OMP prints the JSON payload on one line; locate the first `{` so any leading
  // non-JSON banner is ignored.
  const braceIndex = stdout.indexOf("{");
  if (braceIndex < 0) return parsed;
  const doc = parseJson(stdout.slice(braceIndex));
  const models = doc && Array.isArray((doc as Record<string, unknown>).models)
    ? ((doc as Record<string, unknown>).models as unknown[])
    : [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const provider = asString(record.provider, "").trim();
    const rawId = asString(record.id, "").trim();
    const selector = asString(record.selector, "").trim();
    const id = selector || (provider && rawId ? `${provider}/${rawId}` : rawId);
    if (!id) continue;
    const name = asString(record.name, "").trim();
    parsed.push({ id, label: name ? `${id} (${name})` : id });
  }
  return parsed;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

function resolveOmpCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OMP_COMMAND === "string" &&
    process.env.PAPERCLIP_OMP_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OMP_COMMAND.trim()
      : "omp";
  return asString(input, envOverride);
}

const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(command: string, cwd: string, env: Record<string, string>) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

export async function discoverOmpModels(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOmpCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  const result = await runChildProcess(
    `omp-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["models", "ls", "--json"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 30,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error("`omp models ls --json` timed out.");
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(
      detail ? `\`omp models ls --json\` failed: ${detail}` : "`omp models ls --json` failed.",
    );
  }

  const output = result.stdout || result.stderr;
  return sortModels(dedupeModels(parseModelsOutput(output)));
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function discoverOmpModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
} = {}): Promise<AdapterModel[]> {
  const command = resolveOmpCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOmpModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

// OMP fuzzy-matches the model argument (e.g. "opus" resolves to a concrete
// provider/model), so an exact match against discovered ids is NOT required for
// a run to succeed. This helper only asserts a model is configured and that
// discovery works; it never throws on a fuzzy id that is absent from the exact
// list. Exact-match feedback is surfaced as a warning in testEnvironment.
export async function ensureOmpModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = asString(input.model, "").trim();
  if (!model) {
    throw new Error("OMP requires `adapterConfig.model` (a provider/model id or a fuzzy alias).");
  }

  let models: AdapterModel[] = [];
  try {
    models = await discoverOmpModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch {
    // Discovery failure is non-fatal here: OMP resolves the model itself at run
    // time and will emit a clear error if the fuzzy id cannot be matched.
    return [];
  }

  return models;
}

export async function listOmpModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOmpModelsCached();
  } catch {
    return [];
  }
}

export function resetOmpModelsCacheForTests() {
  discoveryCache.clear();
}
