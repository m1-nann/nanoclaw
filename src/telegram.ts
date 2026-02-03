/**
 * Telegram Bot Integration for NanoClaw
 * Uses grammY framework with long-polling for message handling
 */

import { Bot, Context } from 'grammy';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

import {
  TELEGRAM_BOT_TOKEN,
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
  DATA_DIR,
  TIMEZONE
} from './config.ts';
import { RegisteredGroup, NewMessage } from './types.ts';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let bot: Bot | null = null;

// Pending pairing requests: code -> { jid, chatTitle, chatId, expiresAt }
interface PendingPairing {
  jid: string;
  chatId: number;
  chatTitle: string;
  expiresAt: number;
}
const pendingPairings = new Map<string, PendingPairing>();

// Code expiry: 1 hour
const PAIRING_CODE_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Generate a 6-digit pairing code
 */
function generatePairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Clean up expired pairing codes
 */
function cleanupExpiredPairings(): void {
  const now = Date.now();
  for (const [code, pairing] of pendingPairings) {
    if (pairing.expiresAt < now) {
      pendingPairings.delete(code);
    }
  }
}

/**
 * Verify a pairing code and register the chat
 * Returns the chat info if successful, null if code is invalid/expired
 */
export function verifyPairingCode(code: string): { jid: string; name: string; folder: string } | null {
  if (!deps) return null;

  cleanupExpiredPairings();
  const pairing = pendingPairings.get(code);

  if (!pairing) {
    return null;
  }

  // Check if already registered
  const registeredGroups = deps.getRegisteredGroups();
  if (registeredGroups[pairing.jid]) {
    pendingPairings.delete(code);
    return null;
  }

  // Generate folder name
  const folder = `tg-${pairing.chatTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`;

  // Register the group
  deps.registerGroup(pairing.jid, {
    name: pairing.chatTitle,
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString()
  });

  // Send confirmation to the Telegram chat
  if (bot) {
    bot.api.sendMessage(
      pairing.chatId,
      `Verified! This chat is now connected.\n\n` +
      `Send a message starting with @${ASSISTANT_NAME} to chat with the assistant.`
    ).catch(err => logger.error({ err }, 'Failed to send verification confirmation'));
  }

  pendingPairings.delete(code);
  logger.info({ jid: pairing.jid, name: pairing.chatTitle, folder }, 'Telegram chat registered via pairing code');

  return { jid: pairing.jid, name: pairing.chatTitle, folder };
}

/**
 * Get pending pairing info (for agent to check)
 */
export function getPendingPairings(): Array<{ code: string; chatTitle: string; expiresIn: number }> {
  cleanupExpiredPairings();
  const now = Date.now();
  return Array.from(pendingPairings.entries()).map(([code, p]) => ({
    code,
    chatTitle: p.chatTitle,
    expiresIn: Math.round((p.expiresAt - now) / 1000 / 60) // minutes
  }));
}

export interface TelegramDependencies {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getMessagesSince: (chatJid: string, sinceTimestamp: string, botPrefix: string) => NewMessage[];
  storeGenericMessage: (msg: NewMessage) => void;
  runAgent: (group: RegisteredGroup, prompt: string, chatJid: string) => Promise<string | null>;
  getLastAgentTimestamp: () => Record<string, string>;
  setLastAgentTimestamp: (jid: string, timestamp: string) => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

let deps: TelegramDependencies | null = null;

/**
 * Convert Telegram chat ID to JID format for consistency
 */
function chatIdToJid(chatId: number): string {
  return `telegram:${chatId}`;
}

/**
 * Extract chat ID from JID
 */
function jidToChatId(jid: string): number | null {
  if (!jid.startsWith('telegram:')) return null;
  return parseInt(jid.replace('telegram:', ''), 10);
}

/**
 * Send a message to a Telegram chat
 */
export async function sendTelegramMessage(jid: string, text: string): Promise<void> {
  if (!bot) {
    logger.warn('Telegram bot not initialized');
    return;
  }

  const chatId = jidToChatId(jid);
  if (!chatId) {
    logger.warn({ jid }, 'Invalid Telegram JID');
    return;
  }

  try {
    // Split long messages (Telegram limit is 4096 characters)
    const maxLength = 4000;
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (newline or space)
      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trim();
    }

    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk);
    }

    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Telegram message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Telegram message');
  }
}

/**
 * Set typing indicator
 */
export async function setTelegramTyping(jid: string, isTyping: boolean): Promise<void> {
  if (!bot || !isTyping) return;

  const chatId = jidToChatId(jid);
  if (!chatId) return;

  try {
    await bot.api.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to set typing status');
  }
}

/**
 * Process incoming Telegram message
 */
async function processMessage(ctx: Context): Promise<void> {
  if (!deps) return;
  if (!ctx.message?.text) return;

  const chatId = ctx.chat?.id;
  const senderId = ctx.from?.id;
  const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
  const text = ctx.message.text;
  const timestamp = new Date(ctx.message.date * 1000).toISOString();

  if (!chatId || !senderId) return;

  const jid = chatIdToJid(chatId);
  const registeredGroups = deps.getRegisteredGroups();
  const group = registeredGroups[jid];

  if (!group) {
    logger.info({ jid, chatId, senderName, text: text.slice(0, 50) }, 'Message from unregistered Telegram chat - register with this JID');
    return;
  }

  // Store the message
  const msg: NewMessage = {
    id: `telegram:${ctx.message.message_id}`,
    chat_jid: jid,
    sender: `telegram:${senderId}`,
    sender_name: senderName,
    content: text,
    timestamp
  };
  deps.storeGenericMessage(msg);

  // Check trigger pattern (main group responds to all, others need trigger)
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  if (!isMainGroup && !TRIGGER_PATTERN.test(text)) {
    return;
  }

  // Get conversation context
  const lastAgentTimestamp = deps.getLastAgentTimestamp();
  const sinceTimestamp = lastAgentTimestamp[jid] || '';
  const missedMessages = deps.getMessagesSince(jid, sinceTimestamp, ASSISTANT_NAME);

  // Build prompt
  const lines = missedMessages.map(m => {
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const localTime = new Date(m.timestamp).toLocaleString('en-US', {
      timeZone: TIMEZONE,
      dateStyle: 'medium',
      timeStyle: 'short'
    });
    return `<message sender="${escapeXml(m.sender_name)}" time="${localTime}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing Telegram message');

  // Set typing and run agent
  await setTelegramTyping(jid, true);
  const response = await deps.runAgent(group, prompt, jid);

  if (response) {
    deps.setLastAgentTimestamp(jid, timestamp);
    await sendTelegramMessage(jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

/**
 * Initialize and start the Telegram bot
 */
export async function startTelegramBot(dependencies: TelegramDependencies): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.info('Telegram bot token not configured, skipping');
    return;
  }

  deps = dependencies;
  bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Handle /start and /register commands - generate pairing code
  bot.command(['start', 'register'], async (ctx) => {
    const chatId = ctx.chat?.id;
    const chatTitle = ctx.chat?.type === 'private'
      ? ctx.from?.first_name || ctx.from?.username || 'Telegram DM'
      : (ctx.chat as any)?.title || 'Telegram Group';

    if (!chatId) return;

    const jid = chatIdToJid(chatId);
    const registeredGroups = deps!.getRegisteredGroups();

    // Already registered
    if (registeredGroups[jid]) {
      await ctx.reply(
        `This chat is already registered as "${registeredGroups[jid].name}".\n\n` +
        `Send a message starting with @${ASSISTANT_NAME} to chat with the assistant.`
      );
      return;
    }

    // Check for existing pending pairing
    cleanupExpiredPairings();
    for (const [code, pairing] of pendingPairings) {
      if (pairing.jid === jid) {
        const expiresIn = Math.round((pairing.expiresAt - Date.now()) / 1000 / 60);
        await ctx.reply(
          `You already have a pending pairing code:\n\n` +
          `**${code}**\n\n` +
          `Tell this code to ${ASSISTANT_NAME} via WhatsApp to verify.\n` +
          `Expires in ${expiresIn} minutes.`
        );
        return;
      }
    }

    // Generate new pairing code
    const code = generatePairingCode();
    pendingPairings.set(code, {
      jid,
      chatId,
      chatTitle,
      expiresAt: Date.now() + PAIRING_CODE_EXPIRY_MS
    });

    await ctx.reply(
      `To connect this chat, tell ${ASSISTANT_NAME} via WhatsApp:\n\n` +
      `"Verify Telegram code ${code}"\n\n` +
      `This code expires in 60 minutes.`
    );

    logger.info({ jid, chatTitle, code }, 'Telegram pairing code generated');
  });

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    try {
      await processMessage(ctx);
    } catch (err) {
      logger.error({ err }, 'Error processing Telegram message');
    }
  });

  // Handle errors
  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

  // Start long-polling
  try {
    const me = await bot.api.getMe();
    logger.info({ username: me.username, id: me.id }, 'Telegram bot connected');

    // Start polling (non-blocking)
    bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username }, 'Telegram bot polling started');
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start Telegram bot');
    bot = null;
  }
}

/**
 * Stop the Telegram bot
 */
export async function stopTelegramBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}

/**
 * Check if Telegram bot is running
 */
export function isTelegramRunning(): boolean {
  return bot !== null;
}

/**
 * Get bot info
 */
export async function getTelegramBotInfo(): Promise<{ username: string; id: number } | null> {
  if (!bot) return null;
  try {
    const me = await bot.api.getMe();
    return { username: me.username || '', id: me.id };
  } catch {
    return null;
  }
}
