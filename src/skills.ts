import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface InstalledSkill {
  name: string;
  system: boolean;
  path: string;
}

export async function listInstalledSkills(codexHome: string): Promise<InstalledSkill[]> {
  const skillsRoot = join(codexHome, "skills");
  const result: InstalledSkill[] = [];

  if (!existsSync(skillsRoot)) {
    return result;
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".system") {
      const systemRoot = join(skillsRoot, entry.name);
      const systemEntries = await readdir(systemRoot, { withFileTypes: true });
      for (const systemEntry of systemEntries) {
        if (!systemEntry.isDirectory() || systemEntry.name.startsWith(".")) {
          continue;
        }
        const skillPath = join(systemRoot, systemEntry.name);
        if (await hasSkillFile(skillPath)) {
          result.push({ name: systemEntry.name, system: true, path: skillPath });
        }
      }
      continue;
    }

    const skillPath = join(skillsRoot, entry.name);
    if (await hasSkillFile(skillPath)) {
      result.push({ name: entry.name, system: false, path: skillPath });
    }
  }

  return result.sort((left, right) => left.name.localeCompare(right.name));
}

async function hasSkillFile(path: string): Promise<boolean> {
  try {
    const file = join(path, "SKILL.md");
    const details = await stat(file);
    return details.isFile();
  } catch {
    return false;
  }
}
