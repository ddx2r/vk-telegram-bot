// server.js - Основной файл сервера для обработки VK Callback API и пересылки в Telegram

// Импорт необходимых модулей
const express = require('express');               // Веб-фреймворк для Node.js
const bodyParser = require('body-parser');        // Для парсинга JSON-запросов
const axios = require('axios');                   // Для HTTP-запросов (Telegram/VK/скачивание медиа)
const crypto = require('crypto');                 // Для хеширования (дедупликация)
const NodeCache = require('node-cache');          // In-memory кэш
const TelegramBot = require('node-telegram-bot-api'); // Telegram Bot API

// ===== helpers (ВАЖНО: объявлены один раз) =====
function escapeHtml(text) {
  if (typeof text !== 'string') text = String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getObjectTypeDisplayName(type) {
  switch (type) {
    case 'post': return 'посту';
    case 'photo': return 'фотографии';
    case 'video': return 'видео';
    case 'comment': return 'комментарию';
    case 'topic': return 'обсуждению';
    case 'market': return 'товару';
    default: return `объекту типа <code>${escapeHtml(type)}</code>`;
  }
}

function getObjectLinkForLike(ownerId, objectType, objectId, postId) {
  if (objectType === 'comment' && postId) {
    return `https://vk.com/wall${ownerId}_${postId}?reply=${objectId}`;
  }
  switch (objectType) {
    case 'post': return `https://vk.com/wall${ownerId}_${objectId}`;
    case 'photo': return `https://vk.com/photo${ownerId}_${objectId}`;
    case 'video': return `https://vk.com/video${ownerId}_${objectId}`;
    case 'comment': return `https://vk.com/id${ownerId}?w=wall${ownerId}_${objectId}`;
    case 'topic': return `https://vk.com/topic-${process.env.VK_GROUP_ID}_${objectId}`;
    case 'market': return `https://vk.com/market-${ownerId}?w=product-${ownerId}_${objectId}`;
    default: return null;
  }
}

// ===== Инициализация Express =====
const app = express();
app.use(bodyParser.json());

// ===== Переменные окружения =====
const VK_GROUP_ID      = process.env.VK_GROUP_ID;
const VK_SECRET_KEY    = process.env.VK_SECRET_KEY;
const VK_SERVICE_KEY   = process.env.VK_SERVICE_KEY; // сервисный ключ доступа
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID; // основной чат
const LEAD_CHAT_ID       = process.env.LEAD_CHAT_ID;     // чат для лидов (опционально)

// Проверка обязательных переменных
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Ошибка: отсутствуют переменные VK_GROUP_ID, VK_SECRET_KEY, VK_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.');
  process.exit(1);
}
if (!LEAD_CHAT_ID) {
  console.warn('Внимание: LEAD_CHAT_ID не установлен — уведомления для лидов отправляться не будут.');
}

// ===== Telegram Bot =====
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ===== Дедупликация (in-memory) =====
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// ===== Переключатели событий (in-memory) =====
const eventToggleState = {
  'lead_forms_new': true,
  'message_reply': true,
  'message_new': true,
  'wall_post_new': true,
  'wall_repost': true,
  'wall_reply_new': true,
  'wall_reply_edit': true,
  'wall_reply_delete': true,
  'board_post_new': true,
  'board_post_edit': true,
  'board_post_delete': true,
  'photo_new': true,
  'photo_comment_new': true,
  'photo_comment_edit': true,
  'photo_comment_delete': true,
  'video_new': true,
  'video_comment_new': true,
  'video_comment_edit': true,
  'video_comment_delete': true,
  'audio_new': true,
  'market_order_new': true,
  'market_comment_new': true,
  'market_comment_edit': true,
  'market_comment_delete': true,
  'poll_vote_new': true,
  'group_join': true,
  'group_leave': true,
  'group_change_photo': true,
  'group_change_settings': true,
  'group_officers_edit': true,
  'user_block': true,
  'user_unblock': true,
  'like_add': true,
  'like_remove': true,
  'message_allow': true,
  'message_deny': true,
};

// ===== VK helpers =====
async function getVkUserName(userId) {
  if (!userId) return null;
  try {
    if (!/^\d+$/.test(userId)) {
      throw new Error(`Некорректный ID пользователя: ${userId}`);
    }
    const response = await axios.get('https://api.vk.com/method/users.get', {
      params: { user_ids: userId, access_token: VK_SERVICE_KEY, v: '5.131', lang: 'ru' },
      timeout: 5000
    });
    if (response.data.error) throw new Error(`VK API: ${response.data.error.error_msg}`);

    const arr = response.data.response || [];
    if (arr.length > 0) {
      const user = arr[0];
      if (user.deactivated) return `[Деактивирован] ID: ${userId}`;
      return `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
    }
    return `ID: ${userId}`;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Ошибка getVkUserName(${userId}):`, error.response?.data || error.message);
    if (error.response?.data?.error?.error_code === 38) return `⚠️ [Ошибка ключа VK] ID: ${userId}`;
    return `ID: ${userId}`;
  }
}

async function getVkLikesCount(ownerId, itemId, itemType) {
  try {
    const response = await axios.get('https://api.vk.com/method/likes.getList', {
      params: { type: itemType, owner_id: ownerId, item_id: itemId, access_token: VK_SERVICE_KEY, v: '5.131' },
      timeout: 5000
    });
    if (response.data?.response?.count !== undefined) return response.data.response.count;
    console.warn(`[${new Date().toISOString()}] VK likes.getList без count:`, response.data);
    return null;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Ошибка likes.getList:`, error.response?.data || error.message);
    if (error.response?.data?.error?.error_code === 38) return -1;
    return null;
  }
}

// ===== Отправка в Telegram =====
async function sendTelegramMessageWithRetry(chatId, text, options = {}) {
  let sent = false;
  for (let i = 0; i < 3; i++) {
    try {
      await bot.sendMessage(chatId, text, { ...options, disable_web_page_preview: true });
      sent = true;
      break;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Ошибка sendMessage попытка ${i + 1}:`, err.response ? err.response.data : err.message);
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  if (!sent) console.error(`[${new Date().toISOString()}] Не удалось отправить сообщение в Telegram после нескольких попыток.`);
}

async function sendTelegramMedia(chatId, type, fileUrl, caption, options = {}) {
  try {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const fileBuffer = Buffer.from(response.data);

    let sent = false;
    for (let i = 0; i < 3; i++) {
      try {
        switch (type) {
          case 'photo':    await bot.sendPhoto(chatId, fileBuffer,   { caption, parse_mode: 'HTML', ...options }); break;
          case 'video':    await bot.sendVideo(chatId, fileBuffer,   { caption, parse_mode: 'HTML', ...options }); break;
          case 'audio':    await bot.sendAudio(chatId, fileBuffer,   { caption, parse_mode: 'HTML', ...options }); break;
          case 'document': await bot.sendDocument(chatId, fileBuffer,{ caption, parse_mode: 'HTML', ...options }); break;
          default:
            console.warn(`[${new Date().toISOString()}] Неподдерживаемый тип медиа: ${type}`);
            return;
        }
        sent = true;
        console.log(`[${new Date().toISOString()}] Медиа (${type}) отправлено. Попытка ${i + 1}`);
        break;
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Ошибка отправки медиа (${type}), попытка ${i + 1}:`, err.response ? err.response.data : err.message);
        if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
    if (!sent) {
      console.error(`[${new Date().toISOString()}] Не удалось отправить медиа (${type}) после нескольких попыток.`);
      await sendTelegramMessageWithRetry(chatId, `⚠️ Не удалось отправить медиа (${type}) — возможно, файл слишком большой или временная ошибка.`, { parse_mode: 'HTML' });
    }
  } catch (downloadError) {
    console.error(`[${new Date().toISOString()}] Ошибка скачивания медиа ${fileUrl}:`, downloadError.message);
    await sendTelegramMessageWithRetry(chatId, `⚠️ Ошибка скачивания медиа с VK: ${escapeHtml(downloadError.message)}`, { parse_mode: 'HTML' });
  }
}

async function processAttachments(attachments, chatId, captionPrefix = '') {
  let attachmentsSummary = '';
  if (!attachments || attachments.length === 0) return attachmentsSummary;

  attachmentsSummary += '\n\n<b>Вложения:</b>\n';
  for (const attach of attachments) {
    let sentDirectly = false;
    let fallbackLink = '';
    let mediaCaption = '';

    switch (attach.type) {
      case 'photo': {
        const photo = attach.photo;
        const photoUrl = photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url;
        if (photoUrl) {
          mediaCaption = `${captionPrefix} Фото: ${escapeHtml(photo.text || '')}`;
          await sendTelegramMedia(chatId, 'photo', photoUrl, mediaCaption);
          sentDirectly = true;
          fallbackLink = photoUrl;
        }
        attachmentsSummary += `📸 <a href="${fallbackLink || '#'}">Фото</a>`;
        if (photo.text) attachmentsSummary += ` <i>(${escapeHtml(photo.text)})</i>`;
        attachmentsSummary += '\n';
        break;
      }
      case 'video': {
        const video = attach.video;
        let directVideoUrl = null;
        if (video.owner_id && video.id) {
          try {
            const videoResp = await axios.get('https://api.vk.com/method/video.get', {
              params: { videos: `${video.owner_id}_${video.id}`, access_token: VK_SERVICE_KEY, v: '5.131' },
              timeout: 5000
            });
            const files = videoResp.data?.response?.items?.[0]?.files;
            if (files) {
              directVideoUrl = files.mp4_1080 || files.mp4_720 || files.mp4_480 || files.mp4_360 || files.mp4_240;
            }
          } catch (e) {
            console.error(`[${new Date().toISOString()}] Ошибка video.get:`, e.message);
          }
        }
        if (directVideoUrl) {
          mediaCaption = `${captionPrefix} Видео: ${escapeHtml(video.title || 'Без названия')}`;
          await sendTelegramMedia(chatId, 'video', directVideoUrl, mediaCaption);
          sentDirectly = true;
          fallbackLink = directVideoUrl;
        } else if (video.player) {
          fallbackLink = video.player;
        } else if (video.owner_id && video.id) {
          fallbackLink = `https://vk.com/video${video.owner_id}_${video.id}`;
        }
        attachmentsSummary += `🎥 <a href="${fallbackLink || '#'}">Видео: ${escapeHtml(video.title || 'Без названия')}</a>`;
        if (!sentDirectly) attachmentsSummary += ` (прямая отправка недоступна)`;
        attachmentsSummary += '\n';
        break;
      }
      case 'audio': {
        const audio = attach.audio;
        if (audio.url) {
          mediaCaption = `${captionPrefix} Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}`;
          await sendTelegramMedia(chatId, 'audio', audio.url, mediaCaption);
          sentDirectly = true;
          fallbackLink = audio.url;
        }
        attachmentsSummary += `🎵 <a href="${fallbackLink || '#'}">Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}</a>\n`;
        break;
      }
      case 'doc': {
        const doc = attach.doc;
        if (doc.url) {
          mediaCaption = `${captionPrefix} Документ: ${escapeHtml(doc.title || 'Без названия')}`;
          await sendTelegramMedia(chatId, 'document', doc.url, mediaCaption);
          sentDirectly = true;
          fallbackLink = doc.url;
        }
        attachmentsSummary += `📄 <a href="${fallbackLink || '#'}">Документ: ${escapeHtml(doc.title || 'Без названия')}</a>\n`;
        break;
      }
      case 'link': {
        const link = attach.link;
        if (link.url) attachmentsSummary += `🔗 <a href="${link.url}">${escapeHtml(link.title || 'Ссылка')}</a>\n`;
        break;
      }
      case 'poll': {
        const poll = attach.poll;
        if (poll.id) attachmentsSummary += `📊 Опрос: ${escapeHtml(poll.question || 'Без вопроса')}\n`;
        break;
      }
      case 'wall': {
        const wallPost = attach.wall;
        if (wallPost.owner_id && wallPost.id) {
          attachmentsSummary += `📝 Вложенный пост: <a href="https://vk.com/wall${wallPost.owner_id}_${wallPost.id}">Ссылка</a>\n`;
        }
        break;
      }
      case 'graffiti': {
        const graffiti = attach.graffiti;
        if (graffiti?.url) {
          mediaCaption = `${captionPrefix} Граффити`;
          await sendTelegramMedia(chatId, 'photo', graffiti.url, mediaCaption);
          sentDirectly = true;
          fallbackLink = graffiti.url;
        }
        attachmentsSummary += `🎨 <a href="${fallbackLink || '#'}">Граффити</a>\n`;
        break;
      }
      case 'sticker': {
        const sticker = attach.sticker;
        if (sticker?.images_with_background?.length) {
          const stickerUrl = sticker.images_with_background[sticker.images_with_background.length - 1].url;
          mediaCaption = `${captionPrefix} Стикер`;
          await sendTelegramMedia(chatId, 'photo', stickerUrl, mediaCaption);
          sentDirectly = true;
          fallbackLink = stickerUrl;
        }
        attachmentsSummary += `🖼️ <a href="${fallbackLink || '#'}">Стикер</a>\n`;
        break;
      }
      case 'gift': {
        const gift = attach.gift;
        if (gift?.thumb_256) {
          mediaCaption = `${captionPrefix} Подарок`;
          await sendTelegramMedia(chatId, 'photo', gift.thumb_256, mediaCaption);
          sentDirectly = true;
          fallbackLink = gift.thumb_256;
        }
        attachmentsSummary += `🎁 <a href="${fallbackLink || '#'}">Подарок</a>\n`;
        break;
      }
      default:
        console.log(`[${new Date().toISOString()}] Неизвестное вложение: ${attach.type}`, attach);
        attachmentsSummary += `❓ Неизвестное вложение: ${attach.type}\n`;
    }
  }
  return attachmentsSummary;
}

// ===== Команды Telegram =====
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== TELEGRAM_CHAT_ID) {
    await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
    return;
  }
  await sendTelegramMessageWithRetry(chatId, '✅ Бот активен и прослушивает события VK.');
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== TELEGRAM_CHAT_ID) {
    await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
    return;
  }
  const helpMessage = `
👋 *Доступные команды:*

/status - Проверить статус бота.
/help - Показать это сообщение.
/my_chat_id - Узнать ID текущего чата.
/test_notification - Отправить тестовое уведомление.
/list_events - Показать список событий VK и их статус.
/toggle_event <тип_события> - Включить/отключить уведомления.
_Внимание: Настройки не сохраняются после перезапуска!_
`;
  await sendTelegramMessageWithRetry(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/my_chat_id/, async (msg) => {
  const chatId = msg.chat.id;
  await sendTelegramMessageWithRetry(chatId, `ID этого чата: \`${chatId}\``, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/test_notification/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== TELEGRAM_CHAT_ID) {
    await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
    return;
  }
  await sendTelegramMessageWithRetry(chatId, '🔔 Тестовое уведомление от VK-Telegram бота успешно получено!');
});

bot.onText(/\/list_events/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== TELEGRAM_CHAT_ID) {
    await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
    return;
  }
  let eventList = '✨ *Статус уведомлений VK-событий:*\n\n';
  for (const type in eventToggleState) {
    eventList += `\`${type}\`: ${eventToggleState[type] ? '✅ Включено' : '❌ Отключено'}\n`;
  }
  eventList += '\n_Внимание: Настройки не сохраняются после перезапуска бота!_';
  await sendTelegramMessageWithRetry(chatId, eventList, { parse_mode: 'Markdown' });
});

bot.onText(/\/toggle_event (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== TELEGRAM_CHAT_ID) {
    await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
    return;
  }
  const eventType = match[1];
  if (eventType in eventToggleState) {
    eventToggleState[eventType] = !eventToggleState[eventType];
    const status = eventToggleState[eventType] ? 'включены' : 'отключены';
    await sendTelegramMessageWithRetry(chatId, `Уведомления для события \`${eventType}\` теперь ${status}.`);
  } else {
    await sendTelegramMessageWithRetry(chatId, `Неизвестный тип события: \`${eventType}\`. Используйте /list_events для списка.`);
  }
});

// ===== Обработчик VK Callback =====
app.post('/webhook', async (req, res) => {
  const { type, object, group_id, secret } = req.body;
  console.log(`[${new Date().toISOString()}] Запрос VK. Тип: ${type}, Group ID: ${group_id}`);

  // Проверка секрета
  if (secret !== VK_SECRET_KEY) {
    console.warn(`[${new Date().toISOString()}] Неверный секрет: ${secret}. Ожидался: ${VK_SECRET_KEY}`);
    return res.status(403).send('Forbidden: Invalid secret key');
  }

  // Подтверждение: ты уже подтвердил адрес — отвечаем ok
  if (type === 'confirmation') {
    console.log(`[${new Date().toISOString()}] Получен confirmation — адрес уже подтвержден. Ответ ok.`);
    return res.send('ok');
  }

  // Игнорируем шум
  if (type === 'typing_status' || type === 'message_read') {
    console.log(`[${new Date().toISOString()}] Игнорируем: ${type}`);
    return res.send('ok');
  }

  // Выключенные события
  if (eventToggleState[type] === false) {
    console.log(`[${new Date().toISOString()}] Событие ${type} отключено. Игнорируем.`);
    return res.send('ok');
  }

  // Дедупликация
  const objectId =
    object?.id || object?.message?.id || object?.post?.id || object?.photo?.id ||
    object?.video?.id || object?.user_id || object?.comment?.id || object?.topic_id ||
    object?.poll_id || object?.item_id || object?.officer_id || object?.admin_id;

  const eventHash = crypto.createHash('md5').update(JSON.stringify({ type, objectId })).digest('hex');
  if (deduplicationCache.has(eventHash)) {
    console.log(`[${new Date().toISOString()}] Дубль. Тип: ${type}, Хеш: ${eventHash}`);
    return res.send('ok');
  }
  deduplicationCache.set(eventHash, true);
  console.log(`[${new Date().toISOString()}] Принято. Тип: ${type}, Хеш: ${eventHash}`);

  // Общие переменные для сообщения (НЕ переобъявляем внутри try)
  let telegramMessage = '';
  let parseMode = 'HTML';

  try {
    let userName = '';
    let authorDisplay = '';
    let ownerDisplay = '';
    let attachmentsInfo = '';

    switch (type) {
      case 'message_new': {
        const message = object.message;
        if (message) {
          userName = await getVkUserName(message.from_id);
          const senderDisplay = userName || `ID ${message.from_id}`;
          attachmentsInfo = await processAttachments(message.attachments, TELEGRAM_CHAT_ID, `Сообщение от ${senderDisplay}:`);
          telegramMessage = `💬 <b>Новое сообщение в VK:</b>\n<b>Отправитель:</b> <a href="https://vk.com/id${message.from_id}">${senderDisplay}</a>\n`;
          telegramMessage += message.text ? `<b>Сообщение:</b> <i>${escapeHtml(message.text)}</i>` : `<b>Сообщение:</b> <i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] message_new без object.message:`, object);
          telegramMessage = `💬 <b>Новое сообщение в VK:</b> (некорректный объект сообщения)`;
        }
        break;
      }

      case 'wall_post_new': {
        const post = object.post || object;
        if (post && post.owner_id && post.id) {
          const fromId = post.from_id || post.owner_id;
          const u = await getVkUserName(fromId);
          const author = u || `ID ${fromId}`;
          attachmentsInfo = await processAttachments(post.attachments, TELEGRAM_CHAT_ID, `Пост от ${author}:`);
          telegramMessage = `📝 <b>Новый пост на стене VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${fromId}">${author}</a>\n<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>\n`;
          telegramMessage += post.text ? `<i>${escapeHtml(post.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] wall_post_new без нужных полей:`, object);
          telegramMessage = `📝 <b>Новый пост на стене VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'wall_repost': {
        const repostObject = object.post || object;
        const originalPost = repostObject?.copy_history?.[0];
        if (repostObject && originalPost) {
          const fromId = repostObject.from_id || repostObject.owner_id;
          userName = await getVkUserName(fromId);
          authorDisplay = userName || `ID ${fromId}`;
          attachmentsInfo = await processAttachments(originalPost.attachments, TELEGRAM_CHAT_ID, `Репост от ${authorDisplay}:`);
          telegramMessage = `🔁 <b>Новый репост в VK:</b>\n<b>Репостнул:</b> <a href="https://vk.com/id${fromId}">${authorDisplay}</a>\n<a href="https://vk.com/wall${originalPost.owner_id}_${originalPost.id}">Оригинальный пост</a>\n`;
          if (originalPost.text) {
            const t = originalPost.text;
            telegramMessage += `<i>${escapeHtml(t.length > 200 ? t.substring(0, 200) + '...' : t)}</i>`;
          } else {
            telegramMessage += `<i>(без текста)</i>`;
          }
        } else {
          console.warn(`[${new Date().toISOString()}] wall_repost без оригинального поста:`, object);
          telegramMessage = `🔁 <b>Новый репост в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'wall_reply_new': {
        const wallComment = object;
        if (wallComment) {
          userName = await getVkUserName(wallComment.from_id);
          authorDisplay = userName || `ID ${wallComment.from_id}`;
          attachmentsInfo = await processAttachments(wallComment.attachments, TELEGRAM_CHAT_ID, `Комментарий к посту от ${authorDisplay}:`);
          telegramMessage = `💬 <b>Новый комментарий к посту в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${wallComment.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/wall${wallComment.owner_id}_${wallComment.post_id}?reply=${wallComment.id}">Ссылка на комментарий</a>\n`;
          telegramMessage += wallComment.text ? `<i>${escapeHtml(wallComment.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] wall_reply_new без object:`, object);
          telegramMessage = `💬 <b>Новый комментарий к посту в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'wall_reply_edit': {
        const c = object;
        if (c) {
          userName = await getVkUserName(c.from_id);
          authorDisplay = userName || `ID ${c.from_id}`;
          attachmentsInfo = await processAttachments(c.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к посту от ${authorDisplay}:`);
          telegramMessage = `✏️ <b>Комментарий к посту изменен в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/wall${c.owner_id}_${c.post_id}?reply=${c.id}">Ссылка на комментарий</a>\n`;
          telegramMessage += c.text ? `<i>${escapeHtml(c.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] wall_reply_edit без object:`, object);
          telegramMessage = `✏️ <b>Комментарий к посту изменен в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'wall_reply_delete': {
        const d = object;
        if (d?.deleter_id) {
          userName = await getVkUserName(d.deleter_id);
          const deleterDisplay = userName || `ID ${d.deleter_id}`;
          telegramMessage = `🗑️ <b>Комментарий к посту удален в VK:</b>\n<b>Удалил:</b> <a href="https://vk.com/id${d.deleter_id}">${deleterDisplay}</a>\n<b>Пост:</b> <a href="https://vk.com/wall${d.owner_id}_${d.post_id}">Пост</a>\nID комментария: <code>${d.id}</code>`;
        } else {
          console.warn(`[${new Date().toISOString()}] wall_reply_delete без deleter_id:`, object);
          telegramMessage = `🗑️ <b>Комментарий к посту удален в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'board_post_new': {
        const boardPost = object;
        if (boardPost) {
          userName = await getVkUserName(boardPost.from_id);
          authorDisplay = userName || `ID ${boardPost.from_id}`;
          attachmentsInfo = await processAttachments(boardPost.attachments, TELEGRAM_CHAT_ID, `Сообщение в обсуждении от ${authorDisplay}:`);
          telegramMessage = `💬 <b>Новое сообщение в обсуждении VK:</b>\n<b>Тема:</b> ${escapeHtml(boardPost.topic_title || 'Без названия')}\n<b>Автор:</b> <a href="https://vk.com/id${boardPost.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/topic-${boardPost.group_id}_${boardPost.topic_id}?post=${boardPost.id}">Ссылка на сообщение</a>\n`;
          telegramMessage += boardPost.text ? `<i>${escapeHtml(boardPost.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] board_post_new без object:`, object);
          telegramMessage = `💬 <b>Новое сообщение в обсуждении VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'board_post_edit': {
        const e = object;
        if (e) {
          userName = await getVkUserName(e.from_id);
          authorDisplay = userName || `ID ${e.from_id}`;
          attachmentsInfo = await processAttachments(e.attachments, TELEGRAM_CHAT_ID, `Измененное сообщение в обсуждении от ${authorDisplay}:`);
          telegramMessage = `✏️ <b>Сообщение в обсуждении изменено в VK:</b>\n<b>Тема:</b> ${escapeHtml(e.topic_title || 'Без названия')}\n<b>Автор:</b> <a href="https://vk.com/id${e.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/topic-${e.group_id}_${e.topic_id}?post=${e.id}">Ссылка на сообщение</a>\n`;
          telegramMessage += e.text ? `<i>${escapeHtml(e.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] board_post_edit без object:`, object);
          telegramMessage = `✏️ <b>Сообщение в обсуждении изменено в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'board_post_delete': {
        const bd = object;
        if (bd?.id) {
          telegramMessage = `🗑️ <b>Сообщение в обсуждении удалено в VK:</b>\n<b>Тема:</b> ID темы <code>${bd.topic_id}</code>\nID сообщения: <code>${bd.id}</code>`;
        } else {
          console.warn(`[${new Date().toISOString()}] board_post_delete без id:`, object);
          telegramMessage = `🗑️ <b>Сообщение в обсуждении удалено в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'photo_new': {
        const p = object.photo;
        if (p) {
          userName = await getVkUserName(p.owner_id);
          ownerDisplay = userName || `ID ${p.owner_id}`;
          const url = p.sizes?.find(s => s.type === 'x')?.url || p.sizes?.[p.sizes.length - 1]?.url;
          if (url) await sendTelegramMedia(TELEGRAM_CHAT_ID, 'photo', url, `Новое фото от ${ownerDisplay}:`);
          telegramMessage = `📸 <b>Новое фото в VK:</b>\n<b>Владелец:</b> <a href="https://vk.com/id${p.owner_id}">${ownerDisplay}</a>\n${url ? `<a href="${url}">Ссылка на фото</a>` : ''}`;
        } else {
          console.warn(`[${new Date().toISOString()}] photo_new без photo:`, object);
          telegramMessage = `📸 <b>Новое фото в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'photo_comment_new': {
        const c = object;
        if (c) {
          userName = await getVkUserName(c.from_id);
          authorDisplay = userName || `ID ${c.from_id}`;
          attachmentsInfo = await processAttachments(c.attachments, TELEGRAM_CHAT_ID, `Комментарий к фото от ${authorDisplay}:`);
          telegramMessage = `💬 <b>Новый комментарий к фото в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/photo${c.owner_id}_${c.photo_id}?reply=${c.id}">Ссылка на комментарий</a>\n`;
          telegramMessage += c.text ? `<i>${escapeHtml(c.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] photo_comment_new без object:`, object);
          telegramMessage = `💬 <b>Новый комментарий к фото в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'photo_comment_edit': {
        const c = object;
        if (c) {
          userName = await getVkUserName(c.from_id);
          authorDisplay = userName || `ID ${c.from_id}`;
          attachmentsInfo = await processAttachments(c.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к фото от ${authorDisplay}:`);
          telegramMessage = `✏️ <b>Комментарий к фото изменен в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/photo${c.owner_id}_${c.photo_id}?reply=${c.id}">Ссылка на комментарий</a>\n`;
          telegramMessage += c.text ? `<i>${escapeHtml(c.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] photo_comment_edit без object:`, object);
          telegramMessage = `✏️ <b>Комментарий к фото изменен в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'photo_comment_delete': {
        const d = object;
        if (d?.deleter_id) {
          userName = await getVkUserName(d.deleter_id);
          const deleterDisplay = userName || `ID ${d.deleter_id}`;
          telegramMessage = `🗑️ <b>Комментарий к фото удален в VK:</b>\n<b>Удалил:</b> <a href="https://vk.com/id${d.deleter_id}">${deleterDisplay}</a>\n<b>Фото:</b> ID фото <code>${d.photo_id}</code>\nID комментария: <code>${d.id}</code>`;
        } else {
          console.warn(`[${new Date().toISOString()}] photo_comment_delete без deleter_id:`, object);
          telegramMessage = `🗑️ <b>Комментарий к фото удален в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'video_new': {
        const v = object.video;
        if (v) {
          userName = await getVkUserName(v.owner_id);
          ownerDisplay = userName || `ID ${v.owner_id}`;
          let videoUrl = v.player;
          if (!videoUrl && v.owner_id && v.id) {
            try {
              const resp = await axios.get('https://api.vk.com/method/video.get', {
                params: { videos: `${v.owner_id}_${v.id}`, access_token: VK_SERVICE_KEY, v: '5.131' },
                timeout: 5000
              });
              const files = resp.data?.response?.items?.[0]?.files;
              if (files) videoUrl = files.mp4_1080 || files.mp4_720 || files.mp4_480 || files.mp4_360 || files.mp4_240;
            } catch (e) { console.error(`[${new Date().toISOString()}] video.get error:`, e.message); }
          }
          if (videoUrl) await sendTelegramMedia(TELEGRAM_CHAT_ID, 'video', videoUrl, `Новое видео от ${ownerDisplay}: ${escapeHtml(v.title || 'Без названия')}`);
          telegramMessage = `🎥 <b>Новое видео в VK:</b>\n<b>Владелец:</b> <a href="https://vk.com/id${v.owner_id}">${ownerDisplay}</a>\n<b>Название:</b> ${escapeHtml(v.title || 'Без названия')}\n<a href="https://vk.com/video${v.owner_id}_${v.id}">Ссылка на видео</a>`;
        } else {
          console.warn(`[${new Date().toISOString()}] video_new без video:`, object);
          telegramMessage = `🎥 <b>Новое видео в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'video_comment_new': {
        const c = object;
        if (c) {
          userName = await getVkUserName(c.from_id);
          authorDisplay = userName || `ID ${c.from_id}`;
          attachmentsInfo = await processAttachments(c.attachments, TELEGRAM_CHAT_ID, `Комментарий к видео от ${authorDisplay}:`);
          telegramMessage = `💬 <b>Новый комментарий к видео в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/video${c.owner_id}_${c.video_id}?reply=${c.id}">Ссылка на комментарий</a>\n`;
          telegramMessage += c.text ? `<i>${escapeHtml(c.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] video_comment_new без object:`, object);
          telegramMessage = `💬 <b>Новый комментарий к видео в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'video_comment_edit': {
        const c = object;
        if (c) {
          userName = await getVkUserName(c.from_id);
          authorDisplay = userName || `ID ${c.from_id}`;
          attachmentsInfo = await processAttachments(c.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к видео от ${authorDisplay}:`);
          telegramMessage = `✏️ <b>Комментарий к видео изменен в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${c.from_id}">${authorDisplay}</a>\n<a href="https://vk.com/video${c.owner_id}_${c.video_id}?reply=${c.id}">Ссылка на комментарий</a>\n`;
          telegramMessage += c.text ? `<i>${escapeHtml(c.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] video_comment_edit без object:`, object);
          telegramMessage = `✏️ <b>Комментарий к видео изменен в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'video_comment_delete': {
        const d = object;
        if (d?.deleter_id) {
          userName = await getVkUserName(d.deleter_id);
          const deleterDisplay = userName || `ID ${d.deleter_id}`;
          telegramMessage = `🗑️ <b>Комментарий к видео удален в VK:</b>\n<b>Удалил:</b> <a href="https://vk.com/id${d.deleter_id}">${deleterDisplay}</a>\n<b>Видео:</b> ID видео <code>${d.video_id}</code>\nID комментария: <code>${d.id}</code>`;
        } else {
          console.warn(`[${new Date().toISOString()}] video_comment_delete без deleter_id:`, object);
          telegramMessage = `🗑️ <b>Комментарий к видео удален в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'audio_new': {
        const a = object.audio;
        if (a) {
          userName = await getVkUserName(a.owner_id);
          ownerDisplay = userName || `ID ${a.owner_id}`;
          if (a.url) await sendTelegramMedia(TELEGRAM_CHAT_ID, 'audio', a.url, `Новая аудиозапись от ${ownerDisplay}: ${escapeHtml(a.artist || 'Неизвестный')} - ${escapeHtml(a.title || 'Без названия')}`);
          telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b>\n<b>Исполнитель:</b> ${escapeHtml(a.artist || 'Неизвестный')}\n<b>Название:</b> ${escapeHtml(a.title || 'Без названия')}\n<b>Добавил:</b> <a href="https://vk.com/id${a.owner_id}">${ownerDisplay}</a>`;
        } else {
          console.warn(`[${new Date().toISOString()}] audio_new без object:`, object);
          telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'market_order_new': {
        const order = object.order;
        if (order?.id) {
          userName = await getVkUserName(order.user_id);
          const userDisplay = userName || `ID ${order.user_id}`;
          telegramMessage = `🛒 <b>Новый заказ в VK Маркете:</b>\n<b>Заказ ID:</b> <code>${order.id}</code>\n<b>От:</b> <a href="https://vk.com/id${order.user_id}">${userDisplay}</a>\n<b>Сумма:</b> ${order.total_price?.amount / 100 || 'N/A'} ${order.total_price?.currency?.name || 'руб.'}\n<a href="https://vk.com/market?w=orders/view/${order.id}">Посмотреть заказ</a>`;
        } else {
          console.warn(`[${new Date().toISOString()}] market_order_new без order.id:`, object);
          telegramMessage = `🛒 <b>Новый заказ в VK Маркете:</b> (некорректный объект)`;
        }
        break;
      }

      case 'market_comment_new': {
        const mc = object;
        if (mc) {
          userName = await getVkUserName(mc.from_id);
          authorDisplay = userName || `ID ${mc.from_id}`;
          attachmentsInfo = await processAttachments(mc.attachments, TELEGRAM_CHAT_ID, `Комментарий к товару от ${authorDisplay}:`);
          telegramMessage = `💬 <b>Новый комментарий к товару в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${mc.from_id}">${authorDisplay}</a>\n<b>Товар:</b> ID товара <code>${mc.item_id}</code>\n`;
          telegramMessage += mc.text ? `<i>${escapeHtml(mc.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] market_comment_new без object:`, object);
          telegramMessage = `💬 <b>Новый комментарий к товару в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'message_reply': {
        const reply = object;
        if (reply?.text && reply.peer_id) {
          if (reply.text.includes('Новая заявка по форме')) {
            console.log('Пропущен авто-ответ бота о заявке');
            return res.send('ok');
          }
          const u = await getVkUserName(reply.from_id);
          const userDisplay = u || `ID ${reply.from_id}`;
          const msg = `↩️ <b>Ответ бота в сообщениях:</b>\n<b>От:</b> <a href="https://vk.com/id${reply.from_id}">${userDisplay}</a>\n<b>Сообщение:</b>\n<i>${escapeHtml(reply.text)}</i>`;
          await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' });
        }
        break;
      }

      case 'market_comment_edit': {
        const e = object;
        if (e) {
          userName = await getVkUserName(e.from_id);
          authorDisplay = userName || `ID ${e.from_id}`;
          attachmentsInfo = await processAttachments(e.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к товару от ${authorDisplay}:`);
          telegramMessage = `✏️ <b>Комментарий к товару изменен в VK:</b>\n<b>Автор:</b> <a href="https://vk.com/id${e.from_id}">${authorDisplay}</a>\n<b>Товар:</b> ID товара <code>${e.item_id}</code>\n`;
          telegramMessage += e.text ? `<i>${escapeHtml(e.text)}</i>` : `<i>(без текста)</i>`;
        } else {
          console.warn(`[${new Date().toISOString()}] market_comment_edit без object:`, object);
          telegramMessage = `✏️ <b>Комментарий к товару изменен в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'market_comment_delete': {
        const d = object;
        if (d?.deleter_id) {
          userName = await getVkUserName(d.deleter_id);
          const deleterDisplay = userName || `ID ${d.deleter_id}`;
          telegramMessage = `🗑️ <b>Комментарий к товару удален в VK:</b>\n<b>Удалил:</b> <a href="https://vk.com/id${d.deleter_id}">${deleterDisplay}</a>\n<b>Товар:</b> ID товара <code>${d.item_id}</code>\nID комментария: <code>${d.id}</code>`;
        } else {
          console.warn(`[${new Date().toISOString()}] market_comment_delete без deleter_id:`, object);
          telegramMessage = `🗑️ <b>Комментарий к товару удален в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'poll_vote_new': {
        const pv = object;
        if (pv?.user_id) {
          userName = await getVkUserName(pv.user_id);
          const userDisplay = userName || `ID ${pv.user_id}`;
          telegramMessage = `📊 <b>Новый голос в опросе VK:</b>\n<b>От:</b> <a href="https://vk.com/id${pv.user_id}">${userDisplay}</a>\n<b>Опрос ID:</b> <code>${pv.poll_id}</code>\n<b>Вариант:</b> <code>${pv.option_id}</code>`;
        } else {
          console.warn(`[${new Date().toISOString()}] poll_vote_new без user_id:`, object);
          telegramMessage = `📊 <b>Новый голос в опросе VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'group_join': {
        const j = object;
        if (j?.user_id) {
          userName = await getVkUserName(j.user_id);
          const joinUserDisplay = userName || `ID ${j.user_id}`;
          telegramMessage = `🎉 <b>Приветствуем нового участника!</b>\n✨ Присоединился(ась) <a href="https://vk.com/id${j.user_id}">${joinUserDisplay}</a>!`;
        } else {
          console.warn(`[${new Date().toISOString()}] group_join без user_id:`, object);
          telegramMessage = `🎉 <b>Приветствуем нового участника!</b> (некорректный объект)`;
        }
        break;
      }

      case 'group_leave': {
        const l = object;
        if (l?.user_id) {
          userName = await getVkUserName(l.user_id);
          const leaveUserDisplay = userName || `ID ${l.user_id}`;
          telegramMessage = `👋 <b>Пользователь покинул сообщество</b>\n${`<a href="https://vk.com/id${l.user_id}">${leaveUserDisplay}</a>`}`;
          // В лид-чат, если задан, иначе — в основной
          if (LEAD_CHAT_ID) {
            await sendTelegramMessageWithRetry(LEAD_CHAT_ID, telegramMessage, { parse_mode: parseMode });
            telegramMessage = ''; // чтобы ниже не дублировать в основной чат
          }
        } else {
          telegramMessage = `👋 <b>Пользователь покинул сообщество</b>`;
        }
        break;
      }

      case 'lead_forms_new': {
        const lf = object;
        if (lf?.lead_id && lf?.user_id) {
          try {
            const u = await getVkUserName(lf.user_id);
            const userDisplay = u || `ID ${lf.user_id}`;
            const fieldNames = { phone_number: 'Телефон', age: 'Возраст', custom_0: 'Имя', custom_1: 'Фамилия' };
            const now = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

            let msg = `🥳Новая заявка (${now})\n<b>Пользователь:</b> <a href="https://vk.com/id${lf.user_id}">${userDisplay}</a>\n`;
            if (Array.isArray(lf.answers) && lf.answers.length) {
              lf.answers.forEach(answer => {
                const fieldName = fieldNames[answer.key] || answer.key;
                const answerText = Array.isArray(answer.answer) ? answer.answer.join(', ') : answer.answer;
                msg += `<b>${escapeHtml(fieldName)}</b>: ${escapeHtml(answerText || '—')}\n`;
              });
            }
            if (LEAD_CHAT_ID) await sendTelegramMessageWithRetry(LEAD_CHAT_ID, msg, { parse_mode: 'HTML' });
          } catch (e) {
            console.error('Ошибка lead_forms_new:', e.message);
            if (LEAD_CHAT_ID) await sendTelegramMessageWithRetry(LEAD_CHAT_ID, `🥳Новая заявка!\nПользователь: ID ${lf.user_id}`, { parse_mode: 'HTML' });
          }
        }
        // Не отправляем в основной чат ниже
        telegramMessage = '';
        break;
      }

      case 'message_allow': {
        const ev = object;
        if (ev?.user_id) {
          const u = await getVkUserName(ev.user_id);
          const userDisplay = u || `ID ${ev.user_id}`;
          telegramMessage = `✅ <b>Пользователь разрешил сообщения:</b>\n<a href="https://vk.com/id${ev.user_id}">${userDisplay}</a>`;
        }
        break;
      }

      case 'message_deny': {
        const ev = object;
        if (ev?.user_id) {
          const u = await getVkUserName(ev.user_id);
          const userDisplay = u || `ID ${ev.user_id}`;
          telegramMessage = `❌ <b>Пользователь запретил сообщения:</b>\n<a href="https://vk.com/id${ev.user_id}">${userDisplay}</a>`;
        }
        break;
      }

      case 'group_change_photo': {
        const cp = object;
        if (cp?.user_id) {
          const u = await getVkUserName(cp.user_id);
          const userDisplay = u || `ID ${cp.user_id}`;
          telegramMessage = `🖼️ <b>Изменена главная фотография сообщества VK:</b>\n<b>Изменил:</b> <a href="https://vk.com/id${cp.user_id}">${userDisplay}</a>`;
        } else {
          telegramMessage = `🖼️ <b>Изменена главная фотография сообщества VK</b>`;
        }
        break;
      }

      case 'group_change_settings': {
        const cs = object;
        if (cs?.user_id) {
          const u = await getVkUserName(cs.user_id);
          const userDisplay = u || `ID ${cs.user_id}`;
          const firstField = cs.changes ? cs.changes[Object.keys(cs.changes)[0]]?.field : 'Неизвестно';
          telegramMessage = `⚙️ <b>Изменены настройки сообщества VK:</b>\n<b>Изменил:</b> <a href="https://vk.com/id${cs.user_id}">${userDisplay}</a>\n<b>Настройка:</b> <code>${escapeHtml(firstField)}</code>`;
        } else {
          telegramMessage = `⚙️ <b>Изменены настройки сообщества VK</b>`;
        }
        break;
      }

      case 'group_officers_edit': {
        const oe = object;
        if (oe?.admin_id && oe?.user_id) {
          const adminName = await getVkUserName(oe.admin_id);
          const adminDisplay = adminName || `ID ${oe.admin_id}`;
          const targetUserName = await getVkUserName(oe.user_id);
          const targetDisplay = targetUserName || `ID ${oe.user_id}`;

          if (oe.level_old === 0 && oe.level_new > 0) {
            telegramMessage = `👑 <b>Назначен руководитель в VK:</b>\n<b>Назначил:</b> <a href="https://vk.com/id${oe.admin_id}">${adminDisplay}</a>\n<b>Назначен:</b> <a href="https://vk.com/id${oe.user_id}">${targetDisplay}</a> (Уровень: ${oe.level_new})`;
          } else if (oe.level_old > 0 && oe.level_new === 0) {
            telegramMessage = `🚫 <b>Руководитель снят в VK:</b>\n<b>Снял:</b> <a href="https://vk.com/id${oe.admin_id}">${adminDisplay}</a>\n<b>Снят:</b> <a href="https://vk.com/id${oe.user_id}">${targetDisplay}</a>`;
          } else if (oe.level_old > 0 && oe.level_new > 0) {
            telegramMessage = `🔄 <b>Уровень руководителя изменен в VK:</b>\n<b>Изменил:</b> <a href="https://vk.com/id${oe.admin_id}">${adminDisplay}</a>\n<b>Пользователь:</b> <a href="https://vk.com/id${oe.user_id}">${targetDisplay}</a> (С ${oe.level_old} на ${oe.level_new})`;
          }
        } else {
          telegramMessage = `👑 <b>Изменение руководителей сообщества VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'user_block': {
        const ub = object;
        if (ub?.user_id && ub?.admin_id) {
          const blocked = await getVkUserName(ub.user_id);
          const admin = await getVkUserName(ub.admin_id);
          telegramMessage = `⛔ <b>Пользователь заблокирован в VK:</b>\n<b>Пользователь:</b> <a href="https://vk.com/id${ub.user_id}">${blocked || `ID ${ub.user_id}`}</a>\n<b>Заблокировал:</b> <a href="https://vk.com/id${ub.admin_id}">${admin || `ID ${ub.admin_id}`}</a>\n<b>Причина:</b> ${escapeHtml(ub.reason_text || 'Не указана')}`;
        } else {
          telegramMessage = `⛔ <b>Пользователь заблокирован в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'user_unblock': {
        const uu = object;
        if (uu?.user_id && uu?.admin_id) {
          const u1 = await getVkUserName(uu.user_id);
          const u2 = await getVkUserName(uu.admin_id);
          telegramMessage = `✅ <b>Пользователь разблокирован в VK:</b>\n<b>Пользователь:</b> <a href="https://vk.com/id${uu.user_id}">${u1 || `ID ${uu.user_id}`}</a>\n<b>Разблокировал:</b> <a href="https://vk.com/id${uu.admin_id}">${u2 || `ID ${uu.admin_id}`}</a>`;
        } else {
          telegramMessage = `✅ <b>Пользователь разблокирован в VK:</b> (некорректный объект)`;
        }
        break;
      }

      case 'like_add':
      case 'like_remove': {
        const isAdd = type === 'like_add';
        const likeObject = object;

        if (likeObject?.liker_id && likeObject?.object_type && likeObject?.object_id) {
          let ownerId = likeObject.owner_id;
          if (!ownerId) {
            ownerId = -group_id;
            console.warn(`[${new Date().toISOString()}] owner_id отсутствует в '${type}', используем ID группы: ${ownerId}`);
          }
          const objectLink = getObjectLinkForLike(ownerId, likeObject.object_type, likeObject.object_id, likeObject.post_id);
          const label = getObjectTypeDisplayName(likeObject.object_type);

          let likerDisplay;
          try {
            const u = await getVkUserName(likeObject.liker_id);
            likerDisplay = u || `ID ${likeObject.liker_id}`;
          } catch (e) {
            console.error(`[${new Date().toISOString()}] Ошибка имени лайкера:`, e.message);
            likerDisplay = `ID ${likeObject.liker_id} (ошибка получения имени)`;
          }

          let likesCountText = '';
          try {
            const count = await getVkLikesCount(ownerId, likeObject.object_id, likeObject.object_type);
            if (count === -1) likesCountText = ' (⚠️ Ошибка получения лайков)';
            else if (count !== null) likesCountText = ` (Всего: ${count})`;
          } catch (e) {
            console.error(`[${new Date().toISOString()}] Ошибка подсчёта лайков:`, e.message);
            likesCountText = ' (⚠️ Ошибка получения лайков)';
          }

          telegramMessage = `<b>${isAdd ? '❤️ Новый лайк в VK' : '💔 Лайк удален в VK'}</b>\n<b>От:</b> <a href="https://vk.com/id${likeObject.liker_id}">${likerDisplay}</a>\n<b>${isAdd ? 'К' : 'С'}:</b> `;
          telegramMessage += objectLink ? `<a href="${objectLink}">${label}</a>` : `${label} ID <code>${likeObject.object_id}</code>`;
          telegramMessage += likesCountText;
        } else {
          console.warn(`[${new Date().toISOString()}] '${type}' без нужных полей:`, likeObject);
          telegramMessage = `<b>${isAdd ? '❤️ Новый лайк в VK' : '💔 Лайк удален в VK'}:</b> (некорректный объект)`;
        }
        break;
      }

      default:
        console.log(`[${new Date().toISOString()}] Необработанный тип события VK: ${type}.`, JSON.stringify(object));
        telegramMessage = `❓ <b>Неизвестное событие VK:</b>\nТип: <code>${escapeHtml(type)}</code>\n<pre>${escapeHtml(JSON.stringify(object, null, 2).substring(0, 1000) + (JSON.stringify(object, null, 2).length > 1000 ? '...' : ''))}</pre>`;
    }

    // Отправляем в основной чат, кроме lead_forms_new (он отправляется в LEAD_CHAT_ID выше)
    if (telegramMessage && type !== 'lead_forms_new') {
      await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, telegramMessage, { parse_mode: parseMode });
      console.log(`[${new Date().toISOString()}] Сообщение отправлено. Тип события: ${type}`);
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Критическая ошибка обработки ${type}:`, error.response ? error.response.data : error.message);
    try {
      await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID,
        `❌ <b>Критическая ошибка при обработке события VK:</b>\nТип: <code>${escapeHtml(type)}</code>\nСообщение: ${escapeHtml(error.message || 'Неизвестная ошибка')}\n\nПроверьте логи Railway.`,
        { parse_mode: 'HTML' }
      );
    } catch (telegramError) {
      console.error(`[${new Date().toISOString()}] Ошибка уведомления об ошибке в Telegram:`, telegramError.message);
    }
  }

  res.send('ok');
});

// ===== Запуск сервера =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Сервер запущен на порту ${PORT}`);
  bot.setMyCommands([
    { command: 'status', description: 'Проверить статус бота' },
    { command: 'help', description: 'Показать список команд' },
    { command: 'my_chat_id', description: 'Узнать ID текущего чата' },
    { command: 'test_notification', description: 'Отправить тестовое уведомление' },
    { command: 'list_events', description: 'Показать статус событий VK' },
    { command: 'toggle_event', description: 'Включить/отключить событие' }
  ]).then(() => {
    console.log(`[${new Date().toISOString()}] Команды Telegram бота установлены.`);
  }).catch(e => {
    console.error(`[${new Date().toISOString()}] Ошибка установки команд Telegram:`, e.message);
  });
});
