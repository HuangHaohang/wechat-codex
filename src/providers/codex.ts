import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mergeMissingUserEnv } from "../env.js";
import { createLogger } from "../logger.js";
import type {
  ModelCatalogEntry,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderQueryOptions,
} from "../types.js";

const log = createLogger("codex");

interface JsonEvent {
  type?: string;
  message?: string;
  error?: {
    message?: string;
  };
  item?: {
    type?: string;
    text?: string;
  };
}

export class CodexProvider implements Provider {
  readonly type = "codex" as const;

  constructor(
    readonly name: string,
    private readonly config: ProviderConfig,
  ) {}

  async query(prompt: string, options: ProviderQueryOptions): Promise<{ text: string }> {
    const tempDir = await mkdtemp(join(tmpdir(), "wechat-codex-"));
    const outputFile = join(tempDir, "last-message.txt");

    try {
      const args = this.buildArgs(options, outputFile);
      const env = buildCodexEnv(this.config, options.codexHome);
      log.info(
        `Querying ${options.provider || "codex"} `
        + `(model: ${options.model || "(provider default)"}, session: ${options.sessionId})`,
      );
      const { stdout, stderr } = await runCommand(this.getCommand(), args, env, prompt);
      const text = await parseResult(stdout, stderr, outputFile);
      log.info(`Response: ${text.length} chars`);
      return { text };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async listModels(): Promise<ModelCatalogEntry[]> {
    return this.config.models || [];
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      chatCompletions: "no",
      responses: "yes",
      toolCalls: "yes",
      vision: "yes",
      imageGeneration: "no",
      audioTranscription: "no",
      ...(this.config.capabilities || {}),
    };
  }

  private buildArgs(options: ProviderQueryOptions, outputFile: string): string[] {
    const args = [
      "--json",
      "-c",
      "sandbox_mode=\"workspace-write\"",
      "-c",
      "approval_policy=\"never\"",
      "-o",
      outputFile,
    ];

    if (options.provider) {
      args.push("-c", `model_provider=${JSON.stringify(options.provider)}`);
    }
    if (options.model) {
      args.push("-m", options.model);
    }
    if (options.reasoningEffort) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`);
    }
    if (options.personality) {
      args.push("-c", `personality=${JSON.stringify(options.personality)}`);
    }
    for (const image of options.media || []) {
      if (image.type === "image" && image.url && !image.url.startsWith("data:")) {
        args.push("-i", resolve(image.url));
      }
    }

    return ["exec", ...args, "--skip-git-repo-check", "-C", resolve(options.workspace || process.cwd()), "-"];
  }

  private getCommand(): string {
    return this.config.command || "codex";
  }
}

async function parseResult(stdout: string, stderr: string, outputFile: string): Promise<string> {
  let text = "";
  let jsonError = "";

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as JsonEvent;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        text = event.item.text;
      }
      if (event.type === "error") {
        jsonError = event.message || event.error?.message || jsonError;
      }
      if (event.type === "turn.failed") {
        jsonError = event.error?.message || event.message || jsonError;
      }
    } catch {
      // Ignore malformed JSONL.
    }
  }

  if (existsSync(outputFile)) {
    const fileText = (await readFile(outputFile, "utf-8")).trim();
    if (fileText) {
      text = fileText;
    }
  }

  if (!text) {
    const cleaned = stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("<html>") && !line.startsWith("{"))
      .join("\n")
      .slice(0, 1000);
    throw new Error(jsonError || cleaned || "Codex returned no final message");
  }

  return text;
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdinText: string,
  cwd = process.cwd(),
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const executable = normalizeExecutable(command);
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", executable, ...args], {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(executable, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.stdin.write(stdinText);
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || `${executable} exited with code ${code}`));
    });
  });
}

function normalizeExecutable(command: string): string {
  if (process.platform !== "win32") return command;
  if (/[.](cmd|exe|bat)$/i.test(command)) return command;
  return `${command}.cmd`;
}

function buildCodexEnv(config: ProviderConfig, codexHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = mergeMissingUserEnv({ ...process.env });
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_API_BASE;

  if (codexHome) {
    env.CODEX_HOME = codexHome;
    env.WECHAT_CODEX_CODEX_HOME = codexHome;
  }

  if (config.apiKey) {
    env.OPENAI_API_KEY = config.apiKey;
  }
  return env;
}

export async function runCodexReview(
  config: ProviderConfig,
  options: {
    codexHome?: string;
    workspace: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    personality?: string;
    prompt?: string;
  },
): Promise<string> {
  const env = buildCodexEnv(config, options.codexHome);
  const args = ["review", "--uncommitted"];

  if (options.provider) {
    args.push("-c", `model_provider=${JSON.stringify(options.provider)}`);
  }
  if (options.model) {
    args.push("-c", `model=${JSON.stringify(options.model)}`);
  }
  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`);
  }
  if (options.personality) {
    args.push("-c", `personality=${JSON.stringify(options.personality)}`);
  }
  if (options.prompt?.trim()) {
    args.push(options.prompt.trim());
  }

  const { stdout, stderr } = await runCommand(
    config.command || "codex",
    args,
    env,
    "",
    resolve(options.workspace),
  );
  const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  if (!text) {
    throw new Error("Codex review returned no output.");
  }
  return text;
}
