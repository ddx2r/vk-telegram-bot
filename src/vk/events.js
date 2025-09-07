// src/vk/events.js — обработчики VK-событий (уведомления о "всех" событиях)

const axios = require('axios');
const { state, shouldDeliver } = require('../state');
const { sendTelegramMessageWithRetry } = require('../telegram');
const { escapeHtml, getVkUserName } = require('../utils');
const { VK_GROUP_ID, VK_SERVICE_KEY, LEAD_CHAT_ID } = require('../config');

// -------- Человекочитаемые названия типов --------
function getObjectTypeDisplayName(type) {
  const t = String(type || '').toLowerCase();

  switch (t) {
    // Базовые
    case 'post':            return 'посту';
    case 'comment':         return 'комментарию';
    case 'photo':           return 'фотографии';
    case 'video':           return 'видео';
    case 'audio':           return 'аудиозаписи';
    case 'note':            return 'заметке';
    case 'market':          return 'товару';
    case 'topic':           return 'обсуждению';

    // Комментарии к сущностям
    case 'photo_comment':   return 'комментарию к фото';
    case 'video_comment':   return 'комментарию к видео';
    case 'topic_comment':   return 'комментарию в обсуждении';
    case 'market_comment':  return 'комментарию к товару';

    // Новые/редкие типы
    case 'clip':            return 'клипу';
    case 'story':           return 'истории';
    case 'podcast':         return 'подкасту';
    case 'article':         return 'статье';
    case 'album':           return 'альбому';
    case 'market_album':    return 'разделу товаров';
    case 'sitepage':        return 'странице сайта';
    case 'app':             return 'приложению';
    case 'poll':            return 'опросу';
    case 'event':           return 'событию';

    default:
      return `объекту типа <code>${escapeHtml(String(type))}</code>`;
  }
}

// -------- Построение ссылок --------
function getObjectLinkForLike(ownerId, objectType, objectId, postId, extras = {}) {
  const t = String(objectType || '').toLowerCase();

  // Комментарий к посту, если известен postId
  if (t === 'comment' && postId) {
    return `https://vk.com/wall${ownerId}_${postId}?reply=${objectId}`;
  }

  switch (t) {
    case 'post':
      return `https://vk.com/wall${ownerId}_${objectId}`;

    case 'photo':
      return `https://vk.com/photo${ownerId}_${objectId}`;

    case 'video':
      return `https://vk.com/video${ownerId}_${objectId}`;

    case 'audio':
      return `https://vk.com/audio?z=audio${ownerId}_${objectId}`;

    case 'note':
      return `https://vk.com/note${ownerId}_${objectId}`;

    case 'market':
      return `https://vk.com/market-${ownerId}?w=product-${ownerId}_${objectId}`;

    case 'topic':
      if (String(ownerId).startsWith('-')) {
        return `https://vk.com/topic${ownerId}_${objectId}`;
      }
      return null;

    case 'photo_comment': {
      const { parent_photo_id } = extras || {};
      if (parent_photo_id) return `https://vk.com/photo${ownerId}_${parent_photo_id}?reply=${objectId}`;
      return null;
    }
    case 'video_comment': {
      const { parent_video_id } = extras || {};
      if (parent_video_id) return `https://vk.com/video${ownerId}_${parent_video_id}?reply=${objectId}`;
      return null;
    }
    case 'topic_comment': {
      const { parent_topic_id } = extras || {};
      if (String(ownerId).startsWith('-') && parent_topic_id) {
        return `https://vk.com/topic${ownerId}_${parent_topic_id}?post=${objectId}`;
      }
      return null;
    }
    case 'market_comment': {
      const { parent_item_id } = extras || {};
      if (parent_item_id) {
        return `https://vk.com/market-${ownerId}?w=product-${ownerId}_${parent_item_id}/comment${objectId}`;
      }
      return null;
    }

    case 'clip':
      return `https://vk.com/clip${ownerId}_${objectId}`;

    case 'story':
      // Нет стабильного URL на конкретную историю
      return `https://vk.com/id${String(ownerId).replace('-', '')}`;

    case 'podcast':
      if (String(ownerId).startsWith('-')) {
        return `https://vk.com/podcasts-${String(ownerId).replace('-', '')}`;
      }
      return null;

    case 'article':
      return null;

    case 'album':
      return `https://vk.com/album${ownerId}_${objectId}`;

    case 'market_album':
      return `https://vk.com/market-${ownerId}?section=${objectId}`;

    case 'sitepage':
      return null;

    case 'app':
      return `https://vk.com/app${objectId}`;

    case 'poll':
      return null;

    case 'event':
      return `https://vk.com/event${String(ownerId).replace('-', '')}`;

    default:
      return null;
  }
}

// Короткая сводка вложений (без прямой отправки бинарей)
function summarizeAttachments(attachments = []) {
  if (!attachments || !attachments.length) return '';
  const lines = ['\n\n<b>Вложения:</b>'];
  for (const a of attachments) {
    switch (a.type) {
      case 'photo': {
        const url = a.photo?.sizes?.slice(-1)?.[0]?.url;
        lines.push(`📸 Фото${url ? ` — <a href="${url}">ссылка</a>` : ''}`);
        break;
      }
      case 'video': {
        const v = a.video;
        const link = v?.owner_id && v?.id ? `https://vk.com/video${v.owner_id}_${v.id}` : (v?.player || null);
        lines.push(`🎥 Видео — ${link ? `<a href="${link}">${escapeHtml(v?.title || 'ссылка')}</a>` : 'без ссылки'}`);
        break;
      }
      case 'audio': {
        const au = a.audio;
        lines.push(`🎵 Аудио — ${escapeHtml(au?.artist || '—')} — ${escapeHtml(au?.title || '—')}${au?.url ? ` (<a href="${au.url}">ссылка</a>)` : ''}`);
        break;
      }
      case 'doc': {
        const d = a.doc;
        lines.push(`📄 Документ — ${escapeHtml(d?.title || '—')}${d?.url ? ` (<a href="${d.url}">скачать</a>)` : ''}`);
        break;
      }
      case 'link': {
        const l = a.link;
        lines.push(`🔗 Ссылка — <a href="${l?.url}">${escapeHtml(l?.title || l?.url || '—')}</a>`);
        break;
      }
      case 'sticker': {
        const s = a.sticker;
        const url = s?.images_with_background?.slice(-1)?.[0]?.url || s?.images?.slice(-1)?.[0]?.url;
        lines.push(`🖼️ Стикер${url ? ` — <a href="${url}">ссылка</a>` : ''}`);
        break;
      }
      case 'graffiti': {
        const g = a.graffiti;
        lines.push(`🎨 Граффити${g?.url ? ` — <a href="${g.url}">ссылка</a>` : ''}`);
        break;
      }
      case 'poll': {
        lines.push(`📊 Опрос`);
        break;
      }
      case 'wall': {
        const w = a.wall;
        if (w?.owner_id && w?.id) lines.push(`📝 Вложенный пост — <a href="https://vk.com/wall${w.owner_id}_${w.id}">ссылка</a>`);
        break;
      }
      default:
        lines.push(`❓ Вложение: ${escapeHtml(a.type)}`);
    }
  }
  return lines.join('\n');
}

// Счётчик лайков (где API поддерживает)
async function tryGetLikesCount(ownerId, itemId, type) {
  try {
    const r = await axios.get('https://api.vk.com/method/likes.getList', {
      params: { type, owner_id: ownerId, item_id: itemId, access_token: VK_SERVICE_KEY, v: '5.131' },
      timeout: 5000
    });
    return r.data?.response?.count ?? null;
  } catch {
    return null;
  }
}

async function handleVkEvent({ type, object }) {
  if (!shouldDeliver(type)) return;

  let msg = '';
  const MAIN = state.CURRENT_MAIN_CHAT_ID;

  switch (type) {
    // --- Сообщения
    case 'message_new': {
      const m = object.message || object;
      const user = await getVkUserName(m.from_id);
      msg = `💬 <b>Новое сообщение:</b>\n<b>От:</b> <a href="https://vk.com/id${m.from_id}">${user}</a>\n` +
            (m.text ? `<b>Текст:</b> <i>${escapeHtml(m.text)}</i>` : '<i>(без текста)</i>') +
            summarizeAttachments(m.attachments);
      break;
    }
    case 'message_reply': {
      const r = object;
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
      msg = `❌ <b>Пользователь запретил сообщения:</b>\n<a href="https://vk.com/id${ev.user_id}">${user}</a>`;
      break;
    }

    // --- Стена
    case 'wall_post_new': {
      const p = object.post || object;
      const fromId = p.from_id || p.owner_id;
      const user = await getVkUserName(fromId);
      msg = `📝 <b>Новый пост:</b>\n<b>Автор:</b> <a href="https://vk.com/id${fromId}">${user}</a>\n` +
            `<a href="https://vk.com/wall${p.owner_id}_${p.id}">Ссылка на пост</a>\n` +
            (p.text ? `<i>${escapeHtml(p.text)}</i>` : `<i>(без текста)</i>`) +
            summarizeAttachments(p.attachments);
      break;
    }
    case 'wall_repost': {
      const rp = object.post || object;
      const cp = rp.copy_history?.[0];
      if (rp && cp) {
        const fromId = rp.from_id || rp.owner_id;
        const user = await getVkUserName(fromId);
        msg = `🔁 <b>Репост:</b>\n<b>Репостнул:</b> <a href="https://vk.com/id${fromId}">${user}</a>\n` +
              `<a href="https://vk.com/wall${cp.owner_id}_${cp.id}">Оригинал</a>\n` +
              (cp.text ? `<i>${escapeHtml(cp.text.slice(0, 200))}${cp.text.length > 200 ? '…' : ''}</i>` : `<i>(без текста)</i>`) +
              summarizeAttachments(cp.attachments);
      } else {
        msg = `🔁 Репост (payload неполный)\n<pre>${escapeHtml(JSON.stringify(object, null, 2))}</pre>`;
      }
      break;
    }
    case 'wall_reply_new':
    case 'wall_reply_edit': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      const verb = type === 'wall_reply_new' ? 'Новый комментарий к посту' : 'Комментарий к посту изменён';
      msg = `💬 <b>${verb}:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${user}</a>\n` +
            `<a href="https://vk.com/wall${c.owner_id}_${c.post_id}?reply=${c.id}">Ссылка</a>\n` +
            (c.text ? `<i>${escapeHtml(c.text)}</i>` : `<i>(без текста)</i>`) +
            summarizeAttachments(c.attachments);
      break;
    }
    case 'wall_reply_delete': {
      const c = object;
      const user = c.deleter_id ? await getVkUserName(c.deleter_id) : '—';
      msg = `🗑️ <b>Комментарий к посту удалён:</b>\n` +
            (c.deleter_id ? `<b>Удалил:</b> <a href="https://vk.com/id${c.deleter_id}">${user}</a>\n` : '') +
            `<b>Пост:</b> <a href="https://vk.com/wall${c.owner_id}_${c.post_id}">ссылка</a>\n` +
            `ID комментария: <code>${c.id}</code>`;
      break;
    }
    case 'wall_reply_restore': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      msg = `♻️ <b>Комментарий к посту восстановлен:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${user}</a>\n` +
            `<a href="https://vk.com/wall${c.owner_id}_${c.post_id}?reply=${c.id}">Ссылка</a>\n` +
            (c.text ? `<i>${escapeHtml(c.text)}</i>` : '');
      break;
    }

    // --- Фото
    case 'photo_new': {
      const p = object.photo || object;
      const user = await getVkUserName(p.owner_id);
      const url = p.sizes?.slice(-1)?.[0]?.url;
      msg = `📸 <b>Новое фото:</b>\n<b>Владелец:</b> <a href="https://vk.com/id${p.owner_id}">${user}</a>\n` +
            (url ? `<a href="${url}">Ссылка на фото</a>` : '') +
            (p.text ? `\n<i>${escapeHtml(p.text)}</i>` : '');
      break;
    }
    case 'photo_comment_new':
    case 'photo_comment_edit': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      const verb = type === 'photo_comment_new' ? 'Новый комментарий к фото' : 'Комментарий к фото изменён';
      msg = `💬 <b>${verb}:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${user}</a>\n` +
            `<a href="https://vk.com/photo${c.owner_id}_${c.photo_id}?reply=${c.id}">Ссылка</a>\n` +
            (c.text ? `<i>${escapeHtml(c.text)}</i>` : '') +
            summarizeAttachments(c.attachments);
      break;
    }
    case 'photo_comment_delete': {
      const c = object;
      const user = c.deleter_id ? await getVkUserName(c.deleter_id) : '—';
      msg = `🗑️ <b>Комментарий к фото удалён:</b>\n` +
            (c.deleter_id ? `<b>Удалил:</b> <a href="https://vk.com/id${c.deleter_id}">${user}</a>\n` : '') +
            `ID фото: <code>${c.photo_id}</code>\nID комментария: <code>${c.id}</code>`;
      break;
    }
    case 'photo_comment_restore': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      msg = `♻️ <b>Комментарий к фото восстановлен:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${user}</a>\n` +
            `<a href="https://vk.com/photo${c.owner_id}_${c.photo_id}?reply=${c.id}">Ссылка</a>\n` +
            (c.text ? `<i>${escapeHtml(c.text)}</i>` : '');
      break;
    }

    // --- Видео
    case 'video_new': {
      const v = object.video || object;
      const user = await getVkUserName(v.owner_id);
      msg = `🎥 <b>Новое видео:</b>\n<b>Владелец:</b> <a href="https://vk.com/id${v.owner_id}">${user}</a>\n` +
            `<b>Название:</b> ${escapeHtml(v.title || '—')}\n` +
            (v.owner_id && v.id ? `<a href="https://vk.com/video${v.owner_id}_${v.id}">Ссылка</a>` : '');
      break;
    }
    case 'video_comment_new':
    case 'video_comment_edit': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      const verb = type === 'video_comment_new' ? 'Новый комментарий к видео' : 'Комментарий к видео изменён';
      msg = `💬 <b>${verb}:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${user}</a>\n` +
            `<a href="https://vk.com/video${c.owner_id}_${c.video_id}?reply=${c.id}">Ссылка</a>\n` +
            (c.text ? `<i>${escapeHtml(c.text)}</i>` : '') +
            summarizeAttachments(c.attachments);
      break;
    }
    case 'video_comment_delete': {
      const c = object;
      const user = c.deleter_id ? await getVkUserName(c.deleter_id) : '—';
      msg = `🗑️ <b>Комментарий к видео удалён:</b>\n` +
            (c.deleter_id ? `<b>Удалил:</b> <a href="https://vk.com/id${c.deleter_id}">${user}</a>\n` : '') +
            `ID видео: <code>${c.video_id}</code>\nID комментария: <code>${c.id}</code>`;
      break;
    }
    case 'video_comment_restore': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      msg = `♻️ <b>Комментарий к видео восстановлен:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${user}</a>\n` +
            `<a href="https://vk.com/video${c.video_owner_id}_${c.video_id}?reply=${c.id}">Ссылка</a>\n` +
            (c.text ? `<i>${escapeHtml(c.text)}</i>` : '');
      break;
    }

    // --- Аудио
    case 'audio_new': {
      const a = object.audio || object;
      const user = await getVkUserName(a.owner_id);
      msg = `🎵 <b>Новая аудиозапись:</b>\n<b>Исполнитель:</b> ${escapeHtml(a.artist || '—')}\n` +
            `<b>Название:</b> ${escapeHtml(a.title || '—')}\n<b>Добавил:</b> <a href="https://vk.com/id${a.owner_id}">${user}</a>`;
      break;
    }

    // --- Обсуждения
    case 'board_post_new':
    case 'board_post_edit': {
      const b = object;
      const user = await getVkUserName(b.from_id);
      const verb = type === 'board_post_new' ? 'Новое сообщение в обсуждении' : 'Сообщение в обсуждении изменено';
      msg = `💬 <b>${verb}:</b>\n<b>Тема:</b> ${escapeHtml(b.topic_title || '—')}\n` +
            `<b>Автор:</b> <a href="https://vk.com/id${b.from_id}">${user}</a>\n` +
            `<a href="https://vk.com/topic-${b.group_id}_${b.topic_id}?post=${b.id}">Ссылка</a>\n` +
            (b.text ? `<i>${escapeHtml(b.text)}</i>` : '') +
            summarizeAttachments(b.attachments);
      break;
    }
    case 'board_post_delete': {
      const b = object;
      msg = `🗑️ <b>Сообщение в обсуждении удалено:</b>\n` +
            `ID темы: <code>${b.topic_id}</code>\nID сообщения: <code>${b.id}</code>`;
      break;
    }

    // --- Маркет
    case 'market_order_new': {
      const o = object.order || object;
      const user = await getVkUserName(o.user_id);
      const sum = o.total_price?.amount != null ? (o.total_price.amount / 100) : '—';
      const cur = o.total_price?.currency?.name || 'руб.';
      msg = `🛒 <b>Новый заказ:</b>\n<b>ID:</b> <code>${o.id}</code>\n<b>От:</b> <a href="https://vk.com/id${o.user_id}">${user}</a>\n` +
            `<b>Сумма:</b> ${sum} ${cur}\n<a href="https://vk.com/market?w=orders/view/${o.id}">Открыть заказ</a>`;
      break;
    }
    case 'market_comment_new':
    case 'market_comment_edit': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      const verb = type === 'market_comment_new' ? 'Новый комментарий к товару' : 'Комментарий к товару изменён';
      msg = `💬 <b>${verb}:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${user}</a>\n` +
            `<b>ID товара:</b> <code>${c.item_id}</code>\n` +
            (c.text ? `<i>${escapeHtml(c.text)}</i>` : '') +
            summarizeAttachments(c.attachments);
      break;
    }
    case 'market_comment_delete': {
      const c = object;
      const user = c.deleter_id ? await getVkUserName(c.deleter_id) : '—';
      msg = `🗑️ <b>Комментарий к товару удалён:</b>\n` +
            (c.deleter_id ? `<b>Удалил:</b> <a href="https://vk.com/id${c.deleter_id}">${user}</a>\n` : '') +
            `<b>ID товара:</b> <code>${c.item_id}</code>\nID комментария: <code>${c.id}</code>`;
      break;
    }

    // --- Опрос
    case 'poll_vote_new': {
      const p = object;
      const user = await getVkUserName(p.user_id);
      msg = `📊 <b>Голос в опросе:</b>\n<b>От:</b> <a href="https://vk.com/id${p.user_id}">${user}</a>\n` +
            `<b>Опрос ID:</b> <code>${p.poll_id}</code>\n<b>Опция ID:</b> <code>${p.option_id}</code>`;
      break;
    }

    // --- Группа/участники
    case 'group_join': {
      const j = object;
      const user = await getVkUserName(j.user_id);
      msg = `🎉 <b>Новый участник!</b>\n<a href="https://vk.com/id${j.user_id}">${user}</a>`;
      break;
    }
    case 'group_leave': {
      const l = object;
      const user = await getVkUserName(l.user_id);
      msg = `👋 <b>Покинул(а) сообщество:</b>\n<a href="https://vk.com/id${l.user_id}">${user}</a>`;
      if (LEAD_CHAT_ID) {
        await sendTelegramMessageWithRetry(LEAD_CHAT_ID, msg, { parse_mode: 'HTML' });
        msg = '';
      }
      break;
    }
    case 'group_change_photo': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      msg = `🖼️ <b>Изменена главная фотография сообщества:</b>\n` +
            `<b>Изменил:</b> <a href="https://vk.com/id${ev.user_id}">${user}</a>`;
      break;
    }
    case 'group_change_settings': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      const field = ev.changes ? Object.values(ev.changes)?.[0]?.field : null;
      msg = `⚙️ <b>Изменены настройки сообщества:</b>\n` +
            `<b>Изменил:</b> <a href="https://vk.com/id${ev.user_id}">${user}</a>\n` +
            (field ? `<b>Настройка:</b> <code>${escapeHtml(field)}</code>` : '');
      break;
    }
    case 'group_officers_edit': {
      const ev = object;
      const admin = await getVkUserName(ev.admin_id);
      const target = await getVkUserName(ev.user_id);
      if (ev.level_old === 0 && ev.level_new > 0) {
        msg = `👑 <b>Назначен руководитель:</b>\n<b>Назначил:</b> <a href="https://vk.com/id${ev.admin_id}">${admin}</a>\n` +
              `<b>Назначен:</b> <a href="https://vk.com/id${ev.user_id}">${target}</a> (Уровень: ${ev.level_new})`;
      } else if (ev.level_old > 0 && ev.level_new === 0) {
        msg = `🚫 <b>Руководитель снят:</b>\n<b>Снял:</b> <a href="https://vk.com/id${ev.admin_id}">${admin}</a>\n` +
              `<b>Снят:</b> <a href="https://vk.com/id${ev.user_id}">${target}</a>`;
      } else {
        msg = `🔄 <b>Изменён уровень руководителя:</b>\n<b>Изменил:</b> <a href="https://vk.com/id${ev.admin_id}">${admin}</a>\n` +
              `<b>Пользователь:</b> <a href="https://vk.com/id${ev.user_id}">${target}</a> (С ${ev.level_old} на ${ev.level_new})`;
      }
      break;
    }
    case 'user_block': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      const admin = await getVkUserName(ev.admin_id);
      msg = `⛔ <b>Пользователь заблокирован:</b>\n` +
            `<b>Пользователь:</b> <a href="https://vk.com/id${ev.user_id}">${user}</a>\n` +
            `<b>Заблокировал:</b> <a href="https://vk.com/id${ev.admin_id}">${admin}</a>`;
      break;
    }
    case 'user_unblock': {
      const ev = object;
      const user = await getVkUserName(ev.user_id);
      const admin = await getVkUserName(ev.admin_id);
      msg = `✅ <b>Пользователь разблокирован:</b>\n` +
            `<b>Пользователь:</b> <a href="https://vk.com/id${ev.user_id}">${user}</a>\n` +
            `<b>Разблокировал:</b> <a href="https://vk.com/id${ev.admin_id}">${admin}</a>`;
      break;
    }

    // --- Лайки (улучшенные подписи и ссылки)
    case 'like_add':
    case 'like_remove': {
      const ev = object;

      // owner_id может отсутствовать — берём ID сообщества как fallback
      let ownerId = ev.owner_id;
      if (!ownerId) ownerId = -Number(VK_GROUP_ID);

      const liker = await getVkUserName(ev.liker_id);
      const typeText = getObjectTypeDisplayName(ev.object_type);

      const link = getObjectLinkForLike(
        ownerId,
        ev.object_type,
        ev.object_id,
        ev.post_id,
        {
          parent_photo_id: ev.photo_id,
          parent_video_id: ev.video_id,
          parent_topic_id: ev.topic_id,
          parent_item_id: ev.item_id
        }
      );

      let total = null;
      const unsafeTypes = ['clip','story','article','sitepage','podcast','app'];
      if (!unsafeTypes.includes(String(ev.object_type || '').toLowerCase())) {
        try { total = await tryGetLikesCount(ownerId, ev.object_id, ev.object_type); } catch {}
      }

      msg = `<b>${type === 'like_add' ? '❤️ Новый лайк в VK' : '💔 Лайк удалён в VK'}</b>\n`;
      msg += `<b>От:</b> <a href="https://vk.com/id${ev.liker_id}">${liker}</a>\n`;
      msg += `<b>${type === 'like_add' ? 'К' : 'С'}:</b> `;
      if (link) {
        msg += `<a href="${link}">${typeText}</a>`;
      } else {
        msg += `${typeText} ID <code>${ev.object_id}</code>`;
      }
      if (total != null) msg += ` (Всего: ${total})`;
      break;
    }

    // --- Лиды
    case 'lead_forms_new': {
      const lf = object;
      const user = await getVkUserName(lf.user_id);
      const now = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const fieldsMap = { phone_number: 'Телефон', age: 'Возраст', custom_0: 'Имя', custom_1: 'Фамилия' };
      let text = `🥳 Новая заявка (${now})\n<b>Пользователь:</b> <a href="https://vk.com/id${lf.user_id}">${user}</a>`;
      if (Array.isArray(lf.answers)) {
        for (const a of lf.answers) {
          const label = fieldsMap[a.key] || a.key;
          const val = Array.isArray(a.answer) ? a.answer.join(', ') : a.answer;
          text += `\n<b>${escapeHtml(label)}:</b> ${escapeHtml(val || '—')}`;
        }
      }
      if (LEAD_CHAT_ID) {
        await sendTelegramMessageWithRetry(LEAD_CHAT_ID, text, { parse_mode: 'HTML' });
        text = '';
      }
      msg = text || '';
      break;
    }

    // --- Fallback
    default: {
      msg = `❓ <b>Событие VK:</b>\nТип: <code>${escapeHtml(type)}</code>\n<pre>${escapeHtml(JSON.stringify(object, null, 2))}</pre>`;
      break;
    }
  }

  if (msg) {
    await sendTelegramMessageWithRetry(MAIN, msg, { parse_mode: 'HTML' });
  }
}

module.exports = { handleVkEvent };
