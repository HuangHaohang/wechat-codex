#!/usr/bin/env node

import { existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WeixinChannel } from "./channels/weixin.js";
import { listCodexProviders, loadCodexCliState } from "./codex-config.js";
import {
  getAccountsDir,
  getConfigPath,
  getDataDir,
  loadConfig,
  normalizeOpenAIBaseUrl,
  PROVIDER_PRESETS,
  saveConfig,
} from "./config.js";
import { resolveEnvVar } from "./env.js";
import { Gateway, isApprovalCommand, isSandboxCommand } from "./gateway.js";
import { createLogger, setLogLevel } from "./logger.js";
import type { ApprovalPolicy, ProviderConfig, SandboxMode } from "./types.js";

const log = createLogger("cli");
const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP = `
wechat-codex

Commands:
  wechat-codex                  Start in the foreground
  wechat-codex serve            Start in the foreground
  wechat-codex start            Start in daemon mode
  wechat-codex stop             Stop the daemon
  wechat-codex status           Show daemon status
  wechat-codex logs [-f]        Show daemon logs
  wechat-codex config           Print current config
  wechat-codex list-providers   Print built-in providers
  wechat-codex set NAME KEY     Save an API key for a provider
  wechat-codex set-url NAME URL Save an OpenAI-compatible base URL
  wechat-codex unset NAME       Remove a provider key and reset its URL
  wechat-codex set-workspace PATH
  wechat-codex add-root PATH
  wechat-codex list-roots
  wechat-codex allow-user USER_ID
  wechat-codex deny-user USER_ID
  wechat-codex list-users
  wechat-codex login
  wechat-codex logout
  wechat-codex doctor
  wechat-codex help
`;

async function main(): Promise<void> {
  configureConsole();
  setLogLevel(((process.env.WECHAT_CODEX_LOG_LEVEL as any) || "info"));

  const args = process.argv.slice(2);
  const command = args[0] || "serve";
  const config = await loadConfig();

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "config":
      console.log(JSON.stringify({ ...config, configPath: getConfigPath() }, null, 2));
      return;

    case "list-providers":
      console.log(formatProviders(config));
      return;

    case "set": {
      const providerName = args[1];
      const key = args[2];
      if (!providerName || !key) {
        throw new Error("Usage: wechat-codex set <provider> <key>");
      }
      const provider = requireProvider(config.providers, providerName);
      provider.apiKey = key.trim();
      await saveConfig(config);
      console.log(`Saved API key for ${providerName}.`);
      return;
    }

    case "set-url": {
      const providerName = args[1];
      const url = args[2];
      if (!providerName || !url) {
        throw new Error("Usage: wechat-codex set-url <provider> <url>");
      }
      const provider = requireProvider(config.providers, providerName);
      provider.baseUrl = normalizeOpenAIBaseUrl(url.trim());
      provider.type = "openai-compatible";
      await saveConfig(config);
      console.log(`Saved base URL for ${providerName}: ${provider.baseUrl}`);
      return;
    }

    case "unset": {
      const providerName = args[1];
      if (!providerName) {
        throw new Error("Usage: wechat-codex unset <provider>");
      }
      const provider = requireProvider(config.providers, providerName);
      delete provider.apiKey;
      const preset = PROVIDER_PRESETS[providerName];
      if (preset?.baseUrl) {
        provider.baseUrl = preset.baseUrl;
      }
      if (preset?.defaultModel) {
        provider.defaultModel = preset.defaultModel;
      }
      await saveConfig(config);
      console.log(`Cleared saved overrides for ${providerName}.`);
      return;
    }

    case "set-workspace": {
      const workspace = args[1];
      if (!workspace) {
        throw new Error("Usage: wechat-codex set-workspace <path>");
      }
      const resolved = resolve(workspace);
      if (!existsSync(resolved)) {
        throw new Error(`Path does not exist: ${resolved}`);
      }
      config.defaultWorkspace = resolved;
      if (!config.allowedWorkspaceRoots.includes(resolved)) {
        config.allowedWorkspaceRoots.push(resolved);
      }
      await saveConfig(config);
      console.log(`Default workspace set to ${resolved}`);
      return;
    }

    case "add-root": {
      const root = args[1];
      if (!root) {
        throw new Error("Usage: wechat-codex add-root <path>");
      }
      const resolved = resolve(root);
      if (!existsSync(resolved)) {
        throw new Error(`Path does not exist: ${resolved}`);
      }
      if (!config.allowedWorkspaceRoots.includes(resolved)) {
        config.allowedWorkspaceRoots.push(resolved);
        await saveConfig(config);
      }
      console.log(`Allowed root added: ${resolved}`);
      return;
    }

    case "list-roots":
      console.log(config.allowedWorkspaceRoots.join("\n"));
      return;

    case "allow-user": {
      const userId = args[1]?.trim();
      if (!userId) {
        throw new Error("Usage: wechat-codex allow-user <user_id>");
      }
      if (!config.security.allowedUserIds.includes(userId)) {
        config.security.allowedUserIds.push(userId);
        await saveConfig(config);
      }
      console.log(`Allowed user added: ${userId}`);
      return;
    }

    case "deny-user": {
      const userId = args[1]?.trim();
      if (!userId) {
        throw new Error("Usage: wechat-codex deny-user <user_id>");
      }
      config.security.allowedUserIds = config.security.allowedUserIds.filter((item) => item !== userId);
      await saveConfig(config);
      console.log(`Allowed user removed: ${userId}`);
      return;
    }

    case "list-users":
      console.log(config.security.allowedUserIds.length > 0 ? config.security.allowedUserIds.join("\n") : "(empty)");
      return;

    case "login": {
      const channelConfig = config.channels.weixin;
      if (!channelConfig || channelConfig.enabled === false) {
        throw new Error("Weixin channel is disabled in config");
      }
      console.log("Starting interactive WeChat login...");
      const channel = new WeixinChannel(channelConfig);
      await channel.login();
      console.log("WeChat bot login saved.");
      return;
    }

    case "logout": {
      const accountsDir = getAccountsDir();
      const files = ["weixin.json", "weixin-sync.json", "weixin-qr.txt"];
      for (const file of files) {
        const fullPath = resolve(accountsDir, file);
        if (existsSync(fullPath)) {
          await rm(fullPath, { force: true });
        }
      }
      console.log("Saved WeChat login state cleared.");
      return;
    }

    case "doctor":
      await runDoctor(config);
      return;

    case "start":
      await startDaemon();
      return;

    case "stop":
      stopDaemon();
      return;

    case "status":
      printDaemonStatus();
      return;

    case "logs":
      await printLogs(args.slice(1));
      return;

    case "serve":
    default:
      await runForeground(config);
  }
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function runForeground(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  validateStartConfig(config);
  console.log("Starting wechat-codex bridge...");
  console.log(`Config: ${getConfigPath()}`);
  console.log(`Workspace: ${config.defaultWorkspace}`);
  console.log(`Codex home: ${config.codexHome}`);
  if (!existsSync(resolve(getAccountsDir(), "weixin.json"))) {
    console.log("No saved WeChat login found. Interactive login will start in this terminal.");
  }

  const gateway = new Gateway(config);
  gateway.init();

  const shutdown = () => void gateway.stop().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info(`Config: ${getConfigPath()}`);
  log.info(`Default workspace: ${config.defaultWorkspace}`);
  log.info(`Codex home: ${config.codexHome}`);
  await gateway.start();
}

async function runDoctor(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const codexState = loadCodexCliState(config.codexHome);
  const checks = [
    `config: ${getConfigPath()}`,
    `codexHome: ${codexState.codexHome}`,
    `codexConfig: ${codexState.configPath}`,
    `codexConfigExists: ${codexState.exists}`,
    `codexProvider: ${codexState.effectiveProvider}`,
    `codexModel: ${codexState.effectiveModel || "(provider default)"}`,
    `defaultWorkspace: ${config.defaultWorkspace}`,
    `workspaceExists: ${existsSync(config.defaultWorkspace)}`,
    `allowedRoots: ${config.allowedWorkspaceRoots.length}`,
    `defaultWorkspaceAllowed: ${isPathAllowed(config.defaultWorkspace, config.allowedWorkspaceRoots)}`,
    `allowedUsers: ${config.security.allowedUserIds.length}`,
    `weixinAccountSaved: ${existsSync(resolve(getAccountsDir(), "weixin.json"))}`,
    `daemonRunning: ${isDaemonRunning()}`,
  ];

  for (const name of listCodexProviders(codexState)) {
    const codexProvider = codexState.providers[name];
    const fallback = config.providers[name];
    const ready = !!(
      codexProvider.experimentalBearerToken
      || resolveEnvVar(codexProvider.envKey)
      || fallback?.apiKey
      || resolveEnvVar(fallback?.apiKeyEnv)
    );
    checks.push(`${name}: ${ready ? "configured" : "missing-key"} ${codexProvider.baseUrl || fallback?.baseUrl || "(no-base-url)"}`);
  }

  console.log(checks.join("\n"));
}

async function startDaemon(): Promise<void> {
  const pidFile = daemonPidFile();
  const logFile = daemonLogFile();

  if (isDaemonRunning()) {
    console.log(`wechat-codex is already running (PID: ${readFileSync(pidFile, "utf-8").trim()})`);
    return;
  }

  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }

  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [join(__dirname, "cli.js"), "serve"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, WECHAT_CODEX_DAEMON: "1" },
  });
  child.unref();
  await saveTextFile(pidFile, String(child.pid));
  console.log(`wechat-codex started in the background (PID: ${child.pid})`);
  console.log(`logs: ${logFile}`);
}

function stopDaemon(): void {
  const pidFile = daemonPidFile();
  if (!existsSync(pidFile)) {
    console.log("No daemon PID file found.");
    return;
  }

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(pidFile);
    console.log(`Stopped daemon PID ${pid}.`);
  } catch {
    unlinkSync(pidFile);
    console.log("Daemon process was not running. PID file removed.");
  }
}

function printDaemonStatus(): void {
  if (!isDaemonRunning()) {
    console.log("Daemon status: stopped");
    return;
  }
  const pid = readFileSync(daemonPidFile(), "utf-8").trim();
  console.log(`Daemon status: running (PID: ${pid})`);
  console.log(`Log file: ${daemonLogFile()}`);
}

async function printLogs(args: string[]): Promise<void> {
  const logPath = daemonLogFile();
  if (!existsSync(logPath)) {
    console.log("No daemon log file.");
    return;
  }

  const follow = args.includes("-f") || args.includes("--follow");
  const content = readFileSync(logPath, "utf-8");
  const lines = content.split(/\r?\n/);
  process.stdout.write(lines.slice(-101).join("\n"));

  if (!follow) {
    return;
  }

  let previousSize = readFileSync(logPath).length;
  const interval = setInterval(() => {
    if (!existsSync(logPath)) {
      return;
    }
    const data = readFileSync(logPath);
    if (data.length <= previousSize) {
      return;
    }
    process.stdout.write(data.subarray(previousSize).toString("utf-8"));
    previousSize = data.length;
  }, 1000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

function requireProvider(providers: Record<string, ProviderConfig>, providerName: string): ProviderConfig {
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}\nAvailable: ${Object.keys(providers).join(", ")}`);
  }
  return provider;
}

function formatProviders(config: Awaited<ReturnType<typeof loadConfig>>): string {
  const codexState = loadCodexCliState(config.codexHome);
  const lines = [
    `Codex home: ${codexState.codexHome}`,
    `Codex config: ${codexState.configPath}${codexState.exists ? "" : " (missing)"}`,
    `Current provider: ${codexState.effectiveProvider}`,
    `Current model: ${codexState.effectiveModel || "(provider default)"}`,
    "Providers:",
  ];

  for (const name of listCodexProviders(codexState)) {
    const fallback = config.providers[name];
    const provider = codexState.providers[name];
    const configured = provider.experimentalBearerToken
      || resolveEnvVar(provider.envKey)
      || fallback?.apiKey
      || resolveEnvVar(fallback?.apiKeyEnv)
      ? "configured"
      : "unconfigured";
    lines.push(`- ${name} [${configured}] ${provider.baseUrl || fallback?.baseUrl || "(no-base-url)"}`);
  }

  return lines.join("\n");
}

function validateStartConfig(config: Awaited<ReturnType<typeof loadConfig>>): void {
  if (!existsSync(config.defaultWorkspace)) {
    throw new Error(`Default workspace does not exist: ${config.defaultWorkspace}`);
  }

  if (!isPathAllowed(config.defaultWorkspace, config.allowedWorkspaceRoots)) {
    throw new Error("Default workspace must be inside allowed workspace roots. Run `wechat-codex add-root <path>` first.");
  }
}

function isPathAllowed(candidate: string, roots: string[]): boolean {
  const resolvedCandidate = resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolvedCandidate);
    return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
  });
}

function daemonPidFile(): string {
  return join(getDataDir(), "daemon.pid");
}

function daemonLogFile(): string {
  return join(getDataDir(), "daemon.log");
}

function isDaemonRunning(): boolean {
  const pidFile = daemonPidFile();
  if (!existsSync(pidFile)) {
    return false;
  }

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function saveTextFile(path: string, text: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, text, "utf-8");
}

function configureConsole(): void {
  if (process.platform !== "win32") {
    return;
  }

  process.stdout.setDefaultEncoding("utf8");
  process.stderr.setDefaultEncoding("utf8");
}

function _assertUnused(value: SandboxMode | ApprovalPolicy | boolean): void {
  void value;
}

_assertUnused(isSandboxCommand("workspace-write"));
_assertUnused(isApprovalCommand("never"));
