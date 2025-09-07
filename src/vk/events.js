// src/vk/events.js — универсальная маршрутизация всех типов VK Callback API
// Ничего не теряем: неизвестные типы логируем и пропускаем дальше как "ok".

const { logOutgoingMessage, logger, logError } = require('../lib/logger');
const { sendTelegramMessageWithRetry } = require('../telegram');
const { DEBUG_CHAT_ID } = require('../config');

// Хендлеры по типам (добавляй свои конкретные реализации ниже)
const handlers = {
  // новые сообщения
  async message_new(obj, ctx) {
    // obj.message.*, obj.client_info
    const text = obj?.message?.text || '';
    const peerId = String(obj?.message?.peer_id || '');
    logger.debug({
      source: 'vk',
      event: 'message_new',
      request_id: ctx.requestId,
      chat_id: peerId,
      summary: text.slice(0, 256),
      payload: ctx.full
    });

    // пример ответа/действия — тут вызывай свой текущий код обработчика сообщений
    // await vkApi.messages.send({...})

    // при необходимости уведомим debug-чат
    if (DEBUG_CHAT_ID) {
      await safeNotify(`❕VK message_new\npeer_id: ${peerId}\ntext: ${ellipsis(text, 300)}`);
    }
  },

  // новые посты на стене
  async wall_post_new(obj, ctx) {
    const postId = obj?.id;
    logger.info({
      source: 'vk',
      event: 'wall_post_new',
      request_id: ctx.requestId,
      summary: `wall_post_new id=${postId}`,
      payload: ctx.full
    });
  },

  // лайки/репосты/комменты и прочее
  async like_add(obj, ctx) {
    logger.info({
      source: 'vk',
      event: 'like_add',
      request_id: ctx.requestId,
      summary: `like_add ${obj?.type} ${obj?.item_id}`,
      payload: ctx.full
    });
  },

  async like_remove(obj, ctx) {
    logger.info({
      source: 'vk',
      event: 'like_remove',
      request_id: ctx.requestId,
      summary: `like_remove ${obj?.type} ${obj?.item_id}`,
      payload: ctx.full
    });
  },

  async message_edit(obj, ctx) {
    logger.info({
      source: 'vk',
      event: 'message_edit',
      request_id: ctx.requestId,
      summary: `message_edit peer=${obj?.message?.peer_id}`,
      payload: ctx.full
    });
  },

  async message_event(obj, ctx) {
    logger.info({
      source: 'vk',
      event: 'message_event',
      request_id: ctx.requestId,
      summary: `message_event id=${obj?.event_id}`,
      payload: ctx.full
    });
  },

  // добавь любые нужные типы: group_join, group_leave, photo_new, audio_new и т.д.
  // см. https://dev.vk.com/ru/api/community-events/json-schema
};

// Универсальный вход
async function handleVkEvent(type, object, ctx = {}) {
  try {
    if (!type) {
      // на всякий случай — это и была твоя ситуация "Тип: undefined"
      logger.warn({
        source: 'vk',
        event: 'no_type',
        request_id: ctx.requestId,
        summary: 'VK event without type',
        payload: ctx.full
      });
      await debugUndefined(ctx.full);
      return;
    }

    const handler = handlers[type];
    if (handler) {
      await handler(object, ctx);
    } else {
      // Неизвестный/пока не реализованный тип — логируем и уведомляем, чтобы ничего не терять
      logger.info({
        source: 'vk',
        event: 'unhandled_type',
        request_id: ctx.requestId,
        summary: `unhandled VK type: ${type}`,
        payload: ctx.full
      });
      await safeNotify(`❓ Событие VK:\nТип: ${type}\n${codeBlock(JSON.stringify(ctx.full || {}, null, 2))}`);
    }
  } catch (err) {
    logError('vk', type || 'unknown', err, { payload: ctx.full });
    await safeNotify(`⚠️ Ошибка в обработке VK (${type || 'unknown'}): ${err?.message || err}`);
  }
}

module.exports = { handleVkEvent };

/* ----------------- utils ----------------- */

async function safeNotify(text) {
  try {
    if (DEBUG_CHAT_ID) {
      await sendTelegramMessageWithRetry(DEBUG_CHAT_ID, text);
      logOutgoingMessage('telegram', String(DEBUG_CHAT_ID), 'debug notify (vk)', { text });
    }
  } catch (e) {
    logError('system', 'debug_notify', e, { summary: 'send debug to telegram failed' });
  }
}

async function debugUndefined(full) {
  await safeNotify(`❓ Событие VK:\nТип: undefined\n${codeBlock(JSON.stringify(full || {}, null, 2))}`);
}

function ellipsis(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function codeBlock(s) {
  return '```\n' + s + '\n```';
}
