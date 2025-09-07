// src/vk/events.js — обработчики VK-событий

const { state } = require('../state');
const { sendTelegramMessageWithRetry } = require('../telegram');
const { escapeHtml, getVkUserName } = require('../utils');

async function handleVkEvent({ type, object }) {
  // выключенные события — игнор
  if (state.eventToggleState[type] === false) return;

  let msg = '';

  switch (type) {
    case 'video_comment_restore': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      msg = [
        '♻️ <b>Комментарий к видео восстановлен:</b>',
        `Автор: <a href="https://vk.com/id${c.from_id}">${user}</a>`,
        `<a href="https://vk.com/video${c.video_owner_id}_${c.video_id}?reply=${c.id}">Ссылка</a>`,
        c.text ? `<i>${escapeHtml(c.text)}</i>` : ''
      ].filter(Boolean).join('\n');
      break;
    }
    case 'photo_comment_restore': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      msg = [
        '♻️ <b>Комментарий к фото восстановлен:</b>',
        `Автор: <a href="https://vk.com/id${c.from_id}">${user}</a>`,
        `<a href="https://vk.com/photo${c.owner_id}_${c.photo_id}?reply=${c.id}">Ссылка</a>`,
        c.text ? `<i>${escapeHtml(c.text)}</i>` : ''
      ].filter(Boolean).join('\n');
      break;
    }
    case 'wall_reply_restore': {
      const c = object;
      const user = await getVkUserName(c.from_id);
      msg = [
        '♻️ <b>Комментарий к посту восстановлен:</b>',
        `Автор: <a href="https://vk.com/id${c.from_id}">${user}</a>`,
        `<a href="https://vk.com/wall${c.owner_id}_${c.post_id}?reply=${c.id}">Ссылка</a>`,
        c.text ? `<i>${escapeHtml(c.text)}</i>` : ''
      ].filter(Boolean).join('\n');
      break;
    }
    // сюда постепенно переносите остальные кейсы…
    default: {
      msg = `❓ Неизвестное событие VK:\nТип: <code>${escapeHtml(type)}</code>\n<pre>${escapeHtml(JSON.stringify(object, null, 2))}</pre>`;
    }
  }

  if (msg) {
    await sendTelegramMessageWithRetry(state.CURRENT_MAIN_CHAT_ID, msg, { parse_mode: 'HTML' });
  }
}

module.exports = { handleVkEvent };
