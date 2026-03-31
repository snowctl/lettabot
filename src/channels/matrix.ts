/**
 * Matrix Channel Adapter
 *
 * Uses matrix-js-sdk for Matrix homeserver communication with E2EE support.
 * Supports DM pairing for secure access control.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, InboundReaction, OutboundFile, OutboundMessage } from '../core/types.js';
import type { DmPolicy } from '../pairing/types.js';
import { isUserAllowed, upsertPairingRequest } from '../pairing/store.js';
import { checkDmAccess } from './shared/access-control.js';
import { isGroupApproved, approveGroup } from '../pairing/group-store.js';
import { resolveEmoji } from './shared/emoji.js';
import { splitMessageText } from './shared/message-splitter.js';
import { buildAttachmentPath, downloadToFile } from './attachments.js';
import { HELP_TEXT } from '../core/commands.js';
import { isGroupAllowed, isGroupUserAllowed, resolveGroupMode, resolveDailyLimits, checkDailyLimit, type GroupMode, type GroupModeConfig } from './group-mode.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { createLogger } from '../logger.js';
import { markdownToHtml } from './matrix-html-formatter.js';
import { getCryptoCallbacks, initE2EE, checkAndRestoreKeyBackup } from './matrix-crypto.js';


const log = createLogger('Matrix');

const MATRIX_SPLIT_THRESHOLD = 64000;
const MATRIX_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15000;

/** MIME types that indicate a voice/audio message eligible for transcription. */
const VOICE_MIME_TYPES = new Set([
  'audio/ogg', 'audio/opus', 'audio/webm', 'audio/mp4', 'audio/mpeg',
  'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aac',
]);

function isVoiceMimeType(mimeType: string): boolean {
  // Match exact type or audio/* with voice-like codecs
  return VOICE_MIME_TYPES.has(mimeType) || mimeType.startsWith('audio/ogg');
}

const KNOWN_MATRIX_COMMANDS = new Set([
  'status', 'heartbeat', 'reset', 'cancel', 'approve', 'disapprove',
  'help', 'start', 'model', 'models', 'setconv', 'breakglass', 'recompile',
  'palace',
]);

export interface MatrixAdapterConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  allowedUsers?: string[];
  streaming?: boolean;
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
  mentionPatterns?: string[];
  groups?: Record<string, GroupModeConfig>;
  agentName?: string;
  e2ee?: boolean;
  recoveryKey?: string;
  storePath?: string;
}

/**
 * Convert mxc:// URI to an HTTPS download URL.
 *
 * Uses the authenticated client media endpoint (Matrix v1.11+) which
 * requires a Bearer token.  Falls back to the legacy /_matrix/media/v3
 * path only when the caller cannot supply auth.
 */
function mxcToHttp(homeserverUrl: string, mxcUrl: string): string {
  const withoutScheme = mxcUrl.slice('mxc://'.length);
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) return mxcUrl;
  const server = withoutScheme.slice(0, slashIdx);
  const mediaId = withoutScheme.slice(slashIdx + 1);
  return `${homeserverUrl}/_matrix/client/v1/media/download/${server}/${mediaId}`;
}

function formatPairingMsg(code: string): string {
  return `Hi! This bot requires pairing.\n\nYour pairing code: **${code}**\n\nAsk the bot owner to approve with:\n\`lettabot pairing approve matrix ${code}\``;
}

export class MatrixAdapter implements ChannelAdapter {
  readonly id = 'matrix' as const;
  readonly name = 'Matrix';

  private client: import('matrix-js-sdk').MatrixClient | null = null;
  private config: MatrixAdapterConfig;
  private running = false;
  private roomMemberCache: Map<string, number> = new Map();
  private roomNameCache: Map<string, string> = new Map();

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string, chatId?: string, args?: string, forcePerChat?: boolean) => Promise<string | null>;

  constructor(config: MatrixAdapterConfig) {
    this.config = config;
  }

  private async checkAccess(userId: string): Promise<'allowed' | 'blocked' | 'pairing'> {
    return checkDmAccess('matrix', userId, this.config.dmPolicy, this.config.allowedUsers);
  }

  /**
   * Check if a room is a DM (≤2 members). Uses cached member count.
   */
  private isRoomDm(roomId: string): boolean {
    if (this.roomMemberCache.has(roomId)) {
      return this.roomMemberCache.get(roomId)! <= 2;
    }

    if (!this.client) return false;

    const room = this.client.getRoom(roomId);
    if (!room) return false;

    const members = room.getJoinedMembers();
    const count = members.length;
    this.roomMemberCache.set(roomId, count);
    return count <= 2;
  }

  private getRoomName(roomId: string): string | undefined {
    if (this.roomNameCache.has(roomId)) {
      return this.roomNameCache.get(roomId);
    }

    if (!this.client) return undefined;

    const room = this.client.getRoom(roomId);
    if (!room) return undefined;

    const nameEvent = room.currentState.getStateEvents('m.room.name', '');
    const name = nameEvent?.getContent()?.name as string | undefined;
    if (name) {
      this.roomNameCache.set(roomId, name);
      return name;
    }

    return undefined;
  }

  async start(): Promise<void> {
    if (this.running) return;

    log.info('Loading matrix-js-sdk...');

    // IndexedDB polyfill required for rust crypto in Node.js
    await import('fake-indexeddb/auto');

    const sdk = await import('matrix-js-sdk');

    const storePath = this.config.storePath || './data/matrix-store';
    log.info(`Storage path: ${storePath}`);

    const clientOpts: Parameters<typeof sdk.createClient>[0] = {
      baseUrl: this.config.homeserverUrl,
      accessToken: this.config.accessToken,
      userId: this.config.userId,
      deviceId: this.config.deviceId,
    };

    if (this.config.e2ee) {
      clientOpts.cryptoCallbacks = getCryptoCallbacks(this.config.recoveryKey);
    }

    const matrixClient = sdk.createClient(clientOpts);
    this.client = matrixClient;

    // Initialize E2EE before starting the client
    if (this.config.e2ee) {
      await initE2EE(matrixClient, {
        enableEncryption: true,
        recoveryKey: this.config.recoveryKey,
        storeDir: storePath,
        userId: this.config.userId,
      });
    }

    // Auto-join on invite (replaces matrix-bot-sdk's AutojoinRoomsMixin)
    matrixClient.on(sdk.RoomEvent.MyMembership, (room, membership) => {
      if (membership === sdk.KnownMembership.Invite) {
        matrixClient.joinRoom(room.roomId).then(() => {
          log.info(`Auto-joined room ${room.roomId}`);
          this.handleRoomJoin(room.roomId).catch((err) => {
            log.error('Error handling room.join:', err);
          });
        }).catch((err) => {
          log.error(`Failed to auto-join room ${room.roomId}:`, err);
        });
      }
    });
    log.info('Auto-join on invite enabled');

    // Listen for timeline events (messages, reactions, state changes)
    matrixClient.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      // Skip historical events loaded during initial sync
      if (toStartOfTimeline) return;

      const eventType = event.getType();
      const roomId = event.getRoomId();
      if (!roomId) return;

      if (eventType === 'm.room.message') {
        this.handleRoomMessage(roomId, event).catch((err) => {
          log.error('Error handling room.message:', err);
        });
      } else if (eventType === 'm.reaction') {
        this.handleReaction(roomId, event).catch((err) => {
          log.error('Error handling m.reaction:', err);
        });
      } else if (eventType === 'm.room.member') {
        this.roomMemberCache.delete(roomId);
      } else if (eventType === 'm.room.name') {
        this.roomNameCache.delete(roomId);
      }
    });

    log.info(`Connecting to Matrix homeserver at ${this.config.homeserverUrl}...`);
    try {
      await matrixClient.startClient({ initialSyncLimit: 10 });
    } catch (err) {
      log.error('matrix-js-sdk startClient() failed:', err);
      throw err;
    }

    // After first sync, restore key backup if E2EE is enabled
    if (this.config.e2ee) {
      matrixClient.once(sdk.ClientEvent.Sync, (state: string) => {
        if (state === 'PREPARED') {
          checkAndRestoreKeyBackup(matrixClient, this.config.recoveryKey).catch((err) => {
            log.error('Key backup restore failed:', err);
          });
        }
      });
    }

    this.running = true;
    log.info(`Matrix adapter started as ${this.config.userId}`);
    log.info(`DM policy: ${this.config.dmPolicy}`);
    log.info(`E2EE: ${this.config.e2ee ? 'enabled' : 'disabled'}`);
    if (this.config.groups && Object.keys(this.config.groups).length > 0) {
      log.info(`Configured groups: ${Object.keys(this.config.groups).join(', ')}`);
    }
    if (this.config.mentionPatterns?.length) {
      log.info(`Mention patterns: ${this.config.mentionPatterns.join(', ')}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.client) return;
    this.client.stopClient();
    this.running = false;
    log.info('Matrix adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle the bot joining a room — auto-approve groups when a paired user invites.
   * Mirrors Telegram's my_chat_member handler.
   */
  private async handleRoomJoin(roomId: string): Promise<void> {
    const isDm = this.isRoomDm(roomId);
    if (isDm) return; // DM rooms don't need group approval

    const dmPolicy = this.config.dmPolicy || 'pairing';
    if (dmPolicy !== 'pairing') {
      await approveGroup('matrix', roomId);
      log.info(`Group ${roomId} auto-approved (dmPolicy=${dmPolicy})`);
      return;
    }

    // Try to identify who invited the bot by checking room members
    try {
      const room = this.client!.getRoom(roomId);
      const members = room?.getJoinedMembers() || [];
      const otherMembers = members.filter(m => m.userId !== this.config.userId);
      const configAllowlist = this.config.allowedUsers;

      for (const member of otherMembers) {
        const allowed = await isUserAllowed('matrix', member.userId, configAllowlist);
        if (allowed) {
          await approveGroup('matrix', roomId);
          log.info(`Group ${roomId} approved by paired user ${member.userId}`);
          return;
        }
      }
      log.info(`Joined group ${roomId} but no paired users found — group not approved`);
    } catch (err) {
      log.warn('Failed to check group members for approval:', err);
    }
  }

  /**
   * Handle inbound m.reaction events — mirrors Telegram's message_reaction handler.
   */
  private async handleReaction(roomId: string, event: import('matrix-js-sdk').MatrixEvent): Promise<void> {
    const sender = event.getSender();
    if (!sender || sender === this.config.userId) return;

    const content = event.getContent();
    if (!content) return;

    const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined;
    if (!relatesTo) return;

    const targetEventId = relatesTo['event_id'] as string | undefined;
    const emoji = relatesTo['key'] as string | undefined;
    if (!targetEventId || !emoji) return;

    // DM access check
    const isDm = this.isRoomDm(roomId);
    if (isDm) {
      const access = await this.checkAccess(sender);
      if (access !== 'allowed') return;
    }

    log.info(`Reaction ${emoji} from ${sender} on ${targetEventId} in ${roomId}`);

    if (!this.onMessage) return;

    const reaction: InboundReaction = {
      emoji,
      messageId: targetEventId,
      action: 'added',
    };

    await this.onMessage({
      channel: 'matrix' as import('../core/types.js').ChannelId,
      chatId: roomId,
      userId: sender,
      userName: sender,
      messageId: targetEventId,
      text: '',
      timestamp: new Date(),
      reaction,
      formatterHints: this.getFormatterHints(),
    });
  }

  private async handleRoomMessage(roomId: string, event: import('matrix-js-sdk').MatrixEvent): Promise<void> {
    const sender = event.getSender();
    if (!sender || sender === this.config.userId) return;

    const content = event.getContent();
    if (!content) return;

    const msgtype = content['msgtype'] as string | undefined;
    if (!msgtype) return;

    const eventId = event.getId();
    const timestamp = new Date(event.getTs());
    const body = (content['body'] as string | undefined) || '';

    const isDm = this.isRoomDm(roomId);
    const isGroup = !isDm;

    log.info(`Message from ${sender} in ${isDm ? 'DM' : 'group'} ${roomId} (type: ${msgtype})`);

    // Group approval check (mirrors Telegram's pairing-based group gating)
    if (isGroup) {
      const dmPolicy = this.config.dmPolicy || 'pairing';
      if (dmPolicy !== 'open' && !(await isGroupApproved('matrix', roomId))) {
        log.info(`Group ${roomId} not approved, ignoring message`);
        return;
      }
    }

    if (isDm) {
      const access = await this.checkAccess(sender);
      log.info(`DM access check for ${sender}: ${access}`);
      if (access === 'blocked') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.client!.sendMessage(roomId, { msgtype: 'm.text', body: "Sorry, you're not authorized to use this bot." } as any);
        return;
      }
      if (access === 'pairing') {
        const { code, created } = await upsertPairingRequest('matrix', sender, {
          username: sender,
        });
        if (!code) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await this.client!.sendMessage(roomId, { msgtype: 'm.text', body: 'Too many pending pairing requests. Please try again later.' } as any);
          return;
        }
        if (created) {
          log.info(`New pairing request from ${sender}: ${code}`);
        }
        const pairingText = formatPairingMsg(code);
        await this.client!.sendMessage(roomId, {
          msgtype: 'm.text',
          body: pairingText,
          format: 'org.matrix.custom.html',
          formatted_body: markdownToHtml(pairingText),
        } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        return;
      }
    }

    const wasMentioned = isGroup ? this.isMentioned(body) : undefined;
    let groupMode: GroupMode | undefined;
    let groupName: string | undefined;

    // Group gating
    if (isGroup) {
      groupName = this.getRoomName(roomId);

      if (this.config.groups) {
        const keys = [roomId];
        if (!isGroupAllowed(this.config.groups, keys)) {
          log.info(`Room ${roomId} (${groupName ?? 'unnamed'}) not in allowlist, ignoring`);
          return;
        }
        if (!isGroupUserAllowed(this.config.groups, keys, sender)) {
          log.info(`User ${sender} not allowed in group ${roomId}`);
          return;
        }
        groupMode = resolveGroupMode(this.config.groups, keys, 'open');
        if (groupMode === 'disabled') {
          log.info(`Group ${roomId} mode is disabled, ignoring`);
          return;
        }
        if (groupMode === 'mention-only' && !wasMentioned) {
          log.info(`Group ${roomId} is mention-only and bot was not mentioned, ignoring`);
          return;
        }

        const limits = resolveDailyLimits(this.config.groups, keys);
        const counterScope = limits.matchedKey ?? roomId;
        const counterKey = `${this.config.agentName ?? ''}:matrix:${counterScope}`;
        const limitResult = checkDailyLimit(counterKey, sender, limits);
        if (!limitResult.allowed) {
          log.info(`Daily limit reached for ${counterKey} (${limitResult.reason})`);
          return;
        }
      }
    }

    if (msgtype === 'm.text' && body.startsWith('/')) {
      const parts = body.slice(1).split(/\s+/);
      const command = parts[0]?.toLowerCase();
      const cmdArgs = parts.slice(1).join(' ') || undefined;

      if (command && KNOWN_MATRIX_COMMANDS.has(command)) {
        log.info(`Command: /${command}${cmdArgs ? ` ${cmdArgs}` : ''} from ${sender}`);
        if (command === 'help' || command === 'start') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await this.client!.sendMessage(roomId, { msgtype: 'm.text', body: HELP_TEXT } as any);
          return;
        }

        if (this.onCommand) {
          const result = await this.onCommand(command, roomId, cmdArgs);
          if (result) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await this.client!.sendMessage(roomId, { msgtype: 'm.text', body: result } as any);
          }
          return;
        }
      } else if (command) {
        // Unknown command — send feedback (mirrors Telegram behavior)
        log.info(`Unknown command: /${command} from ${sender}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.client!.sendMessage(roomId, { msgtype: 'm.text', body: `Unknown command: /${command}\nTry /help.` } as any);
        return;
      }
    }

    if (!this.onMessage) return;

    let text = '';
    const attachments: InboundAttachment[] = [];

    if (msgtype === 'm.text') {
      text = body;
    } else if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.audio' || msgtype === 'm.video') {
      const mxcUrl = content['url'] as string | undefined;
      const fileName = (content['body'] as string | undefined) || 'attachment';
      const info = content['info'] as Record<string, unknown> | undefined;
      const mimeType = info?.['mimetype'] as string | undefined;
      const size = info?.['size'] as number | undefined;

      const kind: InboundAttachment['kind'] =
        msgtype === 'm.image' ? 'image' :
        msgtype === 'm.audio' ? 'audio' :
        msgtype === 'm.video' ? 'video' : 'file';

      const httpUrl = mxcUrl ? mxcToHttp(this.config.homeserverUrl, mxcUrl) : undefined;
      const authHeaders = { 'Authorization': `Bearer ${this.config.accessToken}` };

      const attachment: InboundAttachment = {
        id: eventId,
        name: fileName,
        mimeType,
        size,
        kind,
        // Don't expose httpUrl — it requires Matrix session auth that the agent doesn't have.
        // The agent uses localPath instead (downloaded below).
      };

      if (httpUrl) {
        const skipForSize = this.config.attachmentsMaxBytes !== undefined
          && this.config.attachmentsMaxBytes !== 0
          && size !== undefined
          && size > this.config.attachmentsMaxBytes;

        if (skipForSize) {
          log.warn(`Attachment ${fileName} exceeds size limit, skipping download.`);
        } else {
          const attachDir = this.config.attachmentsDir || '/tmp/lettabot-matrix';
          const target = buildAttachmentPath(attachDir, 'matrix', roomId, fileName);
          try {
            await downloadToFile(httpUrl, target, {
              timeoutMs: MATRIX_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
              headers: authHeaders,
            });
            attachment.localPath = target;
            log.info(`Attachment saved to ${target}`);
          } catch (err) {
            log.warn('Failed to download attachment:', err);
          }
        }
      }

      attachments.push(attachment);
      log.info(`Attachment: ${kind} "${fileName}" from ${sender}`);

      // Voice transcription: if this is an audio message with a voice MIME type, transcribe it
      // Mirrors Telegram's message:voice handler
      if (kind === 'audio' && mimeType && isVoiceMimeType(mimeType) && httpUrl) {
        text = await this.tryTranscribeVoice(httpUrl, fileName, roomId);
      }
    }

    if (!text && attachments.length === 0) return;

    const isListeningMode = groupMode === 'listen' && !wasMentioned;

    log.info(`Forwarding message to bot core (group=${isGroup}, listening=${isListeningMode}, mentioned=${wasMentioned})`);
    await this.onMessage({
      channel: 'matrix' as import('../core/types.js').ChannelId,
      chatId: roomId,
      userId: sender,
      userName: sender,
      userHandle: sender,
      messageId: eventId,
      text,
      timestamp,
      isGroup,
      groupName,
      wasMentioned,
      isListeningMode,
      attachments,
      formatterHints: this.getFormatterHints(),
    });
  }

  private isMentioned(text: string): boolean {
    if (text.includes(this.config.userId)) return true;
    if (this.config.mentionPatterns) {
      for (const pattern of this.config.mentionPatterns) {
        try {
          if (new RegExp(pattern).test(text)) return true;
        } catch {
          // Invalid pattern — ignore
        }
      }
    }
    return false;
  }

  /**
   * Attempt to transcribe a voice/audio message. Mirrors Telegram's voice handler.
   * Returns the transcription text or an error description.
   */
  private async tryTranscribeVoice(httpUrl: string, fileName: string, roomId: string): Promise<string> {
    const { isTranscriptionConfigured } = await import('../transcription/index.js');
    if (!isTranscriptionConfigured()) {
      log.info('Voice message received but transcription not configured');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.client!.sendMessage(roomId, { msgtype: 'm.text', body: 'Voice messages require a transcription API key.' } as any);
      return '';
    }

    try {
      log.info(`Transcribing voice message: ${fileName}`);
      const response = await fetch(httpUrl, {
        headers: { 'Authorization': `Bearer ${this.config.accessToken}` },
      });
      const buffer = Buffer.from(await response.arrayBuffer());

      const { transcribeAudio } = await import('../transcription/index.js');
      const result = await transcribeAudio(buffer, fileName);

      if (result.success && result.text) {
        log.info(`Transcribed voice message: "${result.text.slice(0, 50)}..."`);
        return `[Voice message]: ${result.text}`;
      } else {
        log.error(`Transcription failed: ${result.error}`);
        return `[Voice message - transcription failed: ${result.error}]`;
      }
    } catch (error) {
      log.error('Error processing voice message:', error);
      return `[Voice message - error: ${error instanceof Error ? error.message : 'unknown error'}]`;
    }
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Matrix adapter not started');

    const chunks = splitMessageText(msg.text, MATRIX_SPLIT_THRESHOLD);
    let lastEventId = '';

    log.info(`Sending message to ${msg.chatId} (${chunks.length} chunk(s), ${msg.text.length} chars)`);
    for (const chunk of chunks) {
      // If caller already provided HTML (e.g., reasoning display), use it directly
      const htmlBody = msg.parseMode === 'HTML' ? chunk : markdownToHtml(chunk);
      // Strip HTML tags for the plain text fallback body
      const plainBody = msg.parseMode === 'HTML'
        ? chunk.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        : chunk;
      const resp = await this.client.sendMessage(msg.chatId, {
        msgtype: 'm.text',
        body: plainBody,
        format: 'org.matrix.custom.html',
        formatted_body: htmlBody,
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
      lastEventId = resp.event_id;
    }

    return { messageId: lastEventId };
  }

  async sendFile(file: OutboundFile): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Matrix adapter not started');

    const fileName = basename(file.filePath);
    log.info(`Sending file "${fileName}" (${file.kind}) to ${file.chatId}`);
    const buffer = await readFile(file.filePath);
    const uploadResp = await this.client.uploadContent(buffer, { name: fileName });
    const mxcUrl = uploadResp.content_uri;

    const msgtype =
      file.kind === 'image' ? 'm.image' :
      file.kind === 'audio' ? 'm.audio' : 'm.file';

    const resp = await this.client.sendMessage(file.chatId, {
      msgtype,
      body: file.caption || fileName,
      url: mxcUrl,
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    return { messageId: resp.event_id };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Matrix adapter not started');

    log.info(`Editing message ${messageId} in ${chatId}`);
    const htmlBody = markdownToHtml(text);
    await this.client.sendMessage(chatId, {
      msgtype: 'm.text',
      body: `* ${text}`,
      format: 'org.matrix.custom.html',
      formatted_body: `<p>${htmlBody}</p>`,
      'm.new_content': {
        msgtype: 'm.text',
        body: text,
        format: 'org.matrix.custom.html',
        formatted_body: htmlBody,
      },
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: messageId,
      },
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Matrix adapter not started');

    const resolved = resolveEmoji(emoji);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.client.sendEvent(chatId, 'm.reaction' as any, {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: messageId,
        key: resolved,
      },
    });
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendTyping(chatId, true, 5000);
    } catch {
      // Ignore typing failures
    }
  }

  async stopTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendTyping(chatId, false, 0);
    } catch {
      // Ignore typing failures
    }
  }

  supportsEditing(): boolean {
    return this.config.streaming ?? false;
  }

  getDmPolicy(): string {
    return this.config.dmPolicy || 'pairing';
  }

  getFormatterHints() {
    return {
      supportsReactions: true,
      supportsFiles: true,
      formatHint: 'Markdown with HTML: **bold** *italic* `code` [links](url) — headers and tables supported',
    };
  }
}
