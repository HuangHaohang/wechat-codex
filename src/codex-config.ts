import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { getDefaultCodexHome } from "./config.js";
import { resolveEnvVar } from "./env.js";
import type { ModelCatalogEntry } from "./types.js";

interface RawTomlTable {
  [key: string]: unknown;
}

export interface CodexCliProvider {
  id: string;
  name: string;
  baseUrl?: string;
  envKey?: string;
  experimentalBearerToken?: string;
  httpHeaders: Record<string, string>;
  envHttpHeaders: Record<string, string>;
  queryParams: Record<string, string>;
  requiresOpenAIAuth: boolean;
}

export interface CodexCliState {
  codexHome: string;
  configPath: string;
  exists: boolean;
  profile?: string;
  effectiveProvider: string;
  effectiveModel?: string;
  providers: Record<string, CodexCliProvider>;
}

export function loadCodexCliState(codexHome = resolveCodexHome()): CodexCliState {
  const configPath = getCodexConfigPath(codexHome);
  if (!existsSync(configPath)) {
    return {
      codexHome,
      configPath,
      exists: false,
      effectiveProvider: "openai",
      providers: {
        openai: builtInOpenAIProvider(undefined),
      },
    };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as RawTomlTable;
  const selectedProfile = asString(parsed.profile);
  const profileOverrides = getNestedTable(parsed, "profiles", selectedProfile);

  const effectiveProvider = asString(profileOverrides?.model_provider)
    || asString(parsed.model_provider)
    || "openai";
  const effectiveModel = asString(profileOverrides?.model) || asString(parsed.model);
  const openaiBaseUrl = asString(profileOverrides?.openai_base_url) || asString(parsed.openai_base_url);

  const mergedProviders = {
    ...toTable(getNestedValue(parsed, "model_providers")),
    ...toTable(profileOverrides?.model_providers),
  };
  const providers = buildProviders(mergedProviders, openaiBaseUrl, effectiveProvider);

  return {
    codexHome,
    configPath,
    exists: true,
    profile: selectedProfile,
    effectiveProvider,
    effectiveModel,
    providers,
  };
}

export function listCodexProviders(state: CodexCliState): string[] {
  return Object.keys(state.providers).sort();
}

export async function discoverCodexProviderModels(
  providerId: string,
  state: CodexCliState = loadCodexCliState(),
): Promise<ModelCatalogEntry[]> {
  const provider = state.providers[providerId];
  if (!provider) {
    throw new Error(`Provider "${providerId}" is not defined in ${state.configPath}.`);
  }
  if (!provider.baseUrl) {
    throw new Error(`Provider "${providerId}" has no OpenAI-compatible base URL, so /models cannot query it.`);
  }

  const url = new URL(`${trimTrailingSlash(provider.baseUrl)}/models`);
  for (const [key, value] of Object.entries(provider.queryParams)) {
    url.searchParams.set(key, value);
  }

  const headers = new Headers(provider.httpHeaders);
  for (const [header, envVar] of Object.entries(provider.envHttpHeaders)) {
    const value = resolveEnvVar(envVar);
    if (value) {
      headers.set(header, value);
    }
  }

  const bearerToken = provider.experimentalBearerToken
    || resolveEnvVar(provider.envKey)
    || undefined;
  if (bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`Provider "${providerId}" /models failed: HTTP ${res.status} ${text}`.trim());
  }

  const json = await res.json() as { data?: Array<{ id?: string }> };
  const models = (json.data || [])
    .map((item) => item.id?.trim())
    .filter((item): item is string => Boolean(item))
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({ id }));

  if (models.length === 0) {
    throw new Error(`Provider "${providerId}" returned no models.`);
  }

  return models;
}

function resolveCodexHome(): string {
  return process.env.WECHAT_CODEX_CODEX_HOME
    || process.env.CODEX_HOME
    || getDefaultCodexHome()
    || join(homedir(), ".codex");
}

function getCodexConfigPath(codexHome: string): string {
  return join(codexHome, "config.toml");
}

function buildProviders(
  rawProviders: RawTomlTable,
  openaiBaseUrl: string | undefined,
  effectiveProvider: string,
): Record<string, CodexCliProvider> {
  const providers: Record<string, CodexCliProvider> = {};

  for (const [id, value] of Object.entries(rawProviders)) {
    const table = toTable(value);
    providers[id] = {
      id,
      name: asString(table.name) || id,
      baseUrl: asString(table.base_url),
      envKey: asString(table.env_key),
      experimentalBearerToken: asString(table.experimental_bearer_token),
      httpHeaders: toStringRecord(table.http_headers),
      envHttpHeaders: toStringRecord(table.env_http_headers),
      queryParams: toStringRecord(table.query_params),
      requiresOpenAIAuth: asBoolean(table.requires_openai_auth) || false,
    };
  }

  if (!providers.openai) {
    providers.openai = builtInOpenAIProvider(openaiBaseUrl);
  } else if (!providers.openai.baseUrl) {
    providers.openai.baseUrl = builtInOpenAIProvider(openaiBaseUrl).baseUrl;
  }

  if (!providers[effectiveProvider]) {
    providers[effectiveProvider] = {
      id: effectiveProvider,
      name: effectiveProvider,
      baseUrl: effectiveProvider === "openai" ? builtInOpenAIProvider(openaiBaseUrl).baseUrl : undefined,
      envKey: effectiveProvider === "openai" ? "OPENAI_API_KEY" : undefined,
      experimentalBearerToken: undefined,
      httpHeaders: {},
      envHttpHeaders: {},
      queryParams: {},
      requiresOpenAIAuth: false,
    };
  }

  return providers;
}

function builtInOpenAIProvider(baseUrl: string | undefined): CodexCliProvider {
  return {
    id: "openai",
    name: "openai",
    baseUrl: normalizeOpenAIBaseUrl(baseUrl || "https://api.openai.com/v1"),
    envKey: "OPENAI_API_KEY",
    experimentalBearerToken: undefined,
    httpHeaders: {},
    envHttpHeaders: {},
    queryParams: {},
    requiresOpenAIAuth: false,
  };
}

function getNestedTable(root: RawTomlTable, tableName: string, key: string | undefined): RawTomlTable | undefined {
  if (!key) {
    return undefined;
  }
  const table = toTable(getNestedValue(root, tableName));
  const value = table[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawTomlTable) : undefined;
}

function getNestedValue(root: RawTomlTable, key: string): unknown {
  return root[key];
}

function toTable(value: unknown): RawTomlTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as RawTomlTable;
}

function toStringRecord(value: unknown): Record<string, string> {
  const table = toTable(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(table)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeOpenAIBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/v1";
    }
    return trimTrailingSlash(url.toString());
  } catch {
    return trimTrailingSlash(baseUrl);
  }
}
