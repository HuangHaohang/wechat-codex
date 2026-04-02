import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { ensureDir, getAccountsDir } from "../config.js";
import type { Channel, ChannelConfig, InboundMessage, MediaAttachment, OutboundMessage } from "../types.js";

const log = createLogger("weixin");

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "1.0.3";
const API_TIMEOUT_MS = 15_000;

const MessageType = { BOT: 2 } as const;
const MessageState = { FINISH: 2 } as const;
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

interface WeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  file_id?: string;
  file_url?: string;
  file_size?: number;
}

interface WeixinMessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: { media?: CDNMedia; aeskey?: string };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string };
  video_item?: { media?: CDNMedia };
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  context_token?: string;
  item_list?: WeixinMessageItem[];
  create_time_ms?: number;
}

interface GetUpdatesResponse {
  ret?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

export class WeixinChannel implements Channel {
  readonly name = "weixin";

  private account: WeixinAccount | null = null;
  private syncBuf = "";
  private running = false;
  private abortController: AbortController | null = null;
  private readonly typingTickets = new Map<string, string>();

  constructor(private readonly config: ChannelConfig) {}

  async login(): Promise<void> {
    const baseUrl = this.config.baseUrl || DEFAULT_BASE_URL;
    const qrRes = await this.api(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3", null, {
      method: "GET",
      timeout: 10_000,
    });

    if (qrRes.ret !== 0) {
      throw new Error(`Failed to get QR code: ${qrRes.errmsg || qrRes.ret}`);
    }

    const qrUrl = qrRes.qrcode_img_content || qrRes.data?.qrcode_img_content;
    const qrCode = qrRes.qrcode || qrRes.data?.qrcode;
    if (!qrUrl || !qrCode) {
      throw new Error("QR code response missing fields");
    }

    console.log("\nWeChat login required.");
    console.log("Scan the QR code below with WeChat, then confirm on your phone.\n");
    await this.renderQrCode(qrUrl);
    console.log(`\nQR link: ${qrUrl}\n`);
    await this.saveQrPreview(qrUrl);

    let lastStatus = "pending";
    for (let attempt = 0; attempt < 60; attempt++) {
      const statusRes = await this.api(
        baseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`,
        null,
        { method: "GET", timeout: 40_000 },
      );

      const status = statusRes.data?.status || statusRes.status;
      if (status && status !== lastStatus) {
        lastStatus = status;
        console.log(statusMessage(status));
      }

      if (status === "confirmed") {
        const data = statusRes.data || statusRes;
        this.account = {
          accountId: data.ilink_bot_id || data.bot_id,
          token: data.bot_token || data.token,
          baseUrl: data.baseurl || baseUrl,
        };

        if (!this.account.accountId || !this.account.token) {
          throw new Error("Login succeeded but token missing");
        }

        await this.saveAccount();
        console.log(`Login succeeded. Bot account: ${this.account.accountId}`);
        log.info(`WeChat bot logged in: ${this.account.accountId.slice(0, 8)}...`);
        return;
      }

      if (status === "expired") {
        console.log("QR code expired. Run the command again to get a fresh code.");
        throw new Error("QR code expired");
      }

      await sleep(500);
    }

    console.log("Login timed out. Run the command again to get a fresh QR code.");
    throw new Error("Login timed out");
  }

  async start(onMessage: (message: InboundMessage) => void): Promise<void> {
    if (!this.account) {
      await this.loadAccount();
    }
    if (!this.account) {
      await this.login();
    }

    await this.loadSyncBuf();
    this.running = true;
    log.info(`WeChat channel online: ${this.account!.accountId.slice(0, 8)}...`);

    while (this.running) {
      try {
        this.abortController = new AbortController();
        const res = await this.getUpdates();

        if (res.ret === -14) {
          this.account = null;
          await this.login();
          continue;
        }

        if (res.ret && res.ret !== 0) {
          log.warn(`getupdates failed: ${res.errmsg || JSON.stringify(res)}`);
          await sleep(3_000);
          continue;
        }

        if (res.get_updates_buf) {
          this.syncBuf = res.get_updates_buf;
          await this.saveSyncBuf();
        }

        for (const message of res.msgs || []) {
          const content = await this.extractContent(message);
          if (!content || !message.from_user_id) continue;

          onMessage({
            id: String(message.message_id || message.seq || Date.now()),
            channel: this.name,
            senderId: message.from_user_id,
            text: content.text,
            media: content.media.length > 0 ? content.media : undefined,
            replyToken: message.context_token,
            timestamp: message.create_time_ms || Date.now(),
          });
        }
      } catch (error) {
        if (!this.running) break;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("AbortError")) {
          log.error(`WeChat poll failed: ${message}`);
        }
        await sleep(3_000);
      }
    }
  }

  async sendTyping(userId: string, replyToken?: string): Promise<void> {
    if (!this.account) return;

    try {
      let ticket = this.typingTickets.get(userId);
      if (!ticket) {
        const configRes = await this.api(this.account.baseUrl, "ilink/bot/getconfig", {
          ilink_user_id: userId,
          context_token: replyToken,
          base_info: { channel_version: CHANNEL_VERSION },
        });

        ticket = configRes.typing_ticket;
        if (ticket) {
          this.typingTickets.set(userId, ticket);
        }
      }

      if (!ticket) return;

      await this.api(this.account.baseUrl, "ilink/bot/sendtyping", {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: 1,
        base_info: { channel_version: CHANNEL_VERSION },
      });
    } catch {
      // Best effort only.
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.account) {
      throw new Error("WeChat account not logged in");
    }

    for (const media of message.media || []) {
      if (media.type === "image") {
        const sent = await this.sendImage(message.targetId, media, message.replyToken);
        if (!sent) {
          log.warn("Failed to send image message; continuing with text fallback.");
        }
      }
    }

    for (const chunk of chunkText(message.text || "", 4000)) {
      await this.api(this.account.baseUrl, "ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: message.targetId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: message.replyToken || undefined,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
  }

  async clearAccount(): Promise<void> {
    for (const file of [this.accountFile(), this.syncFile()]) {
      if (existsSync(file)) {
        await unlink(file);
      }
    }
    this.account = null;
    this.syncBuf = "";
  }

  private async getUpdates(): Promise<GetUpdatesResponse> {
    if (!this.account) {
      throw new Error("WeChat account not logged in");
    }

    return this.api(this.account.baseUrl, "ilink/bot/getupdates", {
      get_updates_buf: this.syncBuf,
      base_info: { channel_version: CHANNEL_VERSION },
    }, { timeout: 50_000 });
  }

  private async extractContent(message: WeixinMessage): Promise<{ text: string; media: MediaAttachment[] } | null> {
    if (!message.item_list?.length) return null;

    const texts: string[] = [];
    const media: MediaAttachment[] = [];

    for (const item of message.item_list) {
      switch (item.type) {
        case MessageItemType.TEXT:
          if (item.text_item?.text) {
            texts.push(item.text_item.text);
          }
          break;
        case MessageItemType.IMAGE:
          if (item.image_item?.media?.encrypt_query_param) {
            const dataUrl = await this.downloadMedia(
              item.image_item.media.encrypt_query_param,
              item.image_item.aeskey || fromMediaKey(item.image_item.media.aes_key),
            );
            if (dataUrl) {
              media.push({ type: "image", dataUrl, url: dataUrl, mimeType: mimeFromDataUrl(dataUrl) });
            }
          }
          break;
        case MessageItemType.VOICE:
          if (item.voice_item?.text) {
            texts.push(item.voice_item.text);
            media.push({ type: "voice", transcriptText: item.voice_item.text });
          } else if (item.voice_item?.media?.encrypt_query_param) {
            const dataUrl = await this.downloadMedia(
              item.voice_item.media.encrypt_query_param,
              fromMediaKey(item.voice_item.media.aes_key),
            );
            media.push({
              type: "voice",
              dataUrl: dataUrl || undefined,
              url: dataUrl || item.voice_item.media.encrypt_query_param,
              mimeType: dataUrl ? mimeFromDataUrl(dataUrl) : undefined,
            });
          }
          break;
        case MessageItemType.FILE:
          if (item.file_item?.media?.encrypt_query_param) {
            media.push({
              type: "file",
              url: item.file_item.media.encrypt_query_param,
              fileName: item.file_item.file_name,
            });
          }
          break;
        case MessageItemType.VIDEO:
          if (item.video_item?.media?.encrypt_query_param) {
            media.push({ type: "video", url: item.video_item.media.encrypt_query_param });
          }
          break;
      }
    }

    if (texts.length === 0 && media.length === 0) return null;

    return {
      text: texts.join("\n") || "[media]",
      media,
    };
  }

  private async downloadMedia(encryptParam: string, aesKey?: string): Promise<string | null> {
    try {
      const res = await fetch(
        `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptParam)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!res.ok) return null;

      let buffer = Buffer.from(await res.arrayBuffer());
      if (aesKey) {
        try {
          const key = aesKey.startsWith("base64:")
            ? Buffer.from(aesKey.slice(7), "base64")
            : Buffer.from(aesKey, "hex");
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
        } catch {
          // Use raw content if decrypt fails.
        }
      }

      return `data:${detectMimeType(buffer)};base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    }
  }

  private async sendImage(targetId: string, media: MediaAttachment, replyToken?: string): Promise<boolean> {
    const buffer = await this.resolveOutboundImage(media);
    if (!buffer) {
      return false;
    }

    const mediaRef = await this.uploadMedia(buffer, "image", media.mimeType || "image/png");
    if (!mediaRef) {
      return false;
    }

    await this.api(this.account!.baseUrl, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: targetId,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: replyToken || undefined,
        item_list: [{
          type: MessageItemType.IMAGE,
          image_item: {
            media: mediaRef,
          },
        }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });

    return true;
  }

  private async resolveOutboundImage(media: MediaAttachment): Promise<Buffer | null> {
    if (media.dataUrl) {
      return decodeDataUrl(media.dataUrl);
    }

    if (media.url?.startsWith("data:")) {
      return decodeDataUrl(media.url);
    }

    if (media.url?.startsWith("http://") || media.url?.startsWith("https://")) {
      const res = await fetch(media.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        return null;
      }
      return Buffer.from(await res.arrayBuffer());
    }

    return null;
  }

  private async uploadMedia(
    data: Buffer,
    type: "image" | "voice" | "video" | "file",
    mimeType: string,
  ): Promise<CDNMedia | null> {
    if (!this.account) {
      return null;
    }

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(data)], { type: mimeType });
    const ext = mimeType.split("/")[1] || "bin";
    formData.append("media", blob, `upload.${ext}`);
    formData.append("type", type);

    const res = await fetch(`${this.account.baseUrl.replace(/\/$/, "")}/ilink/bot/uploadmedia`, {
      method: "POST",
      headers: {
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${this.account.token}`,
        "X-WECHAT-UIN": randomUin(),
      },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error(`uploadmedia failed: ${res.status} ${body.slice(0, 200)}`);
      return null;
    }

    const json = await res.json() as { media?: CDNMedia; data?: { media?: CDNMedia } };
    return json.media || json.data?.media || null;
  }

  private async api(
    baseUrl: string,
    path: string,
    body: unknown,
    options: { method?: string; timeout?: number } = {},
  ): Promise<any> {
    const method = options.method || "POST";
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.account?.token) {
      headers.AuthorizationType = "ilink_bot_token";
      headers.Authorization = `Bearer ${this.account.token}`;
      headers["X-WECHAT-UIN"] = randomUin();
      if (bodyStr) {
        headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));
      }
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${path}`, {
      method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(options.timeout || API_TIMEOUT_MS),
    });
    const text = await res.text();

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Unexpected WeChat response: ${text.slice(0, 200)}`);
    }
  }

  private accountFile(): string {
    return join(getAccountsDir(), "weixin.json");
  }

  private syncFile(): string {
    return join(getAccountsDir(), "weixin-sync.json");
  }

  private async saveAccount(): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.accountFile(), JSON.stringify(this.account, null, 2));
  }

  private async saveQrPreview(qrValue: string): Promise<void> {
    const target = join(getAccountsDir(), "weixin-qr.txt");
    await ensureDir(getAccountsDir());

    if (/^https?:\/\//i.test(qrValue)) {
      await writeFile(target, qrValue, "utf-8");
      return;
    }

    await writeFile(target, qrValue, "utf-8");
  }

  private async renderQrCode(qrValue: string): Promise<void> {
    try {
      const qrTerminal = await import("qrcode-terminal");
      const renderer = qrTerminal.default || qrTerminal;
      await new Promise<void>((resolvePromise) => {
        renderer.generate(qrValue, { small: true }, (output: string) => {
          process.stdout.write(`${output}\n`);
          resolvePromise();
        });
      });
    } catch {
      process.stdout.write("[QR rendering unavailable in terminal]\n");
    }
  }

  private async loadAccount(): Promise<void> {
    const file = this.accountFile();
    if (!existsSync(file)) return;
    this.account = JSON.parse(await readFile(file, "utf-8")) as WeixinAccount;
  }

  private async saveSyncBuf(): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.syncFile(), JSON.stringify({ get_updates_buf: this.syncBuf }));
  }

  private async loadSyncBuf(): Promise<void> {
    const file = this.syncFile();
    if (!existsSync(file)) return;
    const raw = JSON.parse(await readFile(file, "utf-8")) as { get_updates_buf?: string };
    this.syncBuf = raw.get_updates_buf || "";
  }
}

function fromMediaKey(aesKey?: string): string | undefined {
  return aesKey ? `base64:${aesKey}` : undefined;
}

function detectMimeType(buffer: Buffer): string {
  if (buffer.length >= 12 && buffer.subarray(0, 4).equals(Buffer.from("RIFF")) && buffer.subarray(8, 12).equals(Buffer.from("WAVE"))) {
    return "audio/wav";
  }
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return "audio/mpeg";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from("OggS"))) {
    return "audio/ogg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).equals(Buffer.from("#!AMR\n"))) {
    return "audio/amr";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return "audio/webm";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
  return "application/octet-stream";
}

function mimeFromDataUrl(dataUrl: string): string | undefined {
  const match = /^data:([^;]+);base64,/i.exec(dataUrl);
  return match?.[1];
}

function chunkText(text: string, maxLen: number): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let index = rest.lastIndexOf("\n", maxLen);
    if (index <= 0) index = maxLen;
    chunks.push(rest.slice(0, index));
    rest = rest.slice(index);
  }
  return chunks;
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Unsupported image data URL");
  }
  return Buffer.from(match[2]!, "base64");
}

function randomUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf-8").toString("base64");
}

function generateClientId(): string {
  return `wcdx-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function statusMessage(status: string): string {
  switch (status) {
    case "scanned":
      return "QR scanned. Waiting for confirmation on your phone...";
    case "confirmed":
      return "Confirmation received. Finalizing login...";
    case "pending":
      return "Waiting for QR scan...";
    case "expired":
      return "QR code expired.";
    default:
      return `Login status: ${status}`;
  }
}
