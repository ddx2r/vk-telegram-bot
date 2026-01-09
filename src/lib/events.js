// src/lib/events.js
import pino from 'pino';
import { logEventFirestore } from '../storage/firebase.js';
import { logEventSql } from '../storage/supabase.js';
import { seenOnce, incrCounter } from '../storage/redis.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Проверка дубля поста (VK owner_id + post_id)
 * @returns {Promise<boolean>} true => это дубль и его надо пропустить
 */
export async function isDuplicateVkPost(ownerId, postId) {
  const key = `vk:${ownerId}:${postId}`;
  const duplicate = await seenOnce(key);
  if (duplicate) {
    log.info({ ownerId, postId }, 'Обнаружен дубль — пропуск');
    // логируем факт дубля
    await Promise.allSettled([
      logEventFirestore({ type: 'duplicate_skip', vk_owner_id: ownerId, vk_post_id: postId, status: 'skip' }),
      logEventSql({ type: 'duplicate_skip', vk_owner_id: ownerId, vk_post_id: postId, status: 'skip' })
    ]);
  }
  return duplicate;
}

/** Успешная публикация */
export async function logPosted({ ownerId, postId, chatId, messageId, hasMedia }) {
  await Promise.allSettled([
    logEventFirestore({
      type: 'posted',
      vk_owner_id: ownerId,
      vk_post_id: postId,
      tg_chat_id: chatId,
      tg_message_id: messageId,
      status: 'ok',
      meta: { hasMedia: !!hasMedia }
    }),
    logEventSql({
      type: 'posted',
      vk_owner_id: ownerId,
      vk_post_id: postId,
      tg_chat_id: chatId,
      tg_message_id: messageId,
      status: 'ok',
      meta: { hasMedia: !!hasMedia }
    }),
    incrCounter('posted_total')
  ]);
}

/** Ошибка отправки */
export async function logError({ ownerId, postId, stage, error }) {
  await Promise.allSettled([
    logEventFirestore({
      type: 'error',
      vk_owner_id: ownerId,
      vk_post_id: postId,
      status: stage || 'unknown',
      meta: { message: String(error?.message || error), stack: error?.stack }
    }),
    logEventSql({
      type: 'error',
      vk_owner_id: ownerId,
      vk_post_id: postId,
      status: stage || 'unknown',
      meta: { message: String(error?.message || error), stack: error?.stack }
    }),
    incrCounter('errors_total')
  ]);
  log.error({ ownerId, postId, stage, err: String(error) }, 'Ошибка отправки');
}
