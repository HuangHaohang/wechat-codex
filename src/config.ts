import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ModelCatalogEntry,
  ProviderCapabilities,
  ProviderConfig,
  WechatCodexConfig,
} from "./types.js";

const DATA_DIR = join(homedir(), ".wechat-codex");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CODEX_HOME = join(PROJECT_ROOT, "codex-home");
const DEFAULT_CODEX_CONFIG = join(DEFAULT_CODEX_HOME, "config.toml");
const DEFAULT_PROJECT_CODEX_CONFIG = [
  "# Project-local Codex config for wechat-codex.",
  "# This file is intentionally separate from ~/.codex/config.toml.",
  "# Edit this file after cloning. Keep secrets in environment variables, not here.",
  "",
  "model_provider = \"openai\"",
  "model = \"gpt-5.4\"",
  "model_reasoning_effort = \"high\"",
  "personality = \"pragmatic\"",
  "",
  "# Add your OpenAI-compatible providers here. Example:",
  "# [model_providers.qwen]",
  "# name = \"Qwen\"",
  "# base_url = \"https://dashscope.aliyuncs.com/compatible-mode/v1\"",
  "# env_key = \"DASHSCOPE_API_KEY\"",
  "# wire_api = \"responses\"",
  "",
  "# Example generic custom provider:",
  "# [model_providers.custom]",
  "# name = \"Custom\"",
  "# base_url = \"https://your-openai-compatible-gateway.example/v1\"",
  "# env_key = \"YOUR_CUSTOM_API_KEY\"",
  "# wire_api = \"responses\"",
].join("\n");

function defaultWorkspace(): string {
  return resolve(process.cwd());
}

function defaultCodexHome(): string {
  return DEFAULT_CODEX_HOME;
}

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    chatCompletions: "yes",
    responses: "unknown",
    toolCalls: "unknown",
    vision: "unknown",
    imageGeneration: "unknown",
    audioTranscription: "unknown",
    ...overrides,
  };
}

function models(...items: Array<string | [string, Partial<ModelCatalogEntry>]>) {
  return items.map((item) => {
    if (typeof item === "string") {
      return { id: item };
    }
    const [id, options] = item;
    return { id, ...options };
  });
}

export const PROVIDER_PRESETS: Record<string, ProviderConfig> = {
  openai: {
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    preferredVisionModel: "gpt-4.1",
    preferredImageModel: "gpt-image-1",
    models: models(
      "gpt-5.4",
      "gpt-5.4-mini",
      ["gpt-4.1", { vision: true, preferredForVision: true }],
      ["gpt-image-1", { imageGeneration: true, preferredForDrawing: true }],
    ),
    capabilities: capabilities({
      responses: "yes",
      toolCalls: "yes",
      vision: "yes",
      imageGeneration: "yes",
      audioTranscription: "yes",
    }),
  },
  qwen: {
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    preferredVisionModel: "qwen-vl-max",
    models: models(
      "qwen-plus",
      "qwen-max",
      "qwen-turbo",
      ["qwen-vl-max", { vision: true, preferredForVision: true }],
    ),
    capabilities: capabilities(),
  },
  deepseek: {
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: models(
      "deepseek-chat",
      "deepseek-reasoner",
    ),
    capabilities: capabilities(),
  },
  gemini: {
    type: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    preferredVisionModel: "gemini-2.0-flash",
    preferredImageModel: "gemini-2.0-flash-preview-image-generation",
    models: models(
      ["gemini-2.0-flash", { vision: true, preferredForVision: true }],
      "gemini-2.5-pro",
      ["gemini-2.0-flash-preview-image-generation", { imageGeneration: true, preferredForDrawing: true }],
    ),
    capabilities: capabilities({
      vision: "yes",
    }),
  },
  minimax: {
    type: "openai-compatible",
    baseUrl: "https://api.minimax.chat/v1",
    defaultModel: "MiniMax-Text-01",
    models: models("MiniMax-Text-01"),
    capabilities: capabilities(),
  },
  glm: {
    type: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    preferredVisionModel: "glm-4v-plus",
    models: models(
      "glm-4-plus",
      ["glm-4v-plus", { vision: true, preferredForVision: true }],
    ),
    capabilities: capabilities(),
  },
  custom: {
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    models: models("gpt-5.4"),
    capabilities: capabilities(),
  },
  codex: {
    type: "codex",
    command: "codex",
    defaultModel: "gpt-5.4",
    models: models("gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"),
    capabilities: capabilities({
      responses: "yes",
      toolCalls: "yes",
      vision: "yes",
      imageGeneration: "no",
      audioTranscription: "no",
    }),
  },
};

const DEFAULT_CONFIG: WechatCodexConfig = {
  defaultWorkspace: defaultWorkspace(),
  allowedWorkspaceRoots: [defaultWorkspace()],
  codexHome: defaultCodexHome(),
  channels: {
    weixin: {
      type: "weixin",
      enabled: true,
    },
  },
  defaultProvider: "openai",
  providers: structuredClone(PROVIDER_PRESETS),
  systemPrompt: "You are a helpful AI assistant. Always reply in the same language as the user.",
  security: {
    allowedUserIds: [],
  },
  mcpServers: {},
  skills: {},
  userWorkspaces: {},
  userPreferences: {},
};

export async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function loadConfig(): Promise<WechatCodexConfig> {
  await ensureDir(DATA_DIR);
  await ensureCodexHome(DEFAULT_CODEX_HOME);

  if (!existsSync(CONFIG_PATH)) {
    await saveConfig(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  const raw = stripUtf8Bom(await readFile(CONFIG_PATH, "utf-8"));
  const user = JSON.parse(raw) as Partial<WechatCodexConfig>;
  const migrated = migrateLegacyConfig(user);

  const merged = {
    ...DEFAULT_CONFIG,
    ...migrated,
    channels: { ...DEFAULT_CONFIG.channels, ...migrated.channels },
    providers: mergeProviders(migrated.providers),
    security: { ...DEFAULT_CONFIG.security, ...migrated.security },
    mcpServers: migrated.mcpServers || {},
    skills: migrated.skills || {},
    userWorkspaces: migrated.userWorkspaces || {},
    userPreferences: migrated.userPreferences || {},
  };
  merged.codexHome = resolve(merged.codexHome);
  await ensureCodexHome(merged.codexHome);
  return merged;
}

export async function saveConfig(config: WechatCodexConfig): Promise<void> {
  await ensureDir(DATA_DIR);
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function getDataDir(): string {
  return DATA_DIR;
}

export function getAccountsDir(): string {
  return join(DATA_DIR, "accounts");
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export function getDefaultCodexHome(): string {
  return DEFAULT_CODEX_HOME;
}

export function getDefaultCodexConfigPath(): string {
  return DEFAULT_CODEX_CONFIG;
}

function mergeProviders(userProviders: Record<string, ProviderConfig> | undefined): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = structuredClone(PROVIDER_PRESETS);
  for (const [name, config] of Object.entries(userProviders || {})) {
    const preset = merged[name];
    merged[name] = {
      ...(preset || {}),
      ...config,
      baseUrl: config.type === "openai-compatible" && config.baseUrl
        ? normalizeOpenAIBaseUrl(config.baseUrl)
        : (config.baseUrl || preset?.baseUrl),
      models: config.models || preset?.models || [],
      capabilities: {
        ...(preset?.capabilities || capabilities()),
        ...(config.capabilities || {}),
      },
    };
  }
  return merged;
}

function migrateLegacyConfig(user: Partial<WechatCodexConfig>): Partial<WechatCodexConfig> {
  if (user.providers && user.defaultProvider) {
    return user;
  }

  const legacyCodex = user.codex || {};
  const legacyBaseUrl = normalizeBaseUrl(legacyCodex.openAiBaseUrl);
  const legacyKey = legacyCodex.openAiApiKey;
  const legacyModel = legacyCodex.model;
  const providers = mergeProviders(user.providers);

  if (legacyBaseUrl && legacyBaseUrl !== normalizeBaseUrl(PROVIDER_PRESETS.openai.baseUrl)) {
    providers.custom = {
      ...providers.custom,
      baseUrl: normalizeOpenAIBaseUrl(legacyBaseUrl),
      apiKey: legacyKey,
      defaultModel: legacyModel || providers.custom.defaultModel,
      models: legacyModel ? models(legacyModel) : providers.custom.models,
    };
  } else {
    providers.openai = {
      ...providers.openai,
      apiKey: legacyKey || providers.openai.apiKey,
      defaultModel: legacyModel || providers.openai.defaultModel,
      models: upsertModel(providers.openai.models || [], legacyModel),
    };
    providers.custom = {
      ...providers.custom,
      defaultModel: legacyModel || providers.custom.defaultModel,
      models: upsertModel(providers.custom.models || [], legacyModel),
    };
  }

  return {
    ...user,
    defaultProvider: legacyBaseUrl && legacyBaseUrl !== normalizeBaseUrl(PROVIDER_PRESETS.openai.baseUrl)
      ? "custom"
      : (user.defaultProvider || "openai"),
    providers,
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl?.replace(/\/+$/, "");
}

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl) || baseUrl;
  try {
    const url = new URL(normalized);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/v1";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function upsertModel(existing: ModelCatalogEntry[], candidate: string | undefined): ModelCatalogEntry[] {
  if (!candidate) {
    return existing;
  }
  if (existing.some((entry) => entry.id === candidate)) {
    return existing;
  }
  return [{ id: candidate }, ...existing];
}

async function ensureCodexHome(codexHome: string): Promise<void> {
  const resolvedHome = resolve(codexHome);
  const configPath = join(resolvedHome, "config.toml");
  await ensureDir(resolvedHome);
  if (!existsSync(configPath)) {
    await writeFile(configPath, DEFAULT_PROJECT_CODEX_CONFIG, "utf-8");
  }
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
