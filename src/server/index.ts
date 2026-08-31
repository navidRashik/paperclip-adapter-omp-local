import type {
  AdapterRuntimeCommandSpec,
  AdapterSessionCodec,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { type as adapterType, agentConfigurationDoc, modelProfiles } from "../index.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.session)
    );
  },
};

import { execute as ompExecute } from "./execute.js";
import { listOmpSkills, syncOmpSkills } from "./skills.js";
import { testEnvironment as ompTestEnvironment } from "./test.js";
import { listOmpModels } from "./models.js";

function buildRuntimeCommandSpec(
  config: Record<string, unknown>,
): AdapterRuntimeCommandSpec {
  const configured = typeof config.command === "string" ? config.command.trim() : "";
  const command = configured.length > 0 ? configured : "omp";
  return { command, detectCommand: command, installCommand: null };
}

/**
 * Plugin-loader entry point. Paperclip's external adapter loader imports the
 * package root and calls this factory to obtain the ServerAdapterModule.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: adapterType,
    runtimeToolDelivery: "environment",
    execute: ompExecute,
    testEnvironment: ompTestEnvironment,
    listSkills: listOmpSkills,
    syncSkills: syncOmpSkills,
    sessionCodec,
    models: [],
    modelProfiles,
    listModels: listOmpModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    getRuntimeCommandSpec: buildRuntimeCommandSpec,
    agentConfigurationDoc,
  };
}

export { execute } from "./execute.js";
export { listOmpSkills, syncOmpSkills, listPiSkills, syncPiSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  listOmpModels,
  discoverOmpModels,
  discoverOmpModelsCached,
  ensureOmpModelConfiguredAndAvailable,
  resetOmpModelsCacheForTests,
} from "./models.js";
export { parseOmpJsonl, isOmpUnknownSessionError } from "./parse.js";
