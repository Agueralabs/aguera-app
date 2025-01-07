import { z } from 'zod';

import { ActionResponse, actionClient } from '@/lib/safe-action';
import {
  dbGetUserTelegramId,
  dbUpdateUserTelegramId,
} from '@/server/db/queries';

import { verifyUser } from './user';

export const MISSING_USERNAME_ERROR = 'No saved Telegram username found';
export const BOT_NOT_STARTED_ERROR = 'Bot not started yet';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const GET_BOT_INFO_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`;
const GET_UPDATES_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
const SEND_MESSAGE_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

interface CheckUserSetupResult {
  success: boolean;
  error?: string;
  userId?: string;
  username?: string;
  chatId?: string;
  botId?: string;
}

interface TelegramActionData {
  success: boolean;
  error?: string;
  botId?: string;
  username?: string;
}

const getBotUsername = async (): Promise<string> => {
  const response = await fetch(GET_BOT_INFO_URL);
  if (!response.ok) throw new Error('Failed to retrieve bot info');
  const data = await response.json();
  return data.result.username;
};

const getChatIdByUsername = async (
  username: string,
): Promise<string | null> => {
  const response = await fetch(GET_UPDATES_URL);
  if (!response.ok) throw new Error('Failed to retrieve bot updates');
  const data = await response.json();
  const chat = data.result.find(
    (msg: any) => msg?.message?.from?.username === username,
  );
  return chat ? chat.message.chat.id : null;
};

const sendTelegramMessage = async (chatId: string, text: string) => {
  const response = await fetch(SEND_MESSAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error('Failed to send Telegram message');
};

/**
 * Verifies that the current user is logged in, retrieves (or uses) a Telegram username,
 * confirms the user has started the bot, and updates the DB if needed.
 */
export async function checkUserTelegramSetup(
  username?: string,
): Promise<CheckUserSetupResult> {
  const authResult = await verifyUser();
  const userId = authResult?.data?.data?.id;
  if (!userId) return { success: false, error: 'UNAUTHORIZED' };

  const botId = TELEGRAM_BOT_USERNAME ?? (await getBotUsername());
  const dbUsername = await dbGetUserTelegramId({ userId });
  const finalUsername = username || dbUsername;

  if (!finalUsername) {
    return { success: false, error: MISSING_USERNAME_ERROR, userId, botId };
  }

  const sanitizedUsername = finalUsername.replaceAll('@', '');
  const chatId = await getChatIdByUsername(sanitizedUsername);
  if (!chatId) {
    return { success: false, error: BOT_NOT_STARTED_ERROR, userId, botId };
  }

  // Update DB if the username is not already stored or is outdated
  if (!dbUsername || dbUsername !== sanitizedUsername) {
    await dbUpdateUserTelegramId({ userId, telegramId: sanitizedUsername });
  }

  return { success: true, userId, username: sanitizedUsername, chatId, botId };
}

export const verifyTelegramSetupAction = actionClient
  .schema(z.object({ username: z.string().optional() }))
  .action<ActionResponse<TelegramActionData>>(async ({ parsedInput }) => {
    try {
      const setup = await checkUserTelegramSetup(parsedInput.username);
      if (!setup.success) {
        return {
          success: false,
          error: setup.error,
          data: { success: false, error: setup.error, botId: setup.botId },
        };
      }
      return { success: true, data: { success: true } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed';
      return {
        success: false,
        error: msg,
        data: { success: false, error: msg },
      };
    }
  });

export const sendTelegramNotification = actionClient
  .schema(z.object({ username: z.string().optional(), text: z.string() }))
  .action<ActionResponse<TelegramActionData>>(async ({ parsedInput }) => {
    if (!TELEGRAM_BOT_TOKEN) {
      return {
        success: false,
        error: 'Telegram bot token not set',
        data: { success: false },
      };
    }
    try {
      const setup = await checkUserTelegramSetup(parsedInput.username);
      if (!setup.success) {
        return {
          success: false,
          error: setup.error,
          data: {
            success: false,
            error: setup.error,
            botId: setup.botId,
          },
        };
      }
      await sendTelegramMessage(setup.chatId!, parsedInput.text);
      return { success: true, data: { success: true, botId: setup.botId } };
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to send notification';
      return {
        success: false,
        error: msg,
        data: { success: false, error: msg },
      };
    }
  });

export const checkTelegramUsername = async (): Promise<TelegramActionData> => {
  const authResult = await verifyUser();
  const userId = authResult?.data?.data?.id;
  if (!userId) return { success: false, error: 'UNAUTHORIZED' };

  const username = await dbGetUserTelegramId({ userId });
  if (!username) {
    return { success: false, error: MISSING_USERNAME_ERROR };
  }
  return { success: true, username };
};
