// src/vk/events.js — обработчики VK-событий с HTML-разметкой и счётчиком лайков

const axios = require('axios');
const { state, shouldDeliver } = require('../state'); // shouldDeliver может отсутствовать — см. allowDeliver()
const { sendTelegramMessageWithRetry } = require('../telegram');
const { escapeHtml, getVkUserName } = require('../utils');
const { VK_GROUP_ID, VK_SERVICE_KEY, LEAD_CHAT_ID } = require('../config');

/** Доставляем событие?
 *  true — доставляем; false — не доставляем.
 *  Если shouldDeliver отсутствует — блокируем только явно выключенные типы.
 */
function allowDeliver(type) {
  if (typeof shouldDeliver === 'function') return !!shouldDeliver(type);
  const map = (state && state.eventToggleState) ? state.eventToggleState : {};
  return !(Object.prototype.hasOwnProperty.call(map, type) && map[type] === false);
}

/** Главный чат для уведомлений */
function getMainChat() {
  return state.CURRENT_MAIN_CHAT_ID;
}

/** Человекочитаемая подпись типа объекта для лайков/ссылок */
function getObjectTypeDisplayName(type) {
  const t = String(type || '').toLowerCase();
  switch (t) {
    case 'post':            return 'посту';
    case 'comment':         return 'комментарию';
    case 'photo':           return 'фотографии';
    case 'video':           return 'видео';
    case 'note':            return 'заметке';
    case 'photo_comment':   return 'комментарию к фото';
    case 'video_comment':   return 'комментарию к видео';
    case 'topic_comment':   return 'комментарию в обсуждении';
    case 'market':          return 'товару';
    case 'market_comment':  return 'комментарию к товару';
    case 'topic':           return 'обсуждению';
    // редкие/новые
    case 'clip':            return 'клипу';
    case 'story':           return 'истории';
    case 'article':         return 'статье';
    case 'sitepage':        return 'странице';
    case 'app':             return 'приложению';
    case 'podcast':         return 'подкасту';
    default:                return String(type || 'объекту');
  }
}

/** Кликабельная ссылка на объект, если это возможно (иначе null) */
function buildObjectLink(ownerId, objectType, objectId, postId) {
  const t = String(objectType || '').toLowerCase();
  const ownAbs = String(ownerId || '').replace(/^-/, ''); // URL всегда без минуса
  switch (t) {
    case 'post':
      return `https://vk.com/wall-${ownAbs}_${objectId}`;
    case 'comment':
      return postId ? `https://vk.com/wall-${ownAbs}_${postId}?reply=${objectId}` : null;
    case 'photo':
      return `https://vk.com/photo-${ownAbs}_${objectId}`;
    case 'video':
      return `https://vk.com/video-${ownAbs}_${objectId}`;
    case 'market':
      return `https://vk.com/market-${ownAbs}?w=product-${ownAbs}_${objectId}`;
    case 'topic':
      return `https://vk.com/topic-${ownAbs}_${postId || objectId}`;
    case 'photo_comment':
      return `https://vk.com/photo-${ownAbs}_${postId || objectId}?reply=${objectId}`;
    case 'video_comment':
      return `https://vk.com/video-${ownAbs}_${postId || objectId}?reply=${objectId}`;
    case 'topic_comment':
      return `https://vk.com/topic-${ownAbs}_${postId || objectId}?reply=${objectId}`;
    case 'market_comment':
      return `https://vk.com/market-${ownAbs}?w=product-${ownAbs}_${postId || objectId}`;
    default:
      return null; // clip/story/article/sitepage/app/podcast — прямой ссылки обычно нет
  }
}

/** Преобразование типов к допустимым для likes.getList */
function toLikesApiType(objectType) {
  const t = String(objectType || '').toLowerCase();
  // Допустимые типы: post, comment, photo, video, note, photo_comment, video_comment, topic_comment, market, market_comment, sitepage
  switch (t) {
    case 'post':
    case 'comment':
    case 'photo':
    case 'video':
    case 'note':
    case 'photo_comment':
    case 'video_comment':
    case 'topic_comment':
    case 'market':
    case 'market_comment':
    case 'sitepage':
      return t;
    // часто приходят as-is — остальные считаем неподдерживаемыми
    default:
      return null;
  }
}

/** Безопасно получаем текущее количество лайков через VK API (service key) */
async function tryGetLikesCount(ownerId, objectId, objectType) {
  const type = toLikesApiType(objectType);
  if (!type) return null; // для неподдерживаемых типов не запрашиваем
  if (!VK_SERVICE_KEY) return null;

  // likes.getList — быстрый способ получить count
  const params = {
    access_token: VK_SERVICE_KEY,
    v: '5.199',
    type,
    owner_id: ownerId,
    item_id: objectId,
    count: 0 // нам нужен только count
  };

  try {
    const { data } = await axios.get('https://api.vk.com/method/likes.getList', { params, timeout: 3000 });
    if (data && data.response && typeof data.response.count === 'number') {
      return data.response.count;
    }
  } catch (_) {
    // молча игнорируем — просто не покажем (Всего: N)
  }
  return null;
}

/** Короткий помощник для уведомлений */
async function notifyMAIN(html) {
  const MAIN = getMainChat();
  if (!MAIN || !html) return;
  await sendTelegramMessageWithRetry(MAIN, html, { parse_mode: 'HTML' });
}

/** Основной обработчик */
async function handleVkEvent({ type, object }) {
  // уважаем тумблеры
  if (!allowDeliver(type)) return;

  let msg = '';

  switch (type) {
    // ---------------- Сообщения ----------------
    case 'message_new': {
      const m = object.message || object;
      const user = await getVkUserName(m.from_id);
      msg = `💬 <b>Новое сообщение:</b>\n<b>От:</b> <a href="https://vk.com/id${m.from_id}">${user}</a>\n` +
            (m.text ? `<b>Текст:</b> <i>${escapeHtml(m.text)}</i>` : '<i>(без текста)</i>');
      break;
    }

    case 'message_reply': {
      const r = object;
      // твой проект фильтрует некоторые служебные ответы — оставь как было, либо убери строку ниже
      if (r?.text?.includes('Новая заявка по форме')) break;
      const user = await getVkUserName(r.from_id);
      msg = `↩️ <b>Ответ в сообщениях:</b>\n<b>От:</b> <a href="https://vk.com/id${r.from_id}">${user}</a>\n` +
            `<b>Сообщение:</b>\n<i>${escapeHtml(r.text || '')}</i>`;
      break;
    }

    case 'message_allow': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      msg = `✅ <b>Пользователь разрешил сообщения:</b>\n<a href="https://vk.com/id${ev.user_id}">${user}</a>`;
      break;
    }

    case 'message_deny': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      msg = `⛔️ <b>Пользователь запретил сообщения:</b>\n<a href="https://vk.com/id${ev.user_id}">${user}</a>`;
      break;
    }

    // ---------------- Лайки ----------------
    case 'like_add':
    case 'like_remove': {
      const ev = object;

      // У VK owner_id в лайках бывает пустым — подставим ID сообщества
      let ownerId = ev.owner_id;
      if (!ownerId) ownerId = -Number(VK_GROUP_ID);

      const typeText = getObjectTypeDisplayName(ev.object_type);

      // Имя лайкнувшего
      let liker = `ID ${ev.liker_id}`;
      try {
        const name = await getVkUserName(ev.liker_id);
        if (name) liker = name;
      } catch {}

      // Ссылка на объект (если возможно)
      const link = buildObjectLink(ownerId, ev.object_type, ev.object_id, ev.post_id);

      // Счётчик лайков — только для поддерживаемых типов
      let total = null;
      try {
        total = await tryGetLikesCount(ownerId, ev.object_id, ev.object_type);
      } catch {}

      msg  = `<b>${type === 'like_add' ? '❤️ Новый лайк в VK' : '💔 Лайк удалён в VK'}</b>\n`;
      msg += `<b>От:</b> <a href="https://vk.com/id${ev.liker_id}">${liker}</a>\n`;
      msg += `<b>${type === 'like_add' ? 'К' : 'С'}:</b> `;

      if (link) {
        msg += `<a href="${link}">${typeText}</a>`;
      } else {
        msg += `${typeText} ID <code>${ev.object_id}</code>`;
      }

      if (typeof total === 'number') {
        msg += ` (Всего: ${total})`;
      }
      break;
    }

    // ---------------- Стена ----------------
    case 'wall_post_new': {
      const p = object;
      const author = await getVkUserName(p.from_id || p.owner_id);
      const link = `https://vk.com/wall${p.owner_id}_${p.id}`;
      msg = `🧱 <b>Новый пост на стене</b>\n<b>Автор:</b> <a href="https://vk.com/id${p.from_id || p.owner_id}">${author}</a>\n` +
            `<a href="${link}">Открыть пост</a>`;
      if (p.text) msg += `\n<i>${escapeHtml(p.text.slice(0, 700))}</i>`;
      break;
    }

    // ---------------- Вступления/выходы ----------------
    case 'group_join': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      const kind = String(ev.join_type || '').toLowerCase();
      const kindLabel = ({
        approved: 'заявка одобрена',
        request: 'подан запрос на вступление',
        accepted: 'вступил(а)',
        joined: 'вступил(а)'
      })[kind] || 'вступил(а)';
      msg = `🟢 <b>${escapeHtml(kindLabel)} в сообщество</b>\n<a href="https://vk.com/id${ev.user_id}">${user}</a>`;
      break;
    }

    case 'group_leave': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      const admin = ev.admin_id ? await getVkUserName(ev.admin_id) : null;
      const by = ev.self ? 'самостоятельно' : (admin ? `модератором <a href="https://vk.com/id${ev.admin_id}">${admin}</a>` : '—');
      msg = `🔴 <b>Покинул(а) сообщество</b>\n<a href="https://vk.com/id${ev.user_id}">${user}</a>\n<b>Причина:</b> ${escapeHtml(by)}`;
      // в некоторых проектах выходы шлют в отдельный чат лидов — если нужно, раскомментируй:
      // if (LEAD_CHAT_ID) { await sendTelegramMessageWithRetry(LEAD_CHAT_ID, msg, { parse_mode: 'HTML' }); msg = ''; }
      break;
    }

    // ---------------- Комментарии ----------------
    case 'photo_comment_new': {
      const c = object;
      const author = await getVkUserName(c.from_id);
      msg = `🖼️ <b>Новый комментарий к фото</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${author}</a>\n<b>Текст:</b> <i>${escapeHtml(c.text || '')}</i>`;
      break;
    }
    case 'video_comment_new': {
      const c = object;
      const author = await getVkUserName(c.from_id);
      msg = `🎬 <b>Новый комментарий к видео</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${author}</a>\n<b>Текст:</b> <i>${escapeHtml(c.text || '')}</i>`;
      break;
    }
    case 'market_comment_new': {
      const c = object;
      const author = await getVkUserName(c.from_id);
      msg = `🛒 <b>Комментарий к товару</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${author}</a>\n<b>Текст:</b> <i>${escapeHtml(c.text || '')}</i>`;
      break;
    }
    case 'topic_comment_new': {
      const c = object;
      const author = await getVkUserName(c.from_id);
      msg = `🗂️ <b>Комментарий в обсуждении</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${author}</a>\n<b>Текст:</b> <i>${escapeHtml(c.text || '')}</i>`;
      break;
    }

    // ---------------- По умолчанию — ничего не теряем ----------------
    default: {
      // красивый дамп, чтобы видеть все редкие поля; безопасим HTML
      msg = `❓ <b>Событие VK:</b>\nТип: <code>${escapeHtml(type)}</code>\n<pre>${escapeHtml(JSON.stringify(object, null, 2))}</pre>`;
      break;
    }
  }

  if (msg) {
    await notifyMAIN(msg);
  }
}

module.exports = { handleVkEvent };
