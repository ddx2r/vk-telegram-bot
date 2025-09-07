// src/vk/events.js

const { sendTelegramMessageWithRetry } = require('../telegram');
const { state, shouldDeliver } = require('../state');
const { LEAD_CHAT_ID } = require('../config');

function allowDeliver(type) {
  if (typeof shouldDeliver === 'function') return !!shouldDeliver(type);
  // Fallback: если shouldDeliver не определён — блокируем ТОЛЬКО если явно false
  const m = (state && state.eventToggleState) ? state.eventToggleState : {};
  return !(Object.prototype.hasOwnProperty.call(m, type) && m[type] === false);
}

async function handleVkEvent({ type, object }) {
  let msg;

  // Если событие выключено в toggleState → пропускаем
  if (!allowDeliver(type)) return;

  switch (type) {
    case 'message_new':
      msg = `💬 Новое сообщение: ${object.message.text}`;
      break;

    case 'wall_post_new':
      msg = `🧱 Новый пост на стене:\n${object.text}`;
      break;

    case 'like_add':
      msg = `❤️ Новый лайк\nОт: id${object.liker_id}\nК объекту: ${object.object_type} ${object.object_id}`;
      break;

    case 'like_remove':
      msg = `💔 Лайк удалён\nОт: id${object.liker_id}\nС объекта: ${object.object_type} ${object.object_id}`;
      break;

    // … другие кейсы из твоего исходного файла …

    default:
      msg = `❓ Событие VK: ${type}\n${JSON.stringify(object, null, 2)}`;
      break;
  }

  if (msg) {
    try {
      // Особый случай: если это лид — отправляем в LEAD_CHAT_ID
      if (type === 'lead_forms_new' && LEAD_CHAT_ID) {
        await sendTelegramMessageWithRetry(LEAD_CHAT_ID, msg, { parse_mode: 'HTML' });
      } else {
        await sendTelegramMessageWithRetry(state.CURRENT_MAIN_CHAT_ID, msg, { parse_mode: 'HTML' });
      }
    } catch (e) {
      console.error('Ошибка при отправке уведомления в Telegram:', e);
    }
  }
}

module.exports = { handleVkEvent };