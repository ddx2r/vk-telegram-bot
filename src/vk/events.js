// src/vk/events.js — обработка ВСЕХ типов VK с уведомлениями в Telegram

const { logOutgoingMessage, logger, logError } = require('../lib/logger');
const { sendTelegramMessageWithRetry } = require('../telegram');
const {
  DEBUG_CHAT_ID,
  SERVICE_CHAT_ID,
  TELEGRAM_CHAT_ID,
  ADMIN_USER_IDS
} = require('../config');

// Куда слать уведомления по умолчанию
const TARGET_CHAT_ID =
  SERVICE_CHAT_ID || DEBUG_CHAT_ID || TELEGRAM_CHAT_ID || (Array.isArray(ADMIN_USER_IDS) ? ADMIN_USER_IDS[0] : null);

// Универсальный вход
async function handleVkEvent(type, object, ctx = {}) {
  try {
    if (!type) {
      await notify(`❓ Событие VK:\nТип: undefined\n${codeBlock(JSON.stringify(ctx.full || {}, null, 2))}`);
      logger.warn({ source: 'vk', event: 'no_type', request_id: ctx.requestId, payload: ctx.full });
      return;
    }

    // Нормализованные уведомления по популярным типам
    switch (type) {
      case 'message_new':
        await onMessageNew(object, ctx);
        break;

      case 'like_add':
        await onLikeAdd(object, ctx);
        break;

      case 'like_remove':
        await onLikeRemove(object, ctx);
        break;

      case 'wall_post_new':
        await onWallPostNew(object, ctx);
        break;

      case 'message_edit':
        await onMessageEdit(object, ctx);
        break;

      case 'message_event':
        await onMessageEvent(object, ctx);
        break;

      // сюда добавляй любые новые типы: group_join, group_leave, photo_new, comment_new и т.д.
      default:
        // По умолчанию ничего не теряем — шлём уведомление с типом и полным payload
        await notify(`❓ Событие VK:\nТип: ${type}\n${codeBlock(JSON.stringify(ctx.full || {}, null, 2))}`);
        logger.info({ source: 'vk', event: 'unhandled_type', request_id: ctx.requestId, summary: type, payload: ctx.full });
        break;
    }
  } catch (err) {
    logError('vk', type || 'unknown', err, { payload: ctx.full });
    await notify(`⚠️ Ошибка в обработке VK (${type || 'unknown'}): ${err?.message || err}`);
  }
}

module.exports = { handleVkEvent };

/* ================== HANDLERS ================== */

async function onMessageNew(obj, ctx) {
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

  await notify(
    `💬 Новое сообщение в VK\npeer_id: ${peerId}\nТекст: ${ellipsis(text, 500)}`
  );
}

async function onLikeAdd(obj, ctx) {
  const { liker_id, object_id } = obj || {};
  // Иногда структура другая:
  const typeLabel = obj?.object_type || obj?.type || guessObjectType(obj);
  const owner = obj?.object_owner_id ?? obj?.owner_id;
  const itemId = object_id ?? obj?.item_id ?? obj?.id;
  const total = obj?.likes_count ?? obj?.count ?? obj?.likes;

  const lines = [
    `❤️ Новый лайк в VK`,
    `От: ${formatUser(liker_id || obj?.user_id || obj?.from_id)}`,
    `К: объект ${typeLabel || 'unknown'} ${formatOwnerAndId(owner, itemId)}${total ? ` (Всего: ${total})` : ''}`
  ];

  logger.info({
    source: 'vk',
    event: 'like_add',
    request_id: ctx.requestId,
    summary: `like_add ${typeLabel || ''} ${itemId || ''}`,
    payload: ctx.full
  });

  await notify(lines.join('\n'));
}

async function onLikeRemove(obj, ctx) {
  const { liker_id, object_id } = obj || {};
  const typeLabel = obj?.object_type || obj?.type || guessObjectType(obj);
  const owner = obj?.object_owner_id ?? obj?.owner_id;
  const itemId = object_id ?? obj?.item_id ?? obj?.id;

  const lines = [
    `💔 Удалён лайк в VK`,
    `От: ${formatUser(liker_id || obj?.user_id || obj?.from_id)}`,
    `К: объект ${typeLabel || 'unknown'} ${formatOwnerAndId(owner, itemId)}`
  ];

  logger.info({
    source: 'vk',
    event: 'like_remove',
    request_id: ctx.requestId,
    summary: `like_remove ${typeLabel || ''} ${itemId || ''}`,
    payload: ctx.full
  });

  await notify(lines.join('\n'));
}

async function onWallPostNew(obj, ctx) {
  const postId = obj?.id;
  const owner = obj?.owner_id;
  const text = obj?.text || '';
  logger.info({
    source: 'vk',
    event: 'wall_post_new',
    request_id: ctx.requestId,
    summary: `wall_post_new id=${postId}`,
    payload: ctx.full
  });

  await notify(
    `🧱 Новый пост на стене\n${formatOwnerAndId(owner, postId)}\nТекст: ${ellipsis(text, 500)}`
  );
}

async function onMessageEdit(obj, ctx) {
  const peer = obj?.message?.peer_id;
  logger.info({
    source: 'vk',
    event: 'message_edit',
    request_id: ctx.requestId,
    summary: `message_edit peer=${peer}`,
    payload: ctx.full
  });
  await notify(`✏️ Редактирование сообщения\npeer_id: ${peer}`);
}

async function onMessageEvent(obj, ctx) {
  const evId = obj?.event_id;
  logger.info({
    source: 'vk',
    event: 'message_event',
    request_id: ctx.requestId,
    summary: `message_event id=${evId}`,
    payload: ctx.full
  });
  await notify(`⚙️ Служебное событие VK\nid: ${evId}`);
}

/* ================== UTILS ================== */

async function notify(text) {
  if (!TARGET_CHAT_ID) return;
  try {
    await sendTelegramMessageWithRetry(String(TARGET_CHAT_ID), text);
    logOutgoingMessage('telegram', String(TARGET_CHAT_ID), 'vk notify', { text });
  } catch (e) {
    logError('system', 'notify_telegram_failed', e, { summary: 'send debug to telegram failed' });
  }
}

function ellipsis(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatUser(id) {
  if (!id) return 'неизвестно';
  return `@vk.com/id${id} (id${id})`;
}

function formatOwnerAndId(owner, id) {
  const own = owner != null ? `owner=${owner}` : 'owner=?';
  const iid = id != null ? `id=${id}` : 'id=?';
  return `(${own}, ${iid})`;
}

function codeBlock(s) {
  return '```\n' + s + '\n```';
}

function guessObjectType(obj) {
  // Пытаемся угадать тип по полям
  if (obj?.photo_id || obj?.photo_owner_id) return 'photo';
  if (obj?.video_id || obj?.video_owner_id) return 'video';
  if (obj?.post_id || obj?.post_owner_id) return 'post';
  if (obj?.comment_id) return 'comment';
  return undefined;
}
