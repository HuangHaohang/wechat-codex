import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "./logger.js";
import type { McpServerConfig } from "./types.js";

const log = createLogger("mcp");

interface McpConnection {
  client: Client;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    serverName: string;
  }>;
}

interface McpServerStatus {
  connected: boolean;
  error?: string;
  tools: string[];
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly serverStatus = new Map<string, McpServerStatus>();
  private serverConfigs: Record<string, McpServerConfig> = {};

  async connect(servers: Record<string, McpServerConfig> | undefined): Promise<void> {
    this.serverConfigs = servers || {};
    if (!servers || Object.keys(servers).length === 0) {
      return;
    }

    for (const [name, config] of Object.entries(servers)) {
      try {
        await this.connectServer(name, config);
        this.serverStatus.set(name, {
          connected: true,
          tools: this.connections.get(name)?.tools.map((tool) => tool.name) || [],
        });
        log.info(`MCP server connected: ${name}`);
      } catch (error) {
        this.serverStatus.set(name, {
          connected: false,
          error: error instanceof Error ? error.message : String(error),
          tools: [],
        });
        log.error(`MCP server failed: ${name} - ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async disconnect(): Promise<void> {
    for (const [name, connection] of this.connections) {
      try {
        await connection.client.close();
        log.info(`MCP server disconnected: ${name}`);
      } catch {
        // Ignore close failures.
      }
    }
    this.connections.clear();
  }

  async reconnectAll(): Promise<void> {
    await this.disconnect();
    await this.connect(this.serverConfigs);
  }

  async connectNamed(name: string): Promise<void> {
    const config = this.serverConfigs[name];
    if (!config) {
      throw new Error(`MCP server not configured: ${name}`);
    }
    if (this.connections.has(name)) {
      return;
    }
    await this.connectServer(name, config);
    this.serverStatus.set(name, {
      connected: true,
      tools: this.connections.get(name)?.tools.map((tool) => tool.name) || [],
    });
  }

  async disconnectNamed(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      const status = this.serverStatus.get(name);
      if (status) {
        this.serverStatus.set(name, { ...status, connected: false });
      }
      return;
    }
    try {
      await connection.client.close();
    } finally {
      this.connections.delete(name);
      const previous = this.serverStatus.get(name);
      this.serverStatus.set(name, {
        connected: false,
        error: previous?.error,
        tools: previous?.tools || [],
      });
    }
  }

  getStatus(): Array<{ name: string; connected: boolean; error?: string; tools: string[] }> {
    return [...this.serverStatus.entries()].map(([name, status]) => ({
      name,
      connected: status.connected,
      error: status.error,
      tools: [...status.tools],
    }));
  }

  getToolInventory(): Array<{ server: string; name: string; description: string }> {
    const inventory: Array<{ server: string; name: string; description: string }> = [];
    for (const [server, connection] of this.connections) {
      for (const tool of connection.tools) {
        inventory.push({
          server,
          name: tool.name,
          description: tool.description,
        });
      }
    }
    return inventory.sort((left, right) => {
      const byServer = left.server.localeCompare(right.server);
      return byServer !== 0 ? byServer : left.name.localeCompare(right.name);
    });
  }

  getOpenAITools(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    const tools: Array<{
      type: "function";
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }> = [];
    for (const connection of this.connections.values()) {
      for (const tool of connection.tools) {
        tools.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        });
      }
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    for (const connection of this.connections.values()) {
      const tool = connection.tools.find((item) => item.name === name);
      if (!tool) {
        continue;
      }

      const result = await connection.client.callTool({ name, arguments: args });
      if (!Array.isArray(result.content)) {
        return JSON.stringify(result.content);
      }

      return result.content
        .map((item: { type?: string; text?: string }) => item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item))
        .join("\n");
    }

    throw new Error(`MCP tool not found: ${name}`);
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    const transportType = config.transport || "stdio";
    let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

    if (transportType === "stdio") {
      if (!config.command) {
        throw new Error("stdio transport requires a command");
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env,
      });
    } else if (transportType === "sse") {
      if (!config.url) {
        throw new Error("sse transport requires a url");
      }
      transport = new SSEClientTransport(new URL(config.url));
    } else {
      if (!config.url) {
        throw new Error("streamable-http transport requires a url");
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url));
    }

    const client = new Client(
      { name: "wechat-codex", version: "0.2.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools = (toolsResult.tools || []).map((tool: { name: string; description?: string; inputSchema?: unknown }) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
      serverName: name,
    }));

    this.connections.set(name, { client, tools });
  }
}
