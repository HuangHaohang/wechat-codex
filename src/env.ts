import { execFileSync } from "node:child_process";

const userEnvCache = new Map<string, string | undefined>();
let mergedUserEnvCache: Record<string, string> | null = null;

export function resolveEnvVar(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const direct = process.env[name];
  if (direct && direct.trim()) {
    return direct.trim();
  }
  if (process.platform !== "win32") {
    return undefined;
  }
  if (userEnvCache.has(name)) {
    return userEnvCache.get(name);
  }

  try {
    const output = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+(.+)$`, "mi"));
    const value = match?.[1]?.trim() || undefined;
    userEnvCache.set(name, value);
    return value;
  } catch {
    userEnvCache.set(name, undefined);
    return undefined;
  }
}

export function mergeMissingUserEnv(target: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return target;
  }
  const values = getAllUserEnvVars();
  for (const [key, value] of Object.entries(values)) {
    if (!target[key] && value) {
      target[key] = value;
    }
  }
  return target;
}

function getAllUserEnvVars(): Record<string, string> {
  if (mergedUserEnvCache) {
    return mergedUserEnvCache;
  }
  try {
    const output = execFileSync("reg.exe", ["query", "HKCU\\Environment"], {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const values: Record<string, string> = {};
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_()\-]+)\s+REG_\w+\s+(.+)$/);
      if (!match) {
        continue;
      }
      const key = match[1]!.trim();
      const value = match[2]!.trim();
      if (key && value) {
        values[key] = value;
        userEnvCache.set(key, value);
      }
    }
    mergedUserEnvCache = values;
    return values;
  } catch {
    mergedUserEnvCache = {};
    return mergedUserEnvCache;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
