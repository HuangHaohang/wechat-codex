export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "never" | "on-request";
export type CapabilityState = "yes" | "no" | "unknown";
export type ProviderType = "openai-compatible" | "codex";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type Personality = "none" | "friendly" | "pragmatic";

export interface MediaAttachment {
  type: "image" | "voice" | "video" | "file";
  url?: string;
  dataUrl?: string;
  fileName?: string;
  mimeType?: string;
  transcriptText?: string;
}

export interface InboundMessage {
  id: string;
  channel: string;
  senderId: string;
  text: string;
  media?: MediaAttachment[];
  replyToken?: string;
  timestamp: number;
}

export interface OutboundMessage {
  targetId: string;
  text?: string;
  replyToken?: string;
  media?: MediaAttachment[];
}

export interface Channel {
  readonly name: string;
  login(): Promise<void>;
  start(onMessage: (message: InboundMessage) => void): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  sendTyping?(userId: string, replyToken?: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ProviderCapabilities {
  chatCompletions: CapabilityState;
  responses: CapabilityState;
  toolCalls: CapabilityState;
  vision: CapabilityState;
  imageGeneration: CapabilityState;
  audioTranscription: CapabilityState;
}

export interface ModelCatalogEntry {
  id: string;
  vision?: boolean;
  imageGeneration?: boolean;
  preferredForVision?: boolean;
  preferredForDrawing?: boolean;
}

export interface ProviderQueryOptions {
  sessionId: string;
  codexHome?: string;
  provider?: string;
  model?: string;
  workspace?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  reasoningEffort?: ReasoningEffort;
  personality?: Personality;
  systemPrompt?: string;
  media?: MediaAttachment[];
  search?: boolean;
  mcpTools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  mcpCallTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface ProviderImageResult {
  media: MediaAttachment;
  revisedPrompt?: string;
}

export interface ProviderApprovalRequest {
  reason: string;
  suggestedSandbox: SandboxMode;
}

export interface ProviderQueryResult {
  text: string;
  approvalRequest?: ProviderApprovalRequest;
}

export interface Provider {
  readonly name: string;
  readonly type: ProviderType;
  query(prompt: string, options: ProviderQueryOptions): Promise<ProviderQueryResult>;
  listModels?(): Promise<ModelCatalogEntry[]>;
  getCapabilities?(): Promise<ProviderCapabilities>;
  generateImage?(prompt: string, model: string): Promise<ProviderImageResult>;
  resetSession?(sessionId: string): void;
}

export interface ChannelConfig {
  type: "weixin";
  enabled?: boolean;
  baseUrl?: string;
}

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  models?: ModelCatalogEntry[];
  enabled?: boolean;
  preferredVisionModel?: string;
  preferredImageModel?: string;
  capabilities?: Partial<ProviderCapabilities>;
  command?: string;
}

export interface SkillConfig {
  description?: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
}

export interface UserPreference {
  provider?: string;
  model?: string;
  skill?: string;
  search?: boolean;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  reasoningEffort?: ReasoningEffort;
  personality?: Personality;
  planMode?: boolean;
  thread?: string;
}

export interface PendingApprovalState {
  sessionId: string;
  prompt: string;
  media?: MediaAttachment[];
  workspace: string;
  provider: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  personality?: Personality;
  systemPrompt?: string;
  search: boolean;
  suggestedSandbox: SandboxMode;
  reason: string;
  createdAt: number;
}

export interface ResolvedUserPreference {
  provider: string;
  model?: string;
  search: boolean;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  reasoningEffort?: ReasoningEffort;
  personality?: Personality;
  planMode: boolean;
  thread: string;
}

export interface SecurityConfig {
  allowedUserIds: string[];
}

export interface McpServerConfig {
  transport?: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface LegacyCodexConfig {
  command?: string;
  model?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  search?: boolean;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
}

export interface WechatCodexConfig {
  defaultWorkspace: string;
  allowedWorkspaceRoots: string[];
  codexHome: string;
  channels: Record<string, ChannelConfig>;
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
  systemPrompt?: string;
  security: SecurityConfig;
  mcpServers?: Record<string, McpServerConfig>;
  skills?: Record<string, SkillConfig>;
  userWorkspaces?: Record<string, string>;
  userPreferences?: Record<string, UserPreference>;
  pendingApprovals?: Record<string, PendingApprovalState>;
  codex?: LegacyCodexConfig;
}

export interface Context {
  message: InboundMessage;
  preference: ResolvedUserPreference;
  provider?: Provider;
  prompt?: string;
  systemPrompt?: string;
  response?: OutboundMessage;
  state: Record<string, unknown>;
}

export type NextFunction = () => Promise<void>;
export type Middleware = (ctx: Context, next: NextFunction) => Promise<void>;
