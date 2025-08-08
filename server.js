// server.js - Основной файл сервера для обработки VK Callback API и пересылки в Telegram

// Импорт необходимых модулей
const express = require('express'); // Веб-фреймворк для Node.js
const bodyParser = require('body-parser'); // Для парсинга JSON-запросов
const axios = require('axios'); // Для выполнения HTTP-запросов (к Telegram API, VK API и скачивания медиа)
const crypto = require('crypto'); // Для хеширования, используется для дедупликации
const NodeCache = require('node-cache'); // Для in-memory кэша дедупликации
const TelegramBot = require('node-telegram-bot-api'); // Для работы с Telegram Bot API

// Инициализация Express приложения
const app = express();
// Использование body-parser для обработки JSON-тела запросов
app.use(bodyParser.json());

// Получение переменных окружения
// Эти переменные будут установлены на Railway
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_SECRET_KEY = process.env.VK_SECRET_KEY;
const VK_SERVICE_KEY = process.env.VK_SERVICE_KEY; // <-- Используем сервисный ключ доступа
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Основной чат для пересылки событий

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные (VK_GROUP_ID, VK_SECRET_KEY, VK_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) установлены.');
    process.exit(1); // Завершаем процесс, если переменные не установлены
}

// Инициализация Telegram бота
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true }); // Включаем polling для приема команд

// Инициализация кэша для дедупликации (TTL 60 секунд)
// Внимание: Этот кэш является in-memory и будет сброшен при каждом перезапуске контейнера на Railway.
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Временное хранилище для настроек событий (не сохраняется при перезапусках Railway)
const eventToggleState = {
    'message_new': true,
    'message_reply': true, // Добавляем обработку message_reply
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
    'lead_forms_new': true, // Добавляем обработку нового события
};

// Вспомогательная функция для экранирования HTML-сущностей
function escapeHtml(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    return text
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}

// Функция для получения имени пользователя VK по ID
async function getVkUserName(userId) {
    if (!userId) return null; // Если userId не предоставлен, возвращаем null
    try {
        const response = await axios.get(`https://api.vk.com/method/users.get`, {
            params: {
                user_ids: userId,
                access_token: VK_SERVICE_KEY,
                v: '5.131' // Актуальная версия VK API
            },
            timeout: 5000 // Таймаут 5 секунд для запроса к VK API
        });

        if (response.data && response.data.response && response.data.response.length > 0) {
            const user = response.data.response[0];
            return `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
        }
        return null; // Возвращаем null, если имя не найдено
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении имени пользователя VK (ID: ${userId}):`, error.response ? error.response.data : error.message);
        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ Ошибка при получении имени пользователя VK (ID: ${userId}): ${escapeHtml(error.message || 'Неизвестная ошибка')}. Событие будет отправлено с ID.`, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (telegramError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке уведомления об ошибке в Telegram:`, telegramError.message);
        }
        return null; // Возвращаем null при ошибке
    }
}

// Функция для получения общего количества лайков для объекта VK
async function getVkLikesCount(ownerId, itemId, itemType) {
    try {
        const response = await axios.get(`https://api.vk.com/method/likes.getList`, {
            params: {
                type: itemType, // 'post', 'photo', 'video', 'comment', 'topic', 'market'
                owner_id: ownerId,
                item_id: itemId,
                access_token: VK_SERVICE_KEY,
                v: '5.131'
            },
            timeout: 5000 // Таймаут 5 секунд
        });
        
        if (response.data && response.data.response && response.data.response.count !== undefined) {
            return response.data.response.count;
        }
        console.warn(`[${new Date().toISOString()}] VK API не вернул количество лайков. Ответ:`, response.data);
        return null; // Возвращаем null, если количество не найдено
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении количества лайков для объекта ${itemType}:${ownerId}_${itemId}:`, error.response ? error.response.data : error.message);
        return null; // Возвращаем null при ошибке
    }
}


// Функция для отправки сообщения в Telegram с логикой повтора
async function sendTelegramMessageWithRetry(chatId, text, options = {}) {
    let sent = false;
    for (let i = 0; i < 3; i++) { // Повторить до 3 раз
        try {
            await bot.sendMessage(chatId, text, { ...options, disable_web_page_preview: true });
            sent = true;
            break;
        } catch (telegramSendError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке сообщения в Telegram (попытка ${i + 1}):`, telegramSendError.response ? telegramSendError.response.data : telegramSendError.message);
            if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Экспоненциальная задержка
        }
    }
    if (!sent) {
        console.error(`[${new Date().toISOString()}] Не удалось отправить сообщение в Telegram после нескольких попыток.`);
    }
}

// Функция для отправки мультимедиа в Telegram
async function sendTelegramMedia(chatId, type, fileUrl, caption, options = {}) {
    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 10000 }); // Таймаут 10 секунд для скачивания медиа
        const fileBuffer = Buffer.from(response.data);

        let sent = false;
        for (let i = 0; i < 3; i++) { // Повторить до 3 раз
            try {
                switch (type) {
                    case 'photo':
                        await bot.sendPhoto(chatId, fileBuffer, { caption: caption, parse_mode: 'HTML', ...options });
                        break;
                    case 'video':
                        await bot.sendVideo(chatId, fileBuffer, { caption: caption, parse_mode: 'HTML', ...options });
                        break;
                    case 'audio':
                        await bot.sendAudio(chatId, fileBuffer, { caption: caption, parse_mode: 'HTML', ...options });
                        break;
                    case 'document':
                        await bot.sendDocument(chatId, fileBuffer, { caption: caption, parse_mode: 'HTML', ...options });
                        break;
                    default:
                        console.warn(`[${new Date().toISOString()}] Неподдерживаемый тип медиа для прямой отправки: ${type}`);
                        return; // Выходим, если тип не поддерживается
                }
                sent = true;
                console.log(`[${new Date().toISOString()}] Мультимедиа (${type}) успешно отправлено в Telegram. Попытка: ${i + 1}`);
                break;
            } catch (mediaSendError) {
                console.error(`[${new Date().toISOString()}] Ошибка при отправке мультимедиа (${type}) в Telegram (попытка ${i + 1}):`, mediaSendError.response ? mediaSendError.response.data : mediaSendError.message);
                if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
        if (!sent) {
            console.error(`[${new Date().toISOString()}] Не удалось отправить мультимедиа (${type}) в Telegram после нескольких попыток.`);
            await sendTelegramMessageWithRetry(chatId, `⚠️ Не удалось отправить мультимедиа (${type}) в Telegram. Возможно, файл слишком большой или возникла временная ошибка.`, { parse_mode: 'HTML' });
        }
    } catch (downloadError) {
        console.error(`[${new Date().toISOString()}] Ошибка при скачивании мультимедиа с VK URL (${fileUrl}):`, downloadError.message);
        await sendTelegramMessageWithRetry(chatId, `⚠️ Ошибка при скачивании мультимедиа с VK: ${escapeHtml(downloadError.message)}. Возможно, ссылка устарела или недоступна.`, { parse_mode: 'HTML' });
    }
}


// Функция для обработки вложений (фото, видео, аудио, документы)
async function processAttachments(attachments, chatId, captionPrefix = '') {
    let attachmentsSummary = '';
    if (!attachments || attachments.length === 0) {
        return attachmentsSummary;
    }

    for (const attach of attachments) {
        let sentDirectly = false;
        let fallbackLink = '';
        let mediaCaption = '';

        switch (attach.type) {
            case 'photo':
                const photo = attach.photo;
                const photoUrl = photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url;
                if (photoUrl) {
                    mediaCaption = `${captionPrefix} Фото: ${escapeHtml(photo.text || '')}`;
                    await sendTelegramMedia(chatId, 'photo', photoUrl, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = photoUrl;
                }
                if (!sentDirectly) {
                    attachmentsSummary += `📸 <a href="${fallbackLink || 'javascript:void(0)'}">Фото</a>`;
                    if (photo.text) attachmentsSummary += ` <i>(${escapeHtml(photo.text)})</i>`;
                    attachmentsSummary += '\n';
                }
                break;
            case 'video':
                const video = attach.video;
                let directVideoUrl = null;
                if (video.owner_id && video.id) {
                    try {
                        const videoResp = await axios.get(`https://api.vk.com/method/video.get`, {
                            params: {
                                videos: `${video.owner_id}_${video.id}`,
                                access_token: VK_SERVICE_KEY,
                                v: '5.131'
                            },
                            timeout: 5000
                        });
                        if (videoResp.data?.response?.items?.[0]?.files) {
                            directVideoUrl = videoResp.data.response.items[0].files.mp4_1080 ||
                                             videoResp.data.response.items[0].files.mp4_720 ||
                                             videoResp.data.response.items[0].files.mp4_480 ||
                                             videoResp.data.response.items[0].files.mp4_360 ||
                                             videoResp.data.response.items[0].files.mp4_240;
                        }
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] Ошибка при получении URL видео через VK API:`, error.message);
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
                if (!sentDirectly) {
                    attachmentsSummary += `🎥 <a href="${fallbackLink || 'javascript:void(0)'}">Видео: ${escapeHtml(video.title || 'Без названия')}</a>`;
                    attachmentsSummary += ` (прямая отправка недоступна)`;
                    attachmentsSummary += '\n';
                }
                break;
            case 'audio':
                const audio = attach.audio;
                if (audio.url) {
                    mediaCaption = `${captionPrefix} Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}`;
                    await sendTelegramMedia(chatId, 'audio', audio.url, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = audio.url;
                }
                if (!sentDirectly) {
                    attachmentsSummary += `🎵 <a href="${fallbackLink || 'javascript:void(0)'}">Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}</a>\n`;
                }
                break;
            case 'doc':
                const doc = attach.doc;
                if (doc.url) {
                    mediaCaption = `${captionPrefix} Документ: ${escapeHtml(doc.title || 'Без названия')}`;
                    await sendTelegramMedia(chatId, 'document', doc.url, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = doc.url;
                }
                if (!sentDirectly) {
                    attachmentsSummary += `📄 <a href="${fallbackLink || 'javascript:void(0)'}">Документ: ${escapeHtml(doc.title || 'Без названия')}</a>\n`;
                }
                break;
            case 'link':
                const link = attach.link;
                if (link.url) {
                    attachmentsSummary += `🔗 <a href="${link.url}">${escapeHtml(link.title || 'Ссылка')}</a>\n`;
                }
                break;
            case 'poll':
                const poll = attach.poll;
                if (poll.id) {
                    attachmentsSummary += `📊 Опрос: ${escapeHtml(poll.question || 'Без вопроса')}\n`;
                }
                break;
            case 'wall': // Вложенный пост
                const wallPost = attach.wall;
                if (wallPost.owner_id && wallPost.id) {
                    attachmentsSummary += `📝 Вложенный пост: <a href="https://vk.com/wall${wallPost.owner_id}_${wallPost.id}">Ссылка</a>\n`;
                }
                break;
            case 'graffiti':
                const graffiti = attach.graffiti;
                if (graffiti && graffiti.url) {
                    mediaCaption = `${captionPrefix} Граффити`;
                    await sendTelegramMedia(chatId, 'photo', graffiti.url, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = graffiti.url;
                }
                if (!sentDirectly) {
                    attachmentsSummary += `🎨 <a href="${fallbackLink || 'javascript:void(0)'}">Граффити</a>\n`;
                }
                break;
            case 'sticker':
                const sticker = attach.sticker;
                if (sticker && sticker.images_with_background && sticker.images_with_background.length > 0) {
                    const stickerUrl = sticker.images_with_background[sticker.images_with_background.length - 1].url;
                    mediaCaption = `${captionPrefix} Стикер`;
                    await sendTelegramMedia(chatId, 'photo', stickerUrl, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = stickerUrl;
                }
                if (!sentDirectly) {
                    attachmentsSummary += `🖼️ <a href="${fallbackLink || 'javascript:void(0)'}">Стикер</a>\n`;
                }
                break;
            case 'gift':
                const gift = attach.gift;
                if (gift && gift.thumb_256) {
                    mediaCaption = `${captionPrefix} Подарок`;
                    await sendTelegramMedia(chatId, 'photo', gift.thumb_256, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = gift.thumb_256;
                }
                if (!sentDirectly) {
                    attachmentsSummary += `🎁 <a href="${fallbackLink || 'javascript:void(0)'}">Подарок</a>\n`;
                }
                break;
            default:
                console.log(`[${new Date().toISOString()}] Неизвестное или необработанное вложение: ${attach.type}`, attach);
                attachmentsSummary += `❓ Неизвестное вложение: ${attach.type}\n`;
                break;
        }
    }
    return attachmentsSummary;
}

// Helper for object type names for likes
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

// Helper to construct VK object links for likes
function getObjectLinkForLike(ownerId, objectType, objectId, postId) {
    if (objectType === 'comment' && postId) {
        return `https://vk.com/wall${ownerId}_${postId}?reply=${objectId}`;
    }
    switch (objectType) {
        case 'post': return `https://vk.com/wall${ownerId}_${objectId}`;
        case 'photo': return `https://vk.com/photo${ownerId}_${objectId}`;
        case 'video': return `https://vk.com/video${ownerId}_${objectId}`;
        case 'comment': return `https://vk.com/id${ownerId}?w=wall${ownerId}_${objectId}`;
        case 'topic': return `https://vk.com/topic-${VK_GROUP_ID}_${objectId}`;
        case 'market': return `https://vk.com/market-${ownerId}?w=product-${ownerId}_${objectId}`;
        default: return null;
    }
}

// --- Обработчики команд Telegram ---
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
/list_events - Показать список событий VK и их статус (вкл/выкл).
/toggle_event <тип_события> - Включить/отключить уведомления для конкретного типа события.
_Пример: /toggle_event message_new_
_Внимание: Настройки событий не сохраняются после перезапуска бота!_
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
    await sendTelegramMessageWithRetry(chatId, '🔔 Тестовое уведомление от бота успешно отправлено.');
});

bot.onText(/\/list_events/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== TELEGRAM_CHAT_ID) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
        return;
    }
    let statusMessage = '<b>Статус событий VK:</b>\n';
    for (const event in eventToggleState) {
        statusMessage += `${event}: ${eventToggleState[event] ? '✅ Включено' : '❌ Отключено'}\n`;
    }
    await sendTelegramMessageWithRetry(chatId, statusMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/toggle_event (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const eventType = match[1];
    if (String(chatId) !== TELEGRAM_CHAT_ID) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
        return;
    }
    if (eventToggleState.hasOwnProperty(eventType)) {
        eventToggleState[eventType] = !eventToggleState[eventType];
        await sendTelegramMessageWithRetry(chatId, `Статус события <b>${escapeHtml(eventType)}</b> изменен на: <b>${eventToggleState[eventType] ? 'Включено' : 'Отключено'}</b>`, { parse_mode: 'HTML' });
    } else {
        await sendTelegramMessageWithRetry(chatId, `⚠️ Неизвестный тип события: <b>${escapeHtml(eventType)}</b>`, { parse_mode: 'HTML' });
    }
});

// --- Обработка событий VK Callback API ---
app.post('/', async (req, res) => {
    const body = req.body;
    const { type, object, group_id, secret } = body;

    console.log(`[${new Date().toISOString()}] Получен запрос от VK. Тип: ${type}, Group ID: ${group_id}`);

    // Проверка Secret Key
    if (secret && secret !== VK_SECRET_KEY) {
        console.error(`[${new Date().toISOString()}] Ошибка авторизации: Неверный Secret Key!`);
        return res.status(403).send('error: secret key mismatch');
    }

    // Проверка Group ID
    if (String(group_id) !== VK_GROUP_ID) {
        console.error(`[${new Date().toISOString()}] Ошибка Group ID: Ожидался ${VK_GROUP_ID}, получен ${group_id}`);
        return res.status(403).send('error: group id mismatch');
    }

    // Проверка типа события
    if (type === 'confirmation') {
        if (!process.env.VK_CONFIRMATION_TOKEN) {
            console.error(`[${new Date().toISOString()}] Ошибка: Отсутствует переменная VK_CONFIRMATION_TOKEN.`);
            return res.status(500).send('error: confirmation token not set');
        }
        console.log(`[${new Date().toISOString()}] Получен запрос на подтверждение. Отправляем: ${process.env.VK_CONFIRMATION_TOKEN}`);
        return res.send(process.env.VK_CONFIRMATION_TOKEN);
    }
    
    // Дедупликация событий
    const eventHash = crypto.createHash('md5').update(JSON.stringify(body)).digest('hex');
    if (deduplicationCache.has(eventHash)) {
        console.log(`[${new Date().toISOString()}] Дублирующееся событие получено и проигнорировано: Тип: ${type}, Хеш: ${eventHash}`);
        return res.send('ok'); // Отправляем 'ok' для VK, чтобы не было повторных отправок
    }
    deduplicationCache.set(eventHash, true);
    
    if (!eventToggleState[type]) {
        console.log(`[${new Date().toISOString()}] Событие типа ${type} отключено. Игнорируем.`);
        return res.send('ok');
    }

    try {
        let messageText = '';
        let attachmentsSummary = '';
        let telegramMediaSent = false;
        let postLink = null;
        let objectOwnerId = null;
        let objectId = null;

        switch (type) {
            case 'wall_post_new':
            case 'wall_repost':
                const post = object;
                const postText = post.text || '<i>(Без текста)</i>';
                const postUser = post.signer_id ? await getVkUserName(post.signer_id) : null;
                const postOwner = post.owner_id ? await getVkUserName(post.owner_id) : 'Сообщество';
                postLink = `https://vk.com/wall${post.owner_id}_${post.id}`;
                
                messageText = type === 'wall_post_new' 
                    ? `📝 *Новый пост на стене* от ${postUser ? `<b>${postUser}</b> ` : ''}в <b>${escapeHtml(postOwner)}</b>:\n\n${escapeHtml(postText)}\n\n<a href="${postLink}">Перейти к посту</a>`
                    : `🔁 *Новый репост* от ${postUser ? `<b>${postUser}</b> ` : ''}в <b>${escapeHtml(postOwner)}</b>:\n\n${escapeHtml(postText)}\n\n<a href="${postLink}">Перейти к посту</a>`;
                
                if (post.attachments && post.attachments.length > 0) {
                    attachmentsSummary = await processAttachments(post.attachments, TELEGRAM_CHAT_ID, `📝 Новый пост/репост: `);
                    telegramMediaSent = attachmentsSummary !== ''; // Учитываем, если отправлено медиа
                }
                break;

            case 'video_new':
                const video = object;
                const videoUser = video.owner_id > 0 ? await getVkUserName(video.owner_id) : 'Сообщество';
                const videoLink = `https://vk.com/video${video.owner_id}_${video.id}`;
                messageText = `🎥 *Новое видео* от <b>${escapeHtml(videoUser)}</b>:\n\n<b>${escapeHtml(video.title || 'Без названия')}</b>\n\n${escapeHtml(video.description || '')}\n\n<a href="${videoLink}">Смотреть видео</a>`;
                
                // Пытаемся отправить видео напрямую, если доступна прямая ссылка
                let directVideoUrl = null;
                if (video.owner_id && video.id) {
                    try {
                        const videoResp = await axios.get(`https://api.vk.com/method/video.get`, {
                            params: {
                                videos: `${video.owner_id}_${video.id}`,
                                access_token: VK_SERVICE_KEY,
                                v: '5.131'
                            },
                            timeout: 5000
                        });
                        if (videoResp.data?.response?.items?.[0]?.files) {
                            directVideoUrl = videoResp.data.response.items[0].files.mp4_1080 ||
                                             videoResp.data.response.items[0].files.mp4_720 ||
                                             videoResp.data.response.items[0].files.mp4_480 ||
                                             videoResp.data.response.items[0].files.mp4_360 ||
                                             videoResp.data.response.items[0].files.mp4_240;
                        }
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] Ошибка при получении URL видео через VK API:`, error.message);
                    }
                }
                if (directVideoUrl) {
                    await sendTelegramMedia(TELEGRAM_CHAT_ID, 'video', directVideoUrl, messageText);
                    telegramMediaSent = true;
                }
                break;

            case 'like_add':
            case 'like_remove':
                const like = object;
                const likeOwnerId = like.object_owner_id;
                const likeObjectId = like.object_id;
                const likePostId = like.post_id; // Поле post_id для комментариев
                const likeType = like.object_type;
                const likeUserId = like.liker_id;
                
                const likerName = await getVkUserName(likeUserId);
                const objectLink = getObjectLinkForLike(likeOwnerId, likeType, likeObjectId, likePostId);
                const objectDisplayName = getObjectTypeDisplayName(likeType);
                
                let likesCount = null;
                if (type === 'like_add') {
                    likesCount = await getVkLikesCount(likeOwnerId, likeObjectId, likeType);
                }

                messageText = type === 'like_add' 
                    ? `👍 *Новый лайк*${likerName ? ` от <b>${likerName}</b>` : ''} на ${objectDisplayName}.`
                    : `👎 *Лайк удален*${likerName ? ` от <b>${likerName}</b>` : ''} с ${objectDisplayName}.`;
                
                if (likesCount !== null) {
                    messageText += `\n\nВсего лайков: <b>${likesCount}</b>.`;
                }

                if (objectLink) {
                    messageText += `\n<a href="${objectLink}">Перейти к объекту</a>`;
                } else {
                    messageText += `\nID объекта: <code>${likeOwnerId}_${likeObjectId}</code>`;
                }
                break;
            
            case 'lead_forms_new':
                const lead = object;
                const formName = escapeHtml(lead.form_name || 'Неизвестная форма');
                const formUser = await getVkUserName(lead.user_id);
                const formLink = `https://vk.com/club${lead.group_id}?w=app6013442_-${lead.group_id}`;

                let answersText = '';
                if (lead.answers && lead.answers.length > 0) {
                    answersText = lead.answers.map(ans => {
                        return `<b>${escapeHtml(ans.question || 'Вопрос')}:</b> ${escapeHtml(ans.answer || 'Без ответа')}`;
                    }).join('\n');
                }

                messageText = `📝 *Новая заявка* по форме "${formName}"\n\n` +
                              `<b>Пользователь:</b> ${formUser ? `<a href="https://vk.com/id${lead.user_id}">${formUser}</a>` : `<a href="https://vk.com/id${lead.user_id}">Пользователь #${lead.user_id}</a>`}\n\n` +
                              `${answersText}\n\n` +
                              `<a href="${formLink}">Перейти к форме</a>`;
                break;

            case 'message_reply':
                const messageReply = object;
                const senderName = await getVkUserName(messageReply.from_id);
                const messageLink = `https://vk.com/gim${VK_GROUP_ID}?sel=${messageReply.peer_id}`;
                
                messageText = `💬 *Новый ответ в беседе*\n\n` +
                              `<b>От:</b> ${senderName ? `<b>${senderName}</b>` : 'Неизвестный пользователь'}\n\n` +
                              `${escapeHtml(messageReply.text)}\n\n` +
                              `<a href="${messageLink}">Перейти к беседе</a>`;
                
                if (messageReply.attachments && messageReply.attachments.length > 0) {
                    attachmentsSummary = await processAttachments(messageReply.attachments, TELEGRAM_CHAT_ID, `💬 Новый ответ: `);
                    telegramMediaSent = attachmentsSummary !== '';
                }
                break;

            default:
                console.log(`[${new Date().toISOString()}] Неизвестное или необработанное событие VK:`, body);
                messageText = `❓ *Неизвестное или необработанное событие VK:*\n\nТип: <code>${escapeHtml(type)}</code>\n\n<pre>${escapeHtml(JSON.stringify(object, null, 2))}</pre>`;
                break;
        }

        // Если медиа не было отправлено напрямую, отправляем текстовое сообщение
        if (messageText && !telegramMediaSent) {
            await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, messageText, { parse_mode: 'HTML' });
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Критическая ошибка при обработке события VK: Тип: ${type}, Ошибка:`, error);
        try {
            // Отправка критического уведомления в Telegram с указанием типа ошибки
            await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, `❌ <b>Критическая ошибка при обработке события VK:</b>\nТип: <code>${escapeHtml(type)}</code>\nСообщение: ${escapeHtml(error.message || 'Неизвестная ошибка')}\n\nПроверьте логи Railway для деталей.`, { parse_mode: 'HTML' });
        } catch (telegramError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке критического уведомления об ошибке в Telegram:`, telegramError.message);
        }
    }

    res.send('ok');
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Сервер VK-Telegram бота запущен на порту ${PORT}`);
    // Устанавливаем команды для Telegram бота при запуске
    bot.setMyCommands([
        { command: 'status', description: 'Проверить статус бота' },
        { command: 'help', description: 'Показать список команд' },
        { command: 'my_chat_id', description: 'Узнать ID текущего чата' },
        { command: 'test_notification', description: 'Отправить тестовое уведомление' },
        { command: 'list_events', description: 'Показать статус событий VK' },
        { command: 'toggle_event', description: 'Включить/отключить событие' }
    ]).then(() => {
        console.log(`[${new Date().toISOString()}] Команды для Telegram бота установлены.`);
    }).catch(err => {
        console.error(`[${new Date().toISOString()}] Ошибка при установке команд Telegram бота:`, err.message);
    });
});
