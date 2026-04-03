import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { discoverCodexProviderModels, listCodexProviders, loadCodexCliState } from "./codex-config.js";
import { createLogger } from "./logger.js";
import { saveConfig } from "./config.js";
import { WeixinChannel } from "./channels/weixin.js";
import { McpManager } from "./mcp.js";
import { prepareMediaPayload } from "./media.js";
import { CodexProvider, runCodexReview } from "./providers/codex.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import { listInstalledSkills } from "./skills.js";
import type {
  ApprovalPolicy,
  Channel,
  Context,
  InboundMessage,
  MediaAttachment,
  Middleware,
  NextFunction,
  OutboundMessage,
  Provider,
  ProviderConfig,
  ReasoningEffort,
  ResolvedUserPreference,
  SandboxMode,
  Personality,
  WechatCodexConfig,
} from "./types.js";
import type { CodexCliState } from "./codex-config.js";

const log = createLogger("gateway");
const DEBOUNCE_MS = 1500;
const MEDIA_ONLY_DEBOUNCE_MS = 6000;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const OUTBOUND_DEDUP_TTL_MS = 2 * 60 * 1000;

interface MessageBuffer {
  messages: InboundMessage[];
  timer: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
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

export class Gateway {
  private readonly channels = new Map<string, Channel>();
  private readonly providers = new Map<string, Provider>();
  private readonly middlewares: Middleware[] = [];
  private readonly buffers = new Map<string, MessageBuffer>();
  private readonly processing = new Set<string>();
  private readonly queued = new Map<string, InboundMessage[]>();
  private readonly queueNoticeSent = new Set<string>();
  private readonly seenMessages = new Map<string, number>();
  private readonly sentReplies = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly mcp = new McpManager();

  constructor(private readonly config: WechatCodexConfig) {}

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  init(): void {
    for (const [name, channelConfig] of Object.entries(this.config.channels)) {
      if (channelConfig.enabled === false) continue;
      this.channels.set(name, new WeixinChannel(channelConfig));
    }

    for (const [name, providerConfig] of Object.entries(this.config.providers)) {
      if (providerConfig.enabled === false) continue;
      this.providers.set(name, instantiateProvider(name, providerConfig));
    }

    this.use(this.resolveProviderMiddleware.bind(this));
    this.use(this.preparePayloadMiddleware.bind(this));
    this.use(this.applySkillMiddleware.bind(this));
    this.use(this.attachMcpMiddleware.bind(this));
  }

  async start(): Promise<void> {
    await this.mcp.connect(this.config.mcpServers);
    await Promise.all(
      [...this.channels.values()].map((channel) => channel.start((message) => this.handleMessage(message))),
    );
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.channels.values()].map((channel) => channel.stop()));
    await this.mcp.disconnect();
  }

  private handleMessage(message: InboundMessage): void {
    if (this.isDuplicateMessage(message)) {
      return;
    }

    log.info(`收到消息 [${shortUserId(message.senderId)}]: ${summarizeUserText(message.text, message.media)}`);

    const normalizedText = message.text.trim().toLowerCase();
    const allowUnauthedCommand = normalizedText === "/whoami";
    if (!allowUnauthedCommand && !this.isAuthorizedUser(message.senderId)) {
      void this.replyUnauthorized(message);
      return;
    }

    if (message.text.startsWith("/")) {
      void this.handleCommand(message);
      return;
    }

    const key = this.sessionKey(message);
    if (this.processing.has(key)) {
      const queue = this.queued.get(key) || [];
      queue.push(message);
      this.queued.set(key, queue);
      if (!this.queueNoticeSent.has(key)) {
        this.queueNoticeSent.add(key);
        void this.replyQueued(message, queue.length);
      }
      return;
    }

    const existing = this.buffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = setTimeout(() => void this.flushBuffer(key), debounceForMessages(existing.messages));
      return;
    }

    this.buffers.set(key, {
      messages: [message],
      timer: setTimeout(() => void this.flushBuffer(key), debounceForMessages([message])),
    });
  }

  private async flushBuffer(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.buffers.delete(key);

    await this.processMessage(mergeMessages(buffer.messages));

    const pending = this.queued.get(key);
    if (pending?.length) {
      this.queueNoticeSent.delete(key);
      this.queued.delete(key);
      for (const item of pending) {
        this.handleMessage(item);
      }
    }
  }

  private async processMessage(message: InboundMessage): Promise<void> {
    const key = this.sessionKey(message);
    this.processing.add(key);

    try {
      const channel = this.channels.get(message.channel);
      if (!channel) return;

      const ctx: Context = {
        message,
        preference: this.getUserPreference(message.senderId),
        state: {
          channel,
          workspace: this.getWorkspace(message.senderId),
        },
      };

      await this.compose(ctx, [...this.middlewares, this.executeProviderMiddleware.bind(this)]);

      if (ctx.response) {
        await this.sendOnce(channel, ctx.response);
        log.info(`已回复 [${shortUserId(message.senderId)}] (${(ctx.response.text || "").length} 字符)`);
      }
    } catch (error) {
      const channel = this.channels.get(message.channel);
      if (channel) {
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: `Execution failed:\n${error instanceof Error ? error.message : String(error)}`,
        });
      }
      log.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.processing.delete(key);
    }
  }

  private async handleCommand(message: InboundMessage): Promise<void> {
    const channel = this.channels.get(message.channel);
    if (!channel) return;

    const [command, ...rest] = message.text.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    const normalized = command.toLowerCase();
    log.info(`处理命令 [${shortUserId(message.senderId)}]: ${message.text.trim()}`);

    switch (normalized) {
      case "/help":
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: [
            "wechat-codex commands:",
            "/help - show this help",
            "/status - show current workspace and model",
            "/models - list real models from the current Codex provider",
            "/model - show the current provider/model",
            "/model <provider> - switch Codex provider only",
            "/model <provider:model>",
            "/model <model-id> - switch to a real model discovered from provider /models",
            "/skills - list installed Codex skills under this project",
            "/skill - show current skill",
            "/skill <name>|off",
            "/mcp - show MCP server status",
            "/mcp tools - list connected MCP tools",
            "/mcp reload - reconnect configured MCP servers",
            "/mcp connect <name>",
            "/mcp disconnect <name>",
            "/reasoning - show current reasoning effort",
            "/reasoning minimal|low|medium|high|xhigh|default",
            "/personality - show current personality",
            "/personality none|friendly|pragmatic|default",
            "/sandbox - show current sandbox mode",
            "/sandbox read-only|workspace-write|danger-full-access|default",
            "/approval - show current approval policy",
            "/approval never|on-request|default",
            "/approve [workspace-write|danger-full-access] - rerun the pending task once with more access",
            "/deny - discard the pending approval request",
            "/review [instructions] - run codex review on current workspace changes",
            "/fork [name] - switch to a new local thread name",
            "/plan - show current plan mode",
            "/plan on|off|default",
            "/draw <prompt> - generate an image",
            "/search - show current search mode",
            "/search on|off|default",
            "/roots - show allowed workspace roots",
            "/workspace",
            "/workspace <path>|default",
            "/whoami",
            "/new",
            "/reset",
          ].join("\n"),
        });
        return;

      case "/status": {
        const preference = this.getUserPreference(message.senderId);
        const codexState = this.getCodexCliState();
        const skill = this.config.userPreferences?.[message.senderId]?.skill || "(none)";
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: [
            `workspace: ${this.getWorkspace(message.senderId)}`,
            `provider: ${preference.provider}`,
            `model: ${formatResolvedModel(preference.provider, preference.model, codexState.effectiveProvider, codexState.effectiveModel)}`,
            `thread: ${preference.thread}`,
            `reasoning: ${preference.reasoningEffort || "(default)"}`,
            `personality: ${preference.personality || "(default)"}`,
            `sandbox: ${preference.sandboxMode}`,
            `approval: ${preference.approvalPolicy}`,
            `pending approval: ${this.pendingApprovals.has(this.sessionKey(message)) ? "yes" : "no"}`,
            `plan mode: ${preference.planMode ? "on" : "off"}`,
            `search: ${preference.search ? "on" : "off"}`,
            `skill: ${skill}`,
            `codex profile: ${codexState.profile || "(none)"}`,
            `allowed users mode: ${this.config.security.allowedUserIds.length > 0 ? "allowlist" : "open"}`,
          ].join("\n"),
        });
        return;
      }

      case "/models":
        await this.sendModels(channel, message);
        return;

      case "/model":
        await this.handleModelCommand(channel, message, arg);
        return;

      case "/skills":
        await this.sendSkills(channel, message);
        return;

      case "/skill":
        await this.handleSkillCommand(channel, message, arg);
        return;

      case "/mcp":
        await this.handleMcpCommand(channel, message, arg);
        return;

      case "/reasoning":
        await this.handleReasoningCommand(channel, message, arg);
        return;

      case "/personality":
        await this.handlePersonalityCommand(channel, message, arg);
        return;

      case "/sandbox":
        await this.handleSandboxCommand(channel, message, arg);
        return;

      case "/approval":
        await this.handleApprovalCommand(channel, message, arg);
        return;

      case "/approve":
        await this.handleApproveCommand(channel, message, arg);
        return;

      case "/deny":
        await this.handleDenyCommand(channel, message);
        return;

      case "/review":
        await this.handleReviewCommand(channel, message, arg);
        return;

      case "/fork":
        await this.handleForkCommand(channel, message, arg);
        return;

      case "/plan":
        await this.handlePlanCommand(channel, message, arg);
        return;

      case "/draw":
        await this.handleDrawCommand(channel, message, arg);
        return;

      case "/search":
        await this.handleSearchCommand(channel, message, arg);
        return;

      case "/roots":
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: ["allowed workspace roots:", ...this.config.allowedWorkspaceRoots.map((root) => `- ${root}`)].join("\n"),
        });
        return;

      case "/workspace":
        await this.handleWorkspaceCommand(channel, message, arg);
        return;

      case "/whoami":
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: `your user id: ${message.senderId}`,
        });
        return;

      case "/new":
      case "/reset":
        await this.resetSession(message.senderId);
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: "Session cleared.",
        });
        return;

      default:
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: `Unknown command: ${command}\nTry /help`,
        });
    }
  }

  private async sendModels(channel: Channel, message: InboundMessage): Promise<void> {
    const preference = this.getUserPreference(message.senderId);
    const codexState = this.getCodexCliState();
    const lines: string[] = [
      `codex config: ${codexState.configPath}${codexState.exists ? "" : " (missing)"}`,
      `current provider: ${preference.provider}`,
      `current model: ${formatResolvedModel(preference.provider, preference.model, codexState.effectiveProvider, codexState.effectiveModel)}`,
      `available providers: ${listCodexProviders(codexState).join(", ") || "(none)"}`,
    ];

    try {
      const models = await discoverCodexProviderModels(preference.provider, codexState);
      lines.push(`models from ${preference.provider}:`);
      for (const model of models) {
        lines.push(`- ${model.id}`);
      }
    } catch (error) {
      lines.push(`real model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: lines.join("\n"),
    });
  }

  private async handleModelCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      const preference = this.getUserPreference(message.senderId);
      const codexState = this.getCodexCliState();
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: [
          `current provider: ${preference.provider}`,
          `current model: ${formatResolvedModel(preference.provider, preference.model, codexState.effectiveProvider, codexState.effectiveModel)}`,
          "Use /models to inspect the current provider's real model list.",
        ].join("\n"),
      });
      return;
    }

    if (arg.toLowerCase() === "default") {
      this.config.userPreferences ||= {};
      this.config.userPreferences[message.senderId] ||= {};
      delete this.config.userPreferences[message.senderId]!.provider;
      delete this.config.userPreferences[message.senderId]!.model;
      delete this.config.userPreferences[message.senderId]!.skill;
      await saveConfig(this.config);
      await this.resetSession(message.senderId);
      const preference = this.getUserPreference(message.senderId);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `provider/model reset to ${preference.provider}:${preference.model || "(provider default)"}`,
      });
      return;
    }

    const resolved = await this.resolveModelTarget(arg, this.getUserPreference(message.senderId).provider);
    if (!resolved) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `Unknown model target: ${arg}\nUse /models to inspect available models.`,
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    this.config.userPreferences[message.senderId]!.provider = resolved.provider;
    if (resolved.model) {
      this.config.userPreferences[message.senderId]!.model = resolved.model;
    } else {
      delete this.config.userPreferences[message.senderId]!.model;
    }
    await saveConfig(this.config);
    await this.resetSession(message.senderId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: resolved.model
        ? `model set to ${resolved.provider}:${resolved.model}`
        : `provider set to ${resolved.provider} (model now follows the provider default)`,
    });
  }

  private async handleSkillCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    const installedSkills = await listInstalledSkills(this.config.codexHome);
    const installedByName = new Map(installedSkills.map((skill) => [skill.name.toLowerCase(), skill]));
    const promptSkills = this.config.skills || {};
    if (!arg) {
      const current = this.config.userPreferences?.[message.senderId]?.skill || "(none)";
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `current skill: ${current}\nUse /skills to list skills.`,
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    if (arg.toLowerCase() === "off") {
      delete this.config.userPreferences[message.senderId]!.skill;
      await saveConfig(this.config);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "skill disabled",
      });
      return;
    }

    const normalized = arg.toLowerCase();
    const promptSkill = promptSkills[normalized];
    const installedSkill = installedByName.get(normalized);
    if (!promptSkill && !installedSkill) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `unknown skill: ${arg}\nUse /skills to list installed skills.`,
      });
      return;
    }

    this.config.userPreferences[message.senderId]!.skill = normalized;
    if (promptSkill?.provider) {
      this.config.userPreferences[message.senderId]!.provider = promptSkill.provider;
    }
    if (promptSkill?.model) {
      this.config.userPreferences[message.senderId]!.model = promptSkill.model;
    }
    await saveConfig(this.config);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `skill set to ${normalized}`,
    });
  }

  private async sendSkills(channel: Channel, message: InboundMessage): Promise<void> {
    const skills = await listInstalledSkills(this.config.codexHome);
    const lines = skills.map((skill) => `- ${skill.name}${skill.system ? " (system)" : ""}`);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: lines.length > 0
        ? ["installed skills:", ...lines, "Natural-language skill installation can use the built-in skill-installer skill and will install into this project's codex-home."].join("\n")
        : "No skills installed in this project's codex-home.",
    });
  }

  private async sendMcpStatus(channel: Channel, message: InboundMessage): Promise<void> {
    const status = this.mcp.getStatus();
    const lines = status.length > 0
      ? status.map((item) => `- ${item.name}: ${item.connected ? "connected" : `failed (${item.error || "unknown error"})`}${item.tools.length ? ` | tools: ${item.tools.join(", ")}` : ""}`)
      : ["No MCP servers configured."];
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: ["mcp status:", ...lines].join("\n"),
    });
  }

  private async handleMcpCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    const [subcommand = "status", ...rest] = arg.trim() ? arg.trim().split(/\s+/) : [];
    const target = rest.join(" ").trim();

    switch (subcommand.toLowerCase()) {
      case "status":
        await this.sendMcpStatus(channel, message);
        return;

      case "tools": {
        const tools = this.mcp.getToolInventory();
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: tools.length > 0
            ? ["mcp tools:", ...tools.map((tool) => `- ${tool.server}/${tool.name}${tool.description ? `: ${tool.description}` : ""}`)].join("\n")
            : "No connected MCP tools.",
        });
        return;
      }

      case "reload":
        await this.mcp.reconnectAll();
        await this.sendMcpStatus(channel, message);
        return;

      case "connect":
        if (!target) {
          await this.sendOnce(channel, {
            targetId: message.senderId,
            replyToken: message.replyToken,
            text: "Usage: /mcp connect <name>",
          });
          return;
        }
        await this.mcp.connectNamed(target);
        await this.sendMcpStatus(channel, message);
        return;

      case "disconnect":
        if (!target) {
          await this.sendOnce(channel, {
            targetId: message.senderId,
            replyToken: message.replyToken,
            text: "Usage: /mcp disconnect <name>",
          });
          return;
        }
        await this.mcp.disconnectNamed(target);
        await this.sendMcpStatus(channel, message);
        return;

      default:
        await this.sendOnce(channel, {
          targetId: message.senderId,
          replyToken: message.replyToken,
          text: "Usage: /mcp [status|tools|reload|connect <name>|disconnect <name>]",
        });
    }
  }

  private async handleReasoningCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      const preference = this.getUserPreference(message.senderId);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `reasoning: ${preference.reasoningEffort || "(default)"}`,
      });
      return;
    }

    const normalized = arg.toLowerCase();
    if (normalized !== "default" && !isReasoningEffort(normalized)) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /reasoning minimal|low|medium|high|xhigh|default",
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    if (normalized === "default") {
      delete this.config.userPreferences[message.senderId]!.reasoningEffort;
    } else {
      this.config.userPreferences[message.senderId]!.reasoningEffort = normalized;
    }
    await saveConfig(this.config);
    const preference = this.getUserPreference(message.senderId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `reasoning: ${preference.reasoningEffort || "(default)"}`,
    });
  }

  private async handlePersonalityCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      const preference = this.getUserPreference(message.senderId);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `personality: ${preference.personality || "(default)"}`,
      });
      return;
    }

    const normalized = arg.toLowerCase();
    if (normalized !== "default" && !isPersonality(normalized)) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /personality none|friendly|pragmatic|default",
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    if (normalized === "default") {
      delete this.config.userPreferences[message.senderId]!.personality;
    } else {
      this.config.userPreferences[message.senderId]!.personality = normalized;
    }
    await saveConfig(this.config);
    const preference = this.getUserPreference(message.senderId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `personality: ${preference.personality || "(default)"}`,
    });
  }

  private async handleSandboxCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      const preference = this.getUserPreference(message.senderId);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `sandbox: ${preference.sandboxMode}`,
      });
      return;
    }

    const normalized = arg.toLowerCase();
    if (normalized !== "default" && !isSandboxCommand(normalized)) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /sandbox read-only|workspace-write|danger-full-access|default",
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    if (normalized === "default") {
      delete this.config.userPreferences[message.senderId]!.sandboxMode;
    } else {
      this.config.userPreferences[message.senderId]!.sandboxMode = normalized;
    }
    await saveConfig(this.config);
    const preference = this.getUserPreference(message.senderId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `sandbox: ${preference.sandboxMode}`,
    });
  }

  private async handleApprovalCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      const preference = this.getUserPreference(message.senderId);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `approval: ${preference.approvalPolicy}`,
      });
      return;
    }

    const normalized = arg.toLowerCase();
    if (normalized !== "default" && !isApprovalCommand(normalized)) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /approval never|on-request|default",
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    if (normalized === "default") {
      delete this.config.userPreferences[message.senderId]!.approvalPolicy;
    } else {
      this.config.userPreferences[message.senderId]!.approvalPolicy = normalized;
    }
    await saveConfig(this.config);
    const preference = this.getUserPreference(message.senderId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `approval: ${preference.approvalPolicy}`,
    });
  }

  private async handleApproveCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    const sessionId = this.sessionKey(message);
    const pending = this.pendingApprovals.get(sessionId);
    if (!pending) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "No pending approval request for this thread.",
      });
      return;
    }

    const normalized = arg.trim().toLowerCase();
    const grantedSandbox = normalized
      ? (isSandboxCommand(normalized) ? normalized : undefined)
      : pending.suggestedSandbox;
    if (!grantedSandbox || grantedSandbox === "read-only") {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /approve [workspace-write|danger-full-access]",
      });
      return;
    }

    this.pendingApprovals.delete(sessionId);
    await channel.sendTyping?.(message.senderId, message.replyToken);
    log.info(
      `批准待处理任务 [${shortUserId(message.senderId)}] `
      + `(session: ${sessionId}, sandbox: ${grantedSandbox})`,
    );

    const provider = this.providers.get("codex");
    if (!provider) {
      throw new Error("Codex execution provider is not configured.");
    }

    const result = await provider.query(pending.prompt, {
      sessionId: pending.sessionId,
      codexHome: this.config.codexHome,
      provider: pending.provider,
      model: pending.model,
      workspace: pending.workspace,
      sandboxMode: grantedSandbox,
      approvalPolicy: "never",
      reasoningEffort: pending.reasoningEffort,
      personality: pending.personality,
      systemPrompt: pending.systemPrompt,
      media: pending.media,
      search: pending.search,
      mcpTools: this.mcp.getOpenAITools(),
      mcpCallTool: (name: string, args: Record<string, unknown>) => this.mcp.callTool(name, args),
    });

    const responseText = this.withApprovalNotice(message, result.text, result.approvalRequest, {
      sessionId: pending.sessionId,
      prompt: pending.prompt,
      media: pending.media,
      workspace: pending.workspace,
      provider: pending.provider,
      model: pending.model,
      reasoningEffort: pending.reasoningEffort,
      personality: pending.personality,
      systemPrompt: pending.systemPrompt,
      search: pending.search,
      grantedSandbox,
    });

    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: responseText,
    });
  }

  private async handleDenyCommand(channel: Channel, message: InboundMessage): Promise<void> {
    const sessionId = this.sessionKey(message);
    const existed = this.pendingApprovals.delete(sessionId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: existed ? "Pending approval cleared." : "No pending approval request for this thread.",
    });
  }

  private async handlePlanCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      const preference = this.getUserPreference(message.senderId);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `plan mode: ${preference.planMode ? "on" : "off"}`,
      });
      return;
    }

    const normalized = arg.toLowerCase();
    if (!["on", "off", "default"].includes(normalized)) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /plan on|off|default",
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    if (normalized === "default") {
      delete this.config.userPreferences[message.senderId]!.planMode;
    } else {
      this.config.userPreferences[message.senderId]!.planMode = normalized === "on";
    }
    await saveConfig(this.config);
    const preference = this.getUserPreference(message.senderId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `plan mode: ${preference.planMode ? "on" : "off"}`,
    });
  }

  private async handleForkCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    const thread = arg.trim() || `fork-${Date.now()}`;
    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    this.config.userPreferences[message.senderId]!.thread = thread;
    await saveConfig(this.config);
    await this.resetSession(message.senderId, thread);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `thread switched to ${thread}`,
    });
  }

  private async handleReviewCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    const providerConfig = this.config.providers.codex;
    if (!providerConfig || providerConfig.type !== "codex") {
      throw new Error("Codex provider is not configured for /review.");
    }
    const preference = this.getUserPreference(message.senderId);
    await channel.sendTyping?.(message.senderId, message.replyToken);
    const review = await runCodexReview(providerConfig, {
      codexHome: this.config.codexHome,
      workspace: this.getWorkspace(message.senderId),
      provider: preference.provider,
      model: preference.model,
      reasoningEffort: preference.reasoningEffort,
      personality: preference.personality,
      prompt: arg || undefined,
    });
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: review,
    });
  }

  private async handleDrawCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /draw <prompt>",
      });
      return;
    }

    const preference = this.getUserPreference(message.senderId);
    const provider = this.providers.get(preference.provider);
    const providerConfig = this.config.providers[preference.provider];
    if (!provider || !provider.generateImage) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `Provider "${preference.provider}" does not support image generation.`,
      });
      return;
    }

    const imageModel = providerConfig.preferredImageModel
      || (providerConfig.models || []).find((item) => item.preferredForDrawing || item.imageGeneration)?.id;
    if (!imageModel) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `Provider "${preference.provider}" has no configured image generation model.`,
      });
      return;
    }

    await channel.sendTyping?.(message.senderId, message.replyToken);
    const result = await provider.generateImage(arg, imageModel);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      media: [result.media],
      text: result.revisedPrompt ? `image generated\nrevised prompt: ${result.revisedPrompt}` : "image generated",
    });
  }

  private async handleSearchCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      const preference = this.getUserPreference(message.senderId);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `search: ${preference.search ? "on" : "off"}`,
      });
      return;
    }

    const normalized = arg.toLowerCase();
    if (!["on", "off", "default"].includes(normalized)) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: "Usage: /search on|off|default",
      });
      return;
    }

    this.config.userPreferences ||= {};
    this.config.userPreferences[message.senderId] ||= {};
    if (normalized === "default") {
      delete this.config.userPreferences[message.senderId]!.search;
    } else {
      this.config.userPreferences[message.senderId]!.search = normalized === "on";
    }
    await saveConfig(this.config);
    const preference = this.getUserPreference(message.senderId);
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `search: ${preference.search ? "on" : "off"}`,
    });
  }

  private async handleWorkspaceCommand(channel: Channel, message: InboundMessage, arg: string): Promise<void> {
    if (!arg) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `workspace: ${this.getWorkspace(message.senderId)}`,
      });
      return;
    }

    try {
      const workspace = arg.toLowerCase() === "default" ? this.config.defaultWorkspace : this.validateWorkspace(arg);
      this.config.userWorkspaces ||= {};
      this.config.userWorkspaces[message.senderId] = workspace;
      await saveConfig(this.config);
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: `workspace switched to:\n${workspace}`,
      });
    } catch (error) {
      await this.sendOnce(channel, {
        targetId: message.senderId,
        replyToken: message.replyToken,
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getWorkspace(userId: string): string {
    return this.config.userWorkspaces?.[userId] || this.config.defaultWorkspace;
  }

  private getUserPreference(userId: string): ResolvedUserPreference {
    const codexState = this.getCodexCliState();
    const override = this.config.userPreferences?.[userId] || {};
    const provider = override.provider || codexState.effectiveProvider || this.config.defaultProvider;
    return {
      provider,
      model: override.model || codexState.effectiveModel,
      search: override.search ?? false,
      sandboxMode: override.sandboxMode ?? "read-only",
      approvalPolicy: override.approvalPolicy ?? "never",
      reasoningEffort: override.reasoningEffort,
      personality: override.personality,
      planMode: override.planMode ?? false,
      thread: override.thread || "main",
    };
  }

  private isAuthorizedUser(userId: string): boolean {
    const allowed = this.config.security.allowedUserIds || [];
    return allowed.length === 0 || allowed.includes(userId);
  }

  private async replyQueued(message: InboundMessage, pendingCount: number): Promise<void> {
    const channel = this.channels.get(message.channel);
    if (!channel) return;
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: `Previous task still running. Queued ${pendingCount} new message${pendingCount > 1 ? "s" : ""}.`,
    });
  }

  private async replyUnauthorized(message: InboundMessage): Promise<void> {
    const channel = this.channels.get(message.channel);
    if (!channel) return;
    await this.sendOnce(channel, {
      targetId: message.senderId,
      replyToken: message.replyToken,
      text: [
        "Access denied for this WeChat user.",
        "Ask the operator to add your user id to the allowlist.",
        "You can still send /whoami to discover your user id.",
      ].join("\n"),
    });
  }

  private validateWorkspace(inputPath: string): string {
    const resolved = resolve(inputPath);
    if (!existsSync(resolved)) {
      throw new Error(`Workspace does not exist:\n${resolved}`);
    }

    const allowed = this.config.allowedWorkspaceRoots.some((root) => isWithin(resolved, resolve(root)));
    if (!allowed) {
      throw new Error(
        ["Workspace not allowed.", "Allowed roots:", ...this.config.allowedWorkspaceRoots.map((root) => `- ${root}`)]
          .join("\n"),
      );
    }

    return resolved;
  }

  private sessionKey(message: InboundMessage, thread?: string): string {
    const preferenceThread = thread || this.config.userPreferences?.[message.senderId]?.thread || "main";
    return `${message.channel}:${message.senderId}:${preferenceThread}`;
  }

  private isDuplicateMessage(message: InboundMessage): boolean {
    const now = Date.now();
    pruneMap(this.seenMessages, now, DEDUP_TTL_MS);

    const keys = [
      `${message.channel}:${message.id}`,
      `${message.channel}:${message.senderId}:${message.replyToken || ""}:${normalizeText(message.text)}:${summarizeMedia(message.media)}:${Math.floor(message.timestamp / 30_000)}`,
    ];

    for (const key of keys) {
      if (this.seenMessages.has(key)) {
        log.warn(`Skipping duplicate inbound message ${key}`);
        return true;
      }
    }

    for (const key of keys) {
      this.seenMessages.set(key, now);
    }
    return false;
  }

  private async sendOnce(channel: Channel, message: OutboundMessage): Promise<void> {
    const now = Date.now();
    pruneMap(this.sentReplies, now, OUTBOUND_DEDUP_TTL_MS);
    const text = (message.text || "").trim();
    const mediaSummary = summarizeMedia(message.media);
    const dedupKey = `${channel.name}:${message.targetId}:${message.replyToken || ""}:${text}:${mediaSummary}`;
    if (this.sentReplies.has(dedupKey)) {
      log.warn(`Skipping duplicate outbound reply ${dedupKey}`);
      return;
    }
    this.sentReplies.set(dedupKey, now);
    await channel.send(message);
  }

  private async resetSession(userId: string, thread?: string): Promise<void> {
    const sessionId = `weixin:${userId}:${thread || this.config.userPreferences?.[userId]?.thread || "main"}`;
    this.pendingApprovals.delete(sessionId);
    for (const provider of this.providers.values()) {
      provider.resetSession?.(sessionId);
    }
  }

  private withApprovalNotice(
    message: InboundMessage,
    text: string,
    approvalRequest: { reason: string; suggestedSandbox: SandboxMode } | undefined,
    pending: Omit<PendingApproval, "createdAt" | "suggestedSandbox" | "reason"> & { grantedSandbox: SandboxMode },
  ): string {
    const sessionId = pending.sessionId;
    if (!approvalRequest) {
      this.pendingApprovals.delete(sessionId);
      return text.trim();
    }

    this.pendingApprovals.set(sessionId, {
      sessionId: pending.sessionId,
      prompt: pending.prompt,
      media: pending.media,
      workspace: pending.workspace,
      provider: pending.provider,
      model: pending.model,
      reasoningEffort: pending.reasoningEffort,
      personality: pending.personality,
      systemPrompt: pending.systemPrompt,
      search: pending.search,
      suggestedSandbox: approvalRequest.suggestedSandbox,
      reason: approvalRequest.reason,
      createdAt: Date.now(),
    });

    const lines = [
      text.trim(),
      "",
      "Approval required to continue this task.",
      `current sandbox: ${pending.grantedSandbox}`,
      `reason: ${approvalRequest.reason}`,
      `send /approve ${approvalRequest.suggestedSandbox} to rerun once with more access`,
      "send /deny to discard this pending approval request",
      "use /sandbox if you want to change the default permission for future tasks",
    ].filter(Boolean);

    log.info(
      `待批准任务 [${shortUserId(message.senderId)}] `
      + `(session: ${sessionId}, suggested sandbox: ${approvalRequest.suggestedSandbox})`,
    );

    return lines.join("\n").trim();
  }

  private async resolveModelTarget(arg: string, currentProvider: string): Promise<{ provider: string; model?: string } | null> {
    const codexState = this.getCodexCliState();

    if (arg.includes(":")) {
      const [provider, model] = arg.split(":", 2);
      if (!codexState.providers[provider] || !model) {
        return null;
      }
      return { provider, model };
    }

    if (codexState.providers[arg]) {
      return { provider: arg };
    }

    const matches: Array<{ provider: string; model: string }> = [];
    const providersToSearch = [currentProvider, ...listCodexProviders(codexState).filter((provider) => provider !== currentProvider)];
    for (const providerName of providersToSearch) {
      let models;
      try {
        models = await discoverCodexProviderModels(providerName, codexState);
      } catch {
        continue;
      }
      if (models.some((model) => model.id === arg)) {
        matches.push({ provider: providerName, model: arg });
      }
    }

    if (matches.length === 1) {
      return matches[0]!;
    }
    return null;
  }

  private async resolveProviderMiddleware(ctx: Context, next: NextFunction): Promise<void> {
    const codexState = this.getCodexCliState();
    if (!codexState.providers[ctx.preference.provider]) {
      throw new Error(`Unknown Codex provider: ${ctx.preference.provider}`);
    }

    const provider = this.providers.get("codex");
    if (!provider) {
      throw new Error("Codex execution provider is not configured.");
    }
    ctx.provider = provider;
    await next();
  }

  private async preparePayloadMiddleware(ctx: Context, next: NextFunction): Promise<void> {
    const providerConfig = this.config.providers[ctx.preference.provider] || this.config.providers.codex;
    const mediaPayload = await prepareMediaPayload(ctx.message.text, ctx.message.media, providerConfig);
    ctx.prompt = mediaPayload.prompt;
    ctx.state.imagePaths = mediaPayload.imagePaths;
    ctx.state.cleanup = mediaPayload.cleanup;

    const currentModel = providerConfig.models?.find((item) => item.id === ctx.preference.model);
    const hasImages = (ctx.message.media || []).some((item) => item.type === "image");
    if (hasImages && !currentModel?.vision) {
      const visionModel = providerConfig.preferredVisionModel
        || providerConfig.models?.find((item) => item.preferredForVision || item.vision)?.id;
      if (visionModel) {
        ctx.preference = { ...ctx.preference, model: visionModel };
        ctx.state.autoVisionModel = visionModel;
      }
    }

    try {
      await next();
    } finally {
      await (ctx.state.cleanup as (() => Promise<void>) | undefined)?.();
    }
  }

  private async applySkillMiddleware(ctx: Context, next: NextFunction): Promise<void> {
    const skillName = this.config.userPreferences?.[ctx.message.senderId]?.skill;
    const skill = skillName ? this.config.skills?.[skillName] : undefined;
    const prompts = [this.config.systemPrompt || ""];
    if (skill?.systemPrompt) {
      prompts.push(skill.systemPrompt);
    }
    if (skillName && !skill?.systemPrompt) {
      prompts.push(`Use the ${skillName} skill if it is relevant to the user's request.`);
    }
    if (ctx.preference.search) {
      prompts.push("Search mode is on. Prefer using current external information when it is relevant instead of relying only on memory.");
    }
    if (ctx.state.autoVisionModel) {
      prompts.push(`The current request includes images. Use vision reasoning with model ${ctx.state.autoVisionModel}.`);
    }
    if (ctx.preference.planMode) {
      prompts.push("Plan mode is on. First provide a concise execution plan and wait for user confirmation before making changes.");
    }
    ctx.systemPrompt = prompts.filter(Boolean).join("\n\n");
    await next();
  }

  private async attachMcpMiddleware(ctx: Context, next: NextFunction): Promise<void> {
    const tools = this.mcp.getOpenAITools();
    if (tools.length > 0) {
      ctx.state.mcpTools = tools;
      ctx.state.mcpCallTool = (name: string, args: Record<string, unknown>) => this.mcp.callTool(name, args);
    }
    await next();
  }

  private async executeProviderMiddleware(ctx: Context): Promise<void> {
    const channel = ctx.state.channel as Channel;
    const provider = ctx.provider;
    if (!provider) {
      throw new Error("Provider not resolved.");
    }

    await channel.sendTyping?.(ctx.message.senderId, ctx.message.replyToken);
    log.info(
      `调用 ${ctx.preference.provider} 处理中 [${shortUserId(ctx.message.senderId)}] `
      + `(model: ${ctx.preference.model || "(provider default)"}, session: ${this.sessionKey(ctx.message)}, `
      + `sandbox: ${ctx.preference.sandboxMode}, approval: ${ctx.preference.approvalPolicy})`,
    );
    const result = await provider.query(ctx.prompt || ctx.message.text, {
      sessionId: this.sessionKey(ctx.message),
      codexHome: this.config.codexHome,
      provider: ctx.preference.provider,
      model: ctx.preference.model,
      workspace: ctx.state.workspace as string,
      sandboxMode: ctx.preference.sandboxMode,
      approvalPolicy: ctx.preference.approvalPolicy,
      reasoningEffort: ctx.preference.reasoningEffort,
      personality: ctx.preference.personality,
      systemPrompt: ctx.systemPrompt,
      media: ctx.message.media,
      search: ctx.preference.search,
      mcpTools: ctx.state.mcpTools as any,
      mcpCallTool: ctx.state.mcpCallTool as any,
    });

    const responseText = this.withApprovalNotice(ctx.message, result.text, result.approvalRequest, {
      sessionId: this.sessionKey(ctx.message),
      prompt: ctx.prompt || ctx.message.text,
      media: ctx.message.media,
      workspace: ctx.state.workspace as string,
      provider: ctx.preference.provider,
      model: ctx.preference.model,
      reasoningEffort: ctx.preference.reasoningEffort,
      personality: ctx.preference.personality,
      systemPrompt: ctx.systemPrompt,
      search: ctx.preference.search,
      grantedSandbox: ctx.preference.sandboxMode,
    });

    const autoVisionText = ctx.state.autoVisionModel
      ? `auto-switched to vision model: ${ctx.state.autoVisionModel}\n\n`
      : "";
    ctx.response = {
      targetId: ctx.message.senderId,
      replyToken: ctx.message.replyToken,
      text: `${autoVisionText}${responseText}`.trim(),
    };
  }

  private async compose(ctx: Context, stack: Middleware[]): Promise<void> {
    let index = -1;
    const dispatch = async (current: number): Promise<void> => {
      if (current <= index) {
        throw new Error("next() called multiple times");
      }
      index = current;
      const middleware = stack[current];
      if (!middleware) {
        return;
      }
      await middleware(ctx, () => dispatch(current + 1));
    };
    await dispatch(0);
  }

  private getCodexCliState(): CodexCliState {
    try {
      return loadCodexCliState(this.config.codexHome);
    } catch (error) {
      log.warn(`Failed to load Codex config: ${error instanceof Error ? error.message : String(error)}`);
      return {
        codexHome: this.config.codexHome,
        configPath: "(unavailable)",
        exists: false,
        profile: undefined,
        effectiveProvider: this.config.defaultProvider,
        effectiveModel: this.config.providers[this.config.defaultProvider]?.defaultModel,
        providers: Object.fromEntries(
          Object.keys(this.config.providers)
            .filter((name) => name !== "codex")
            .map((name) => [name, {
              id: name,
              name,
              baseUrl: this.config.providers[name]?.baseUrl,
              envKey: this.config.providers[name]?.apiKeyEnv,
              experimentalBearerToken: this.config.providers[name]?.apiKey,
              httpHeaders: {},
              envHttpHeaders: {},
              queryParams: {},
              requiresOpenAIAuth: false,
            }]),
        ),
      };
    }
  }
}

function instantiateProvider(name: string, config: ProviderConfig): Provider {
  if (config.type === "codex") {
    return new CodexProvider(name, config);
  }
  return new OpenAICompatibleProvider(name, config);
}

function mergeMessages(messages: InboundMessage[]): InboundMessage {
  if (messages.length === 1) return messages[0]!;
  const last = messages[messages.length - 1]!;
  return {
    ...last,
    text: messages.map((message) => message.text).join("\n"),
    media: messages.flatMap((message) => message.media || []),
  };
}

function debounceForMessages(messages: InboundMessage[]): number {
  return hasMediaWithoutUserText(messages) ? MEDIA_ONLY_DEBOUNCE_MS : DEBOUNCE_MS;
}

function hasMediaWithoutUserText(messages: InboundMessage[]): boolean {
  const hasMedia = messages.some((message) => (message.media?.length || 0) > 0);
  if (!hasMedia) {
    return false;
  }
  const combinedText = messages.map((message) => message.text).join("\n").trim();
  return combinedText === "" || combinedText === "[media]";
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
}

function pruneMap(map: Map<string, number>, now: number, ttlMs: number): void {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ttlMs) {
      map.delete(key);
    }
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function summarizeUserText(text: string, media: InboundMessage["media"]): string {
  const trimmed = text.trim() || "[media]";
  const flat = trimmed.replace(/\s+/g, " ");
  const mediaCount = media?.length || 0;
  const suffix = mediaCount > 0 ? ` +${mediaCount} media` : "";
  return `${flat.slice(0, 80)}${flat.length > 80 ? "..." : ""}${suffix}`;
}

function shortUserId(userId: string): string {
  return userId.length > 10 ? `${userId.slice(0, 8)}...` : userId;
}

function summarizeMedia(media: InboundMessage["media"] | OutboundMessage["media"]): string {
  return (media || [])
    .map((item) => `${item.type}:${item.fileName || item.url || item.dataUrl?.slice(0, 32) || ""}`)
    .join("|");
}

function formatResolvedModel(
  selectedProvider: string,
  selectedModel: string | undefined,
  defaultProvider: string,
  defaultModel: string | undefined,
): string {
  if (selectedModel) {
    return selectedModel;
  }
  if (selectedProvider === defaultProvider && defaultModel) {
    return defaultModel;
  }
  return "(provider default)";
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function isPersonality(value: string): value is Personality {
  return ["none", "friendly", "pragmatic"].includes(value);
}

export function isSandboxCommand(value: string): value is SandboxMode {
  return ["read-only", "workspace-write", "danger-full-access"].includes(value);
}

export function isApprovalCommand(value: string): value is ApprovalPolicy {
  return ["never", "on-request"].includes(value);
}
