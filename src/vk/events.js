// src/vk/events.js — лаконичные уведомления VK Callback API (HTML + ссылки + счётчики лайков)

const axios = require('axios');
const { state, shouldDeliver } = require('../state'); // может быть undefined — см. allowDeliver()
const { sendTelegramMessageWithRetry } = require('../telegram');
const { escapeHtml, getVkUserName } = require('../utils');
const { VK_GROUP_ID, VK_SERVICE_KEY, LEAD_CHAT_ID } = require('../config');

/* ================== вспомогательные функции ================== */

function allowDeliver(type) {
  if (typeof shouldDeliver === 'function') return !!shouldDeliver(type);
  const m = (state && state.eventToggleState) ? state.eventToggleState : {};
  return !(Object.prototype.hasOwnProperty.call(m, type) && m[type] === false);
}

function mainChat() {
  return state.CURRENT_MAIN_CHAT_ID;
}

async function notifyMAIN(html) {
  const chat = mainChat();
  if (!chat || !html) return;
  await sendTelegramMessageWithRetry(String(chat), html, { parse_mode: 'HTML' });
}

async function notifyLEAD(html) {
  const lead = LEAD_CHAT_ID || state.LEAD_CHAT_ID;
  if (!lead || !html) return;
  await sendTelegramMessageWithRetry(String(lead), html, { parse_mode: 'HTML' });
}

async function userLink(id) {
  const name = await getVkUserName(id).catch(() => `id${id}`);
  return `<a href="https://vk.com/id${id}">${escapeHtml(name)}</a>`;
}

function objNounDative(type) {
  const t = String(type || '').toLowerCase(); // для "к <чему?>"
  switch (t) {
    case 'post': return 'посту';
    case 'comment': return 'комментарию';
    case 'photo': return 'фотографии';
    case 'video': return 'видео';
    case 'clip': return 'клипу';
    case 'story': return 'истории';
    case 'note': return 'заметке';
    case 'photo_comment': return 'комментарию к фото';
    case 'video_comment': return 'комментарию к видео';
    case 'topic_comment': return 'комментарию в обсуждении';
    case 'market': return 'товару';
    case 'market_comment': return 'комментарию к товару';
    case 'topic': return 'обсуждению';
    default: return 'объекту';
  }
}

function objNounAblative(type) {
  const t = String(type || '').toLowerCase(); // для "от <чего?>"
  switch (t) {
    case 'post': return 'поста';
    case 'comment': return 'комментария';
    case 'photo': return 'фотографии';
    case 'video': return 'видео';
    case 'clip': return 'клипа';
    case 'story': return 'истории';
    case 'note': return 'заметки';
    case 'photo_comment': return 'комментария к фото';
    case 'video_comment': return 'комментария к видео';
    case 'topic_comment': return 'комментария в обсуждении';
    case 'market': return 'товара';
    case 'market_comment': return 'комментария к товару';
    case 'topic': return 'обсуждения';
    default: return 'объекта';
  }
}

function absOwner(ownerId) {
  return String(ownerId || '').replace(/^-/, '');
}

function buildObjectLink(ownerId, objectType, objectId, postId) {
  const t = String(objectType || '').toLowerCase();
  const ownAbs = absOwner(ownerId);
  switch (t) {
    case 'post':            return `https://vk.com/wall-${ownAbs}_${objectId}`;
    case 'comment':         return postId ? `https://vk.com/wall-${ownAbs}_${postId}?reply=${objectId}` : null;
    case 'photo':           return `https://vk.com/photo-${ownAbs}_${objectId}`;
    case 'video':           return `https://vk.com/video-${ownAbs}_${objectId}`;
    case 'clip':            return `https://vk.com/clip-${ownAbs}_${objectId}`; // если не работает — вернётся null
    case 'market':          return `https://vk.com/market-${ownAbs}?w=product-${ownAbs}_${objectId}`;
    case 'topic':           return `https://vk.com/topic-${ownAbs}_${postId || objectId}`;
    case 'photo_comment':   return `https://vk.com/photo-${ownAbs}_${postId || objectId}?reply=${objectId}`;
    case 'video_comment':   return `https://vk.com/video-${ownAbs}_${postId || objectId}?reply=${objectId}`;
    case 'topic_comment':   return `https://vk.com/topic-${ownAbs}_${postId || objectId}?reply=${objectId}`;
    case 'market_comment':  return `https://vk.com/market-${ownAbs}?w=product-${ownAbs}_${postId || objectId}`;
    default:                return null;
  }
}

function toLikesApiType(objectType) {
  const t = String(objectType || '').toLowerCase();
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
    default:
      return null;
  }
}

async function tryGetLikesCount(ownerId, objectId, objectType) {
  const type = toLikesApiType(objectType);
  if (!type || !VK_SERVICE_KEY) return null;
  const params = {
    access_token: VK_SERVICE_KEY,
    v: '5.199',
    type,
    owner_id: ownerId,
    item_id: objectId,
    count: 0
  };
  try {
    const { data } = await axios.get('https://api.vk.com/method/likes.getList', { params, timeout: 3000 });
    if (data && data.response && typeof data.response.count === 'number') return data.response.count;
  } catch (_) {}
  return null;
}

function groupLink() {
  const id = absOwner(-Number(VK_GROUP_ID));
  return `https://vk.com/public${id}`;
}

/* ================== обработчик ================== */

async function handleVkEvent({ type, object }) {
  if (!allowDeliver(type)) return;

  let msg = '';

  switch (type) {
    /* ---------- Сообщения (лаконично) ---------- */
    case 'message_new': {
      const m = object.message || object;
      const u = await userLink(m.from_id);
      msg = `💬 ${u} написал(а)`;
      break;
    }
    case 'message_reply': {
      const r = object;
      const u = await userLink(r.from_id);
      msg = `↩️ Ответ отправлен: ${u}`;
      break;
    }
    case 'message_edit': {
      const r = object;
      const u = await userLink(r.from_id);
      msg = `✏️ ${u} отредактировал(а) сообщение`;
      break;
    }
    case 'message_allow': {
      const ev = object;
      const u = await userLink(ev.user_id);
      msg = `✅ ${u} разрешил(а) сообщения`;
      break;
    }
    case 'message_deny': {
      const ev = object;
      const u = await userLink(ev.user_id);
      msg = `⛔️ ${u} запретил(а) сообщения`;
      break;
    }
    case 'message_typing_state': {
      const ev = object;
      const u = await userLink(ev.from_id);
      msg = `⌨️ ${u} печатает…`;
      break;
    }
    case 'message_event': {
      const ev = object;
      const u = await userLink(ev.user_id);
      msg = `🖲️ ${u} нажал(а) кнопку`;
      break;
    }

    /* ---------- Лайки (лаконично + СЧЁТЧИК) ---------- */
    case 'like_add': {
      const ev = object;
      const ownerId = ev.owner_id || -Number(VK_GROUP_ID);
      const u = await userLink(ev.liker_id);
      const noun = objNounDative(ev.object_type);
      const link = buildObjectLink(ownerId, ev.object_type, ev.object_id, ev.post_id);
      const obj = link ? `<a href="${link}">${noun}</a>` : noun;

      let total = null;
      try { total = await tryGetLikesCount(ownerId, ev.object_id, ev.object_type); } catch {}
      msg = `❤️ ${u} к ${obj}${typeof total === 'number' ? ` (Всего: ${total})` : ''}`;
      break;
    }
    case 'like_remove': {
      const ev = object;
      const ownerId = ev.owner_id || -Number(VK_GROUP_ID);
      const u = await userLink(ev.liker_id);
      const noun = objNounAblative(ev.object_type);
      const link = buildObjectLink(ownerId, ev.object_type, ev.object_id, ev.post_id);
      const obj = link ? `<a href="${link}">${noun}</a>` : noun;

      let total = null;
      try { total = await tryGetLikesCount(ownerId, ev.object_id, ev.object_type); } catch {}
      msg = `💔 ${u} от ${obj}${typeof total === 'number' ? ` (Всего: ${total})` : ''}`;
      break;
    }

    /* ---------- Стена ---------- */
    case 'wall_post_new': {
      const p = object;
      const u = await userLink(p.from_id || p.owner_id);
      const link = `https://vk.com/wall${p.owner_id}_${p.id}`;
      msg = `🧱 ${u} к <a href="${link}">посту</a>`;
      break;
    }
    case 'wall_post_edit': {
      const p = object;
      const link = `https://vk.com/wall${p.owner_id}_${p.id}`;
      msg = `✏️ Пост: <a href="${link}">обновлён</a>`;
      break;
    }
    case 'wall_reply_new': {
      const c = object;
      const u = await userLink(c.from_id);
      const link = `https://vk.com/wall-${absOwner(c.owner_id)}_${c.post_id}?reply=${c.id}`;
      msg = `💬 ${u} к <a href="${link}">комментарию</a>`;
      break;
    }
    case 'wall_reply_edit': {
      const c = object;
      const link = `https://vk.com/wall-${absOwner(c.owner_id)}_${c.post_id}?reply=${c.id}`;
      msg = `✏️ Комментарий: <a href="${link}">обновлён</a>`;
      break;
    }
    case 'wall_reply_delete': {
      const c = object;
      const link = `https://vk.com/wall-${absOwner(c.owner_id)}_${c.post_id}`;
      msg = `🗑️ Удалён комментарий к <a href="${link}">посту</a>`;
      break;
    }
    case 'wall_reply_restore': {
      const c = object;
      const link = `https://vk.com/wall-${absOwner(c.owner_id)}_${c.post_id}?reply=${c.id}`;
      msg = `♻️ Восстановлен <a href="${link}">комментарий</a>`;
      break;
    }

    /* ---------- Медиа ---------- */
    case 'photo_new': {
      const ph = object;
      const u = await userLink(ph.user_id || ph.owner_id);
      const link = `https://vk.com/photo-${absOwner(ph.owner_id)}_${ph.id}`;
      msg = `🖼️ ${u} к <a href="${link}">фотографии</a>`;
      break;
    }
    case 'video_new': {
      const v = object;
      const u = await userLink(v.user_id || v.owner_id);
      const link = `https://vk.com/video-${absOwner(v.owner_id)}_${v.id}`;
      msg = `🎬 ${u} к <a href="${link}">видео</a>`;
      break;
    }
    case 'audio_new': {
      const a = object;
      const title = [a.artist, a.title].filter(Boolean).map(escapeHtml).join(' — ') || 'аудио';
      msg = `🎵 Добавлен трек: ${title}`;
      break;
    }

    /* ---------- Комментарии к медиа/товарам/обсуждениям ---------- */
    case 'photo_comment_new': {
      const c = object;
      const u = await userLink(c.from_id);
      msg = `🖼️ ${u} к комментарию к фото`;
      break;
    }
    case 'video_comment_new': {
      const c = object;
      const u = await userLink(c.from_id);
      msg = `🎬 ${u} к комментарию к видео`;
      break;
    }
    case 'market_comment_new': {
      const c = object;
      const u = await userLink(c.from_id);
      msg = `🛒 ${u} к комментарию к товару`;
      break;
    }
    case 'topic_comment_new': {
      const c = object;
      const u = await userLink(c.from_id);
      const link = `https://vk.com/topic-${absOwner(c.owner_id)}_${c.topic_id}?reply=${c.id}`;
      msg = `🗂️ ${u} к <a href="${link}">комментарию в обсуждении</a>`;
      break;
    }

    /* ---------- Обсуждения (board) ---------- */
    case 'board_post_new': {
      const ev = object;
      const u = ev.from_id ? await userLink(ev.from_id) : 'Кто-то';
      const link = `https://vk.com/topic-${absOwner(ev.group_id || VK_GROUP_ID)}_${ev.topic_id || ev.post_id || ev.object_id}`;
      msg = `📌 ${u} к <a href="${link}">записи в обсуждении</a>`;
      break;
    }

    /* ---------- Маркет заказы ---------- */
    case 'market_order_new': {
      const o = object;
      const u = o.user_id ? await userLink(o.user_id) : 'Покупатель';
      msg = `🧾 Новый заказ: ${u}`;
      break;
    }
    case 'market_order_edit': {
      const o = object;
      msg = `🧾 Заказ обновлён`;
      break;
    }

    /* ---------- Группа / Подписки / Модерация ---------- */
    case 'group_join': {
      const ev = object;
      const u = await userLink(ev.user_id);
      const kind = String(ev.join_type || '').toLowerCase();
      msg = `🟢 ${u} вступил(а)`;
      // дубль в лид-чат для "новых заявок"
      ///if (kind === 'request') {
      /// await notifyLEAD(`🟢 ${u} запросил(а) вступление в <a href="${groupLink()}">сообщество</a>`);
      ///}
      break;
    }
    case 'group_leave': {
      const ev = object;
      const u = await userLink(ev.user_id);
      msg = `🔴 ${u} вышел(а)`;
      // дубль в лид-чат
      await notifyLEAD(`🔴 ${u} вышел(а) из <a href="${groupLink()}">сообщества</a>`);
      break;
    }
    case 'user_block': {
      const ev = object;
      const u = await userLink(ev.user_id);
      msg = `🚫 ${u} заблокирован(а)`;
      break;
    }
    case 'user_unblock': {
      const ev = object;
      const u = await userLink(ev.user_id);
      msg = `✅ ${u} разблокирован(а)`;
      break;
    }
    case 'group_officers_edit': {
      msg = `🛡️ Изменён состав модераторов`;
      break;
    }
    case 'group_change_settings': {
      msg = `⚙️ Изменены настройки сообщества`;
      break;
    }
    case 'group_change_photo': {
      msg = `🖼️ Сменена фотография сообщества`;
      break;
    }

    /* ---------- Опросы / Лид-формы / Прочее ---------- */
    case 'poll_vote_new': {
      const ev = object;
      const u = await userLink(ev.user_id);
      msg = `📊 Голос: ${u}`;
      break;
    }
    case 'lead_forms_new': {
      const lf = object;
      const u = lf.user_id ? await userLink(lf.user_id) : 'Пользователь';
      msg = `📝 Лид-форма: ${u}`;
      break;
    }
    case 'app_payload': {
      const ev = object;
      const u = ev.user_id ? await userLink(ev.user_id) : 'Пользователь';
      msg = `📦 App payload: ${u}`;
      break;
    }
    case 'vkpay_transaction': {
      const ev = object;
      const u = ev.from_id ? await userLink(ev.from_id) : 'Пользователь';
      msg = `💳 VK Pay: ${u}`;
      break;
    }

    /* ---------- По умолчанию (лаконично) ---------- */
    default: {
      msg = `❓ ${escapeHtml(String(type))}`;
      break;
    }
  }

  if (msg) {
    await notifyMAIN(msg);
  }
}

module.exports = { handleVkEvent };
