import { createLogger } from "../logger.js";
import { resolveEnvVar } from "../env.js";
import type {
  CapabilityState,
  MediaAttachment,
  ModelCatalogEntry,
  Provider,
  ProviderQueryResult,
  ProviderCapabilities,
  ProviderConfig,
  ProviderImageResult,
  ProviderQueryOptions,
} from "../types.js";

const log = createLogger("openai-provider");
const MAX_HISTORY = 24;
const MAX_TOOL_ROUNDS = 8;

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
}

interface ResponsesResponse {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
}

export class OpenAICompatibleProvider implements Provider {
  readonly type = "openai-compatible" as const;
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly modelCache = new Map<string, ModelCatalogEntry[]>();
  private capabilitiesCache: ProviderCapabilities | null = null;

  constructor(
    readonly name: string,
    private readonly config: ProviderConfig,
  ) {}

  async query(prompt: string, options: ProviderQueryOptions): Promise<ProviderQueryResult> {
    const model = options.model || this.config.defaultModel;
    if (!model) {
      throw new Error(`Provider "${this.name}" has no model configured.`);
    }

    log.info(`Querying ${this.name} (model: ${model}, session: ${options.sessionId})`);

    if (options.search) {
      const capabilities = await this.getCapabilities();
      if (capabilities.responses === "yes") {
        const text = await this.queryResponses(prompt, { ...options, model });
        log.info(`Response: ${text.length} chars`);
        return { text };
      }
      throw new Error(`Provider "${this.name}" does not support OpenAI Responses search.`);
    }

    const text = await this.queryChat(prompt, { ...options, model });
    log.info(`Response: ${text.length} chars`);
    return { text };
  }

  async listModels(): Promise<ModelCatalogEntry[]> {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    const cacheKey = `${baseUrl}:${apiKey}`;
    const cached = this.modelCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json() as { data?: Array<{ id: string }> };
      const discovered = (json.data || []).map((item) => {
        const known = (this.config.models || []).find((entry) => entry.id === item.id);
        return known ? { ...known } : { id: item.id };
      });
      const fallback = mergeUniqueModels(discovered, this.config.models || []);
      this.modelCache.set(cacheKey, fallback);
      return fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`listModels fallback for ${this.name}: ${message}`);
      return this.config.models || [];
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    if (this.capabilitiesCache) {
      return this.capabilitiesCache;
    }

    const base = this.config.capabilities || {};
    const result: ProviderCapabilities = {
      chatCompletions: base.chatCompletions || "yes",
      responses: base.responses || "unknown",
      toolCalls: base.toolCalls || "unknown",
      vision: base.vision || inferVision(this.config.models || []),
      imageGeneration: base.imageGeneration || inferImages(this.config.models || []),
      audioTranscription: base.audioTranscription || "unknown",
    };

    this.capabilitiesCache = result;
    return result;
  }

  async generateImage(prompt: string, model: string): Promise<ProviderImageResult> {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        size: "1024x1024",
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errorText = (await res.text()).slice(0, 500);
      throw new Error(`Image generation failed: ${res.status} ${errorText}`);
    }

    const json = await res.json() as {
      data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
    };
    const item = json.data?.[0];
    if (!item) {
      throw new Error("Image generation returned no image.");
    }

    if (item.b64_json) {
      return {
        media: {
          type: "image",
          dataUrl: `data:image/png;base64,${item.b64_json}`,
          mimeType: "image/png",
        },
        revisedPrompt: item.revised_prompt,
      };
    }

    if (item.url) {
      return {
        media: {
          type: "image",
          url: item.url,
        },
        revisedPrompt: item.revised_prompt,
      };
    }

    throw new Error("Image generation returned an unsupported payload.");
  }

  resetSession(sessionId: string): void {
    this.histories.delete(sessionId);
  }

  private async queryChat(prompt: string, options: ProviderQueryOptions): Promise<string> {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    const history = this.getHistory(options.sessionId);
    const messages = buildMessages(history, prompt, options.systemPrompt, options.media);
    const tools = options.mcpTools;
    const callTool = options.mcpCallTool;
    let reply = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const body: Record<string, unknown> = {
        model: options.model,
        messages,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const errorText = (await res.text()).slice(0, 500);
        throw new Error(`Chat completion failed: ${res.status} ${errorText}`);
      }

      const json = await res.json() as ChatCompletionResponse;
      const choice = json.choices?.[0];
      const message = choice?.message;
      if (!message) {
        throw new Error("Chat completion returned no message.");
      }

      if (!message.tool_calls?.length || !callTool || !tools?.length) {
        reply = typeof message.content === "string" ? message.content : "";
        break;
      }

      messages.push({
        role: "assistant",
        content: typeof message.content === "string" ? message.content : "",
        tool_calls: message.tool_calls,
      });

      for (const toolCall of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = await callTool(toolCall.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    if (!reply.trim()) {
      throw new Error("Model returned no final reply.");
    }

    history.push({
      role: "user",
      content: serializeHistoryContent(prompt, options.media),
    });
    history.push({
      role: "assistant",
      content: reply,
    });
    trimHistory(history);
    return reply.trim();
  }

  private async queryResponses(prompt: string, options: ProviderQueryOptions): Promise<string> {
    const apiKey = this.getApiKey();
    const baseUrl = this.getBaseUrl();
    const input = buildResponsesInput(prompt, options.media);

    const body = {
      model: options.model,
      input,
      instructions: options.systemPrompt,
      tools: [{ type: "web_search_preview" }],
    };

    const res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errorText = (await res.text()).slice(0, 500);
      throw new Error(`Responses query failed: ${res.status} ${errorText}`);
    }

    const json = await res.json() as ResponsesResponse;
    const text = json.output_text || flattenResponsesOutput(json.output || []);
    if (!text.trim()) {
      throw new Error("Responses API returned no text.");
    }
    return text.trim();
  }

  private getHistory(sessionId: string): ChatMessage[] {
    const existing = this.histories.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: ChatMessage[] = [];
    this.histories.set(sessionId, created);
    return created;
  }

  private getApiKey(): string {
    const apiKey = this.config.apiKey || resolveEnvVar(this.config.apiKeyEnv) || "";
    if (!apiKey) {
      throw new Error(`Provider "${this.name}" is missing an API key.`);
    }
    return apiKey.trim();
  }

  private getBaseUrl(): string {
    const baseUrl = this.config.baseUrl;
    if (!baseUrl) {
      throw new Error(`Provider "${this.name}" is missing a baseUrl.`);
    }
    return baseUrl.replace(/\/+$/, "");
  }
}

function buildMessages(
  history: ChatMessage[],
  prompt: string,
  systemPrompt: string | undefined,
  media: MediaAttachment[] | undefined,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(...history.slice(-MAX_HISTORY));

  const images = (media || []).filter((item) => item.type === "image" && (item.url || item.dataUrl));
  if (images.length > 0) {
    const content: ChatContentPart[] = [{ type: "text", text: prompt || "Describe the attached image." }];
    for (const image of images) {
      content.push({
        type: "image_url",
        image_url: { url: image.dataUrl || image.url! },
      });
    }
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: prompt });
  }
  return messages;
}

function buildResponsesInput(prompt: string, media: MediaAttachment[] | undefined) {
  const content: Array<Record<string, unknown>> = [];
  if (prompt.trim()) {
    content.push({ type: "input_text", text: prompt });
  }
  for (const image of media || []) {
    if (image.type !== "image") continue;
    const imageUrl = image.dataUrl || image.url;
    if (!imageUrl) continue;
    content.push({
      type: "input_image",
      image_url: imageUrl,
    });
  }
  return [{
    role: "user",
    content: content.length > 0 ? content : [{ type: "input_text", text: "Help the user." }],
  }];
}

function flattenResponsesOutput(output: ResponsesResponse["output"]): string {
  const parts: string[] = [];
  for (const item of output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function serializeHistoryContent(prompt: string, media: MediaAttachment[] | undefined): string {
  const imageCount = (media || []).filter((item) => item.type === "image").length;
  return imageCount > 0 ? `${prompt}\n[images: ${imageCount}]` : prompt;
}

function trimHistory(history: ChatMessage[]): void {
  while (history.length > MAX_HISTORY) {
    history.shift();
  }
}

function mergeUniqueModels(primary: ModelCatalogEntry[], fallback: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const result: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of [...primary, ...fallback]) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function inferVision(models: ModelCatalogEntry[]): CapabilityState {
  return models.some((item) => item.vision) ? "yes" : "unknown";
}

function inferImages(models: ModelCatalogEntry[]): CapabilityState {
  return models.some((item) => item.imageGeneration) ? "yes" : "unknown";
}
