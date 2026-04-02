import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveEnvVar } from "./env.js";
import { createLogger } from "./logger.js";
import type { MediaAttachment, ProviderConfig } from "./types.js";

const log = createLogger("media");
export interface PreparedMediaPayload {
  prompt: string;
  imagePaths: string[];
  cleanup(): Promise<void>;
}

interface SavedAttachment {
  path: string;
  mimeType?: string;
}

export async function prepareMediaPayload(
  text: string,
  media: MediaAttachment[] | undefined,
  config: ProviderConfig,
): Promise<PreparedMediaPayload> {
  if (!media || media.length === 0) {
    return {
      prompt: normalizeUserText(text),
      imagePaths: [],
      cleanup: async () => {},
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "wechat-codex-media-"));
  const imagePaths: string[] = [];
  const voiceTranscripts: string[] = [];
  const notes: string[] = [];

  try {
    for (let index = 0; index < media.length; index += 1) {
      const attachment = media[index]!;
      const saved = await persistAttachment(attachment, tempDir, index);

      if (attachment.type === "image" && saved) {
        imagePaths.push(saved.path);
        continue;
      }

      if (attachment.type === "voice") {
        if (attachment.transcriptText?.trim()) {
          voiceTranscripts.push(attachment.transcriptText.trim());
          continue;
        }

        if (saved) {
          const transcript = await transcribeVoice(saved.path, saved.mimeType || attachment.mimeType, config);
          if (transcript) {
            voiceTranscripts.push(transcript);
          } else {
            notes.push(`voice attachment saved at ${saved.path}, but transcription was unavailable`);
          }
        } else {
          notes.push("voice attachment received, but media bytes were unavailable");
        }
        continue;
      }

      if (saved) {
        notes.push(`${attachment.type} attachment saved at ${saved.path}`);
      } else {
        notes.push(`${attachment.type} attachment received`);
      }
    }

    const promptSections: string[] = [];
    const normalizedText = normalizeUserText(text);
    if (normalizedText) {
      promptSections.push(normalizedText);
    }
    if (voiceTranscripts.length > 0) {
      promptSections.push([
        "Voice transcript(s) from the user:",
        ...voiceTranscripts.map((item, index) => `${index + 1}. ${item}`),
      ].join("\n"));
    }
    if (imagePaths.length > 0) {
      promptSections.push(`The user attached ${imagePaths.length} image(s). They are included as image inputs to the model.`);
    }
    if (notes.length > 0) {
      promptSections.push(["Attachment notes:", ...notes.map((item) => `- ${item}`)].join("\n"));
    }

    return {
      prompt: promptSections.join("\n\n").trim() || "The user sent attachments without text. Inspect the provided attachments and respond helpfully.",
      imagePaths,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function persistAttachment(
  attachment: MediaAttachment,
  tempDir: string,
  index: number,
): Promise<SavedAttachment | null> {
  const dataUrl = attachment.dataUrl || (attachment.url?.startsWith("data:") ? attachment.url : undefined);
  if (!dataUrl) {
    return null;
  }

  const parsed = parseDataUrl(dataUrl);
  const extension = extFromMime(parsed.mimeType) || extname(attachment.fileName || "") || ".bin";
  const fileName = sanitizeFileName(attachment.fileName || `${attachment.type}-${index + 1}${extension}`);
  const target = join(tempDir, fileName);
  await writeFile(target, parsed.buffer);

  return {
    path: target,
    mimeType: attachment.mimeType || parsed.mimeType,
  };
}

async function transcribeVoice(
  filePath: string,
  mimeType: string | undefined,
  config: ProviderConfig,
): Promise<string | null> {
  const resolvedApiKey = config.apiKey || resolveEnvVar(config.apiKeyEnv) || resolveEnvVar("OPENAI_API_KEY");
  if (!resolvedApiKey) {
    return null;
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");

  const effectiveMime = mimeType || mimeFromExtension(filePath);
  if (!isTranscriptionFormatSupported(filePath, effectiveMime)) {
    return null;
  }

  const fileBuffer = await readFile(filePath);
  const form = new FormData();
  form.set("model", "gpt-4o-mini-transcribe");
  form.set("response_format", "json");
  form.set("file", new Blob([new Uint8Array(fileBuffer)], { type: effectiveMime || "application/octet-stream" }), basename(filePath));

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolvedApiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errorText = (await res.text()).slice(0, 500);
    log.warn(`Voice transcription failed: ${res.status} ${errorText}`);
    return null;
  }

  const json = await res.json() as { text?: string };
  return json.text?.trim() || null;
}

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Unsupported data URL attachment");
  }

  return {
    mimeType: match[1]!,
    buffer: Buffer.from(match[2]!, "base64"),
  };
}

function normalizeUserText(text: string): string {
  const trimmed = text.trim();
  return trimmed === "[media]" ? "" : trimmed;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
}

function extFromMime(mimeType: string | undefined): string | undefined {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".mp4";
    case "audio/x-m4a":
      return ".m4a";
    case "audio/wav":
      return ".wav";
    case "audio/webm":
      return ".webm";
    case "audio/amr":
      return ".amr";
    default:
      return undefined;
  }
}

function mimeFromExtension(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "audio/mp4";
    case ".m4a":
      return "audio/x-m4a";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    case ".amr":
      return "audio/amr";
    default:
      return undefined;
  }
}

function isTranscriptionFormatSupported(filePath: string, mimeType: string | undefined): boolean {
  const extension = extname(filePath).toLowerCase();
  return [
    ".mp3",
    ".mp4",
    ".mpeg",
    ".mpga",
    ".m4a",
    ".wav",
    ".webm",
  ].includes(extension) || [
    "audio/mpeg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/wav",
    "audio/webm",
  ].includes(mimeType || "");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
