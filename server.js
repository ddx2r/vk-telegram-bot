// server.js - Основной файл сервера для обработки VK Callback API и пересылки в Telegram

// Импорт необходимых модулей
const express = require('express'); // Веб-фреймворк для Node.js
const bodyParser = require('body-parser'); // Для парсинга JSON-запросов
const axios = require('axios'); // Для выполнения HTTP-запросов (к Telegram API, VK API и скачивания медиа)
const crypto = require('crypto'); // Для хеширования, используется для дедупликации
const NodeCache = require('node-cache'); // Для in-memory кэша дедупликации
const TelegramBot = require('node-telegram-bot-api'); // Для работы с Telegram Bot API
const { Firestore } = require('@google-cloud/firestore');

// Инициализация Express приложения
const app = express();
// Использование body-parser для обработки JSON-тела запросов
app.use(bodyParser.json());

// Получение переменных окружения
// Эти переменные будут установлены на Railway
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_COMMUNITY_ID = process.env.VK_COMMUNITY_ID;
const VK_API_TOKEN = process.env.VK_API_TOKEN;
const VK_SECRET_KEY = process.env.VK_SECRET_KEY;
const VK_SERVICE_KEY = process.env.VK_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Основной чат для пересылки событий
const LEAD_CHAT_ID = process.env.LEAD_CHAT_ID; // Чат для уведомлений о лидах
const SERVICE_CHAT_ID = process.env.SERVICE_CHAT_ID; // Чат для сервисных уведомлений
const DEBUG_CHAT_ID = process.env.DEBUG_CHAT_ID; // Чат для отладки
const FIREBASE_CREDENTIALS_JSON = process.env.FIREBASE_CREDENTIALS_JSON;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные установлены.');
    process.exit(1);
}

// Инициализация Firebase Firestore
let db;
try {
    const credentials = JSON.parse(FIREBASE_CREDENTIALS_JSON);
    const firestore = new Firestore({
        projectId: credentials.project_id,
        credentials: {
            client_email: credentials.client_email,
            private_key: credentials.private_key.replace(/\\n/g, '\n'),
        },
    });
    db = firestore;
    console.log('[INFO] Firestore успешно инициализирован.');
} catch (e) {
    console.error('[ERROR] Ошибка инициализации Firestore:', e.message);
    db = null;
}

// Инициализация Telegram бота
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Инициализация кэша для дедупликации (TTL 60 секунд)
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Временное хранилище для настроек событий (не сохраняется при перезапусках Railway)
const eventToggleState = {
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
    'lead_forms_new': true, // Новое событие
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
    if (!userId) return null;
    try {
        const response = await axios.get(`https://api.vk.com/method/users.get`, {
            params: {
                user_ids: userId,
                access_token: VK_SERVICE_KEY,
                fields: 'first_name,last_name',
                v: '5.131'
            },
            timeout: 5000
        });

        if (response.data && response.data.response && response.data.response.length > 0) {
            const user = response.data.response[0];
            return `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
        }
        return null;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении имени пользователя VK (ID: ${userId}):`, error.response ? error.response.data : error.message);
        return null;
    }
}

// Функция для получения общего количества лайков для объекта VK
async function getVkLikesCount(ownerId, itemId, itemType) {
    try {
        const response = await axios.get(`https://api.vk.com/method/likes.getList`, {
            params: {
                type: itemType,
                owner_id: ownerId,
                item_id: itemId,
                access_token: VK_SERVICE_KEY,
                v: '5.131'
            },
            timeout: 5000
        });

        if (response.data && response.data.response && response.data.response.count !== undefined) {
            return response.data.response.count;
        }
        console.warn(`[${new Date().toISOString()}] VK API не вернул количество лайков. Ответ:`, response.data);
        return null;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении количества лайков для объекта ${itemType}:${ownerId}_${itemId}:`, error.response ? error.response.data : error.message);
        return null;
    }
}

// Функция для отправки сообщения в Telegram с логикой повтора
async function sendTelegramMessageWithRetry(chatId, text, options = {}) {
    if (!chatId) {
        console.error(`[${new Date().toISOString()}] Попытка отправить сообщение без chatId.`);
        return;
    }
    let sent = false;
    for (let i = 0; i < 3; i++) {
        try {
            await bot.sendMessage(chatId, text, { ...options, disable_web_page_preview: true });
            sent = true;
            break;
        } catch (telegramSendError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке сообщения в Telegram (попытка ${i + 1}):`, telegramSendError.response ? telegramSendError.response.data : telegramSendError.message);
            if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
    if (!sent) {
        console.error(`[${new Date().toISOString()}] Не удалось отправить сообщение в Telegram после нескольких попыток.`);
    }
}

// Функция для отправки мультимедиа в Telegram
async function sendTelegramMedia(chatId, type, fileUrl, caption, options = {}) {
    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 10000 });
        const fileBuffer = Buffer.from(response.data);

        let sent = false;
        for (let i = 0; i < 3; i++) {
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
                        return;
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

    attachmentsSummary += '\n\n<b>Вложения:</b>\n';
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
                attachmentsSummary += `📸 <a href="${fallbackLink || 'javascript:void(0)'}">Фото</a>`;
                if (photo.text) attachmentsSummary += ` <i>(${escapeHtml(photo.text)})</i>`;
                attachmentsSummary += '\n';
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

                attachmentsSummary += `🎥 <a href="${fallbackLink || 'javascript:void(0)'}">Видео: ${escapeHtml(video.title || 'Без названия')}</a>`;
                if (!sentDirectly) attachmentsSummary += ` (прямая отправка недоступна)`;
                attachmentsSummary += '\n';
                break;
            case 'audio':
                const audio = attach.audio;
                if (audio.url) {
                    mediaCaption = `${captionPrefix} Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}`;
                    await sendTelegramMedia(chatId, 'audio', audio.url, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = audio.url;
                }
                attachmentsSummary += `🎵 <a href="${fallbackLink || 'javascript:void(0)'}">Аудио: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}</a>\n`;
                break;
            case 'doc':
                const doc = attach.doc;
                if (doc.url) {
                    mediaCaption = `${captionPrefix} Документ: ${escapeHtml(doc.title || 'Без названия')}`;
                    await sendTelegramMedia(chatId, 'document', doc.url, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = doc.url;
                }
                attachmentsSummary += `📄 <a href="${fallbackLink || 'javascript:void(0)'}">Документ: ${escapeHtml(doc.title || 'Без названия')}</a>\n`;
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
            case 'wall':
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
                attachmentsSummary += `🎨 <a href="${fallbackLink || 'javascript:void(0)'}">Граффити</a>\n`;
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
                attachmentsSummary += `🖼️ <a href="${fallbackLink || 'javascript:void(0)'}">Стикер</a>\n`;
                break;
            case 'gift':
                const gift = attach.gift;
                if (gift && gift.thumb_256) {
                    mediaCaption = `${captionPrefix} Подарок`;
                    await sendTelegramMedia(chatId, 'photo', gift.thumb_256, mediaCaption);
                    sentDirectly = true;
                    fallbackLink = gift.thumb_256;
                }
                attachmentsSummary += `🎁 <a href="${fallbackLink || 'javascript:void(0)'}">Подарок</a>\n`;
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
        await sendTelegramMessageWithRetry(chatId, `Неизвестный тип события: \`${eventType}\`. Используйте /list_events для просмотра доступных.`);
    }
});

// --- Основной обработчик запросов от VK Callback API ---
app.post('/', async (req, res) => {
    const event = req.body;
    const type = event.type;
    const object = event.object;
    const groupId = event.group_id;

    console.log(`[${new Date().toISOString()}] Получено событие VK: ${type}`);

    // Проверка Secret Key
    if (event.secret && event.secret !== VK_SECRET_KEY) {
        console.warn(`[${new Date().toISOString()}] Получено событие с неверным секретным ключом. Игнорируем.`);
        return res.status(403).send('Forbidden');
    }

    // Проверка подтверждения адреса
    if (type === 'confirmation') {
        const confirmationCode = 'КОД_ПОДТВЕРЖДЕНИЯ'; // Замените на ваш код подтверждения из настроек Callback API VK
        return res.send(confirmationCode);
    }

    // Проверка, что событие пришло от нужной группы
    if (groupId && String(groupId) !== VK_GROUP_ID) {
        console.warn(`[${new Date().toISOString()}] Получено событие от чужой группы (ID: ${groupId}). Игнорируем.`);
        return res.send('ok');
    }

    // Дедупликация
    const eventHash = crypto.createHash('md5').update(JSON.stringify(event)).digest('hex');
    if (deduplicationCache.has(eventHash)) {
        console.log(`[${new Date().toISOString()}] Событие ${type} с хэшем ${eventHash} уже было обработано. Игнорируем.`);
        return res.send('ok');
    }
    deduplicationCache.set(eventHash, true);

    // Проверка статуса события
    if (!eventToggleState[type]) {
        console.log(`[${new Date().toISOString()}] Событие ${type} отключено. Игнорируем.`);
        return res.send('ok');
    }

    try {
        let messageText = '';
        let telegramChatId = TELEGRAM_CHAT_ID;

        switch (type) {
            case 'wall_post_new':
                const post = object;
                const postAuthor = post.signer_id ? await getVkUserName(post.signer_id) : 'Администратор';
                const postText = post.text ? `\n\n💬 Текст: ${escapeHtml(post.text.substring(0, 500))}${post.text.length > 500 ? '...' : ''}` : '';
                const postAttachmentsSummary = await processAttachments(post.attachments, telegramChatId, `[Новый пост]`);
                messageText = `
📌 <b>Новый пост на стене</b>
<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>
✍️ Автор: <b>${postAuthor}</b>
${postText}
${postAttachmentsSummary}
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'wall_repost':
                const repost = object;
                const repostAuthor = await getVkUserName(repost.owner_id);
                const originalPost = repost.copy_history?.[0];
                const originalPostAuthor = originalPost ? await getVkUserName(originalPost.owner_id) : 'Неизвестный автор';
                messageText = `
🔁 <b>Новый репост на стене</b>
<a href="https://vk.com/wall${repost.owner_id}_${repost.id}">Ссылка на репост</a>
👥 Репостнул: <b>${repostAuthor || `ID ${repost.owner_id}`}</b>
📝 Оригинальный пост: <a href="https://vk.com/wall${originalPost.owner_id}_${originalPost.id}">Ссылка на оригинал</a>
✍️ Автор оригинала: <b>${originalPostAuthor || `ID ${originalPost.owner_id}`}</b>
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'wall_reply_new':
            case 'wall_reply_edit':
            case 'wall_reply_delete':
                const reply = object;
                const replyAuthorName = await getVkUserName(reply.from_id);
                const replyAuthor = replyAuthorName || `ID ${reply.from_id}`;
                const action = type === 'wall_reply_new' ? 'Новый комментарий' :
                               type === 'wall_reply_edit' ? 'Изменен комментарий' :
                               'Удален комментарий';
                const replyUrl = `https://vk.com/wall${reply.owner_id}_${reply.post_id}?reply=${reply.id}`;
                const replyText = reply.text ? `\n\n💬 Текст: ${escapeHtml(reply.text)}` : '';

                let likesCountReply = await getVkLikesCount(reply.owner_id, reply.id, 'comment');
                let likesCountStringReply = likesCountReply !== null ? `\n❤️ Лайков: <b>${likesCountReply}</b>` : '';

                messageText = `
💬 <b>${action} к посту</b>
<a href="${replyUrl}">Ссылка на комментарий</a>
👤 Автор: <b>${replyAuthor}</b>
${replyText}
${likesCountStringReply}
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'photo_comment_new':
            case 'photo_comment_edit':
            case 'photo_comment_delete':
                const photoComment = object;
                const photoCommentAuthorName = await getVkUserName(photoComment.from_id);
                const photoCommentAuthor = photoCommentAuthorName || `ID ${photoComment.from_id}`;
                const photoAction = type === 'photo_comment_new' ? 'Новый комментарий' :
                                    type === 'photo_comment_edit' ? 'Изменен комментарий' :
                                    'Удален комментарий';
                const photoCommentUrl = `https://vk.com/photo${photoComment.owner_id}_${photoComment.photo_id}?reply=${photoComment.id}`;
                const photoCommentText = photoComment.text ? `\n\n💬 Текст: ${escapeHtml(photoComment.text)}` : '';

                let likesCountPhoto = await getVkLikesCount(photoComment.owner_id, photoComment.id, 'comment');
                let likesCountStringPhoto = likesCountPhoto !== null ? `\n❤️ Лайков: <b>${likesCountPhoto}</b>` : '';

                messageText = `
📸 <b>${photoAction} к фото</b>
<a href="${photoCommentUrl}">Ссылка на комментарий</a>
👤 Автор: <b>${photoCommentAuthor}</b>
${photoCommentText}
${likesCountStringPhoto}
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'video_comment_new':
            case 'video_comment_edit':
            case 'video_comment_delete':
                const videoComment = object;
                const videoCommentAuthorName = await getVkUserName(videoComment.from_id);
                const videoCommentAuthor = videoCommentAuthorName || `ID ${videoComment.from_id}`;
                const videoAction = type === 'video_comment_new' ? 'Новый комментарий' :
                                    type === 'video_comment_edit' ? 'Изменен комментарий' :
                                    'Удален комментарий';
                const videoCommentUrl = `https://vk.com/video${videoComment.owner_id}_${videoComment.video_id}?reply=${videoComment.id}`;
                const videoCommentText = videoComment.text ? `\n\n💬 Текст: ${escapeHtml(videoComment.text)}` : '';

                let likesCountVideo = await getVkLikesCount(videoComment.owner_id, videoComment.id, 'comment');
                let likesCountStringVideo = likesCountVideo !== null ? `\n❤️ Лайков: <b>${likesCountVideo}</b>` : '';

                messageText = `
🎥 <b>${videoAction} к видео</b>
<a href="${videoCommentUrl}">Ссылка на комментарий</a>
👤 Автор: <b>${videoCommentAuthor}</b>
${videoCommentText}
${likesCountStringVideo}
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'board_post_new':
            case 'board_post_edit':
            case 'board_post_delete':
                const boardPost = object;
                const boardPostAuthorName = await getVkUserName(boardPost.from_id);
                const boardPostAuthor = boardPostAuthorName || `ID ${boardPost.from_id}`;
                const boardAction = type === 'board_post_new' ? 'Новый комментарий в обсуждении' :
                                    type === 'board_post_edit' ? 'Изменен комментарий в обсуждении' :
                                    'Удален комментарий в обсуждении';
                const topicUrl = `https://vk.com/topic-${groupId}_${boardPost.topic_id}?post=${boardPost.id}`;
                const boardPostText = boardPost.text ? `\n\n💬 Текст: ${escapeHtml(boardPost.text)}` : '';

                let likesCountBoard = await getVkLikesCount(boardPost.owner_id, boardPost.id, 'comment');
                let likesCountStringBoard = likesCountBoard !== null ? `\n❤️ Лайков: <b>${likesCountBoard}</b>` : '';

                messageText = `
🗣️ <b>${boardAction}</b>
<a href="${topicUrl}">Ссылка на комментарий</a>
👤 Автор: <b>${boardPostAuthor}</b>
${boardPostText}
${likesCountStringBoard}
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'photo_new':
                const photoNew = object;
                const photoOwner = photoNew.owner_id;
                const photoAuthorName = await getVkUserName(photoNew.user_id);
                const photoAuthor = photoAuthorName || `ID ${photoNew.user_id}`;
                const photoUrl = `https://vk.com/photo${photoNew.owner_id}_${photoNew.id}`;
                const photoAttachmentsSummary = await processAttachments([
                    { type: 'photo', photo: photoNew }
                ], telegramChatId, `[Новое фото]`);
                messageText = `
📸 <b>Новая фотография</b>
<a href="${photoUrl}">Ссылка на фото</a>
👤 Загрузил: <b>${photoAuthor}</b>
${photoAttachmentsSummary}
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'video_new':
                const videoNew = object;
                const videoAuthorName = await getVkUserName(videoNew.owner_id);
                const videoAuthor = videoAuthorName || `ID ${videoNew.owner_id}`;
                const videoUrl = `https://vk.com/video${videoNew.owner_id}_${videoNew.id}`;
                const videoAttachmentsSummary = await processAttachments([
                    { type: 'video', video: videoNew }
                ], telegramChatId, `[Новое видео]`);
                messageText = `
🎥 <b>Новое видео</b>
<a href="${videoUrl}">Ссылка на видео</a>
👤 Загрузил: <b>${videoAuthor}</b>
${videoAttachmentsSummary}
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'audio_new':
                const audioNew = object;
                const audioUrl = `https://vk.com/audio${audioNew.owner_id}_${audioNew.id}`;
                messageText = `
🎵 <b>Новая аудиозапись</b>
<a href="${audioUrl}">Ссылка на аудио</a>
🎧 Исполнитель: <b>${escapeHtml(audioNew.artist || 'Неизвестно')}</b>
📝 Название: <b>${escapeHtml(audioNew.title || 'Без названия')}</b>
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;

            case 'like_add':
            case 'like_remove':
                const like = object;
                const likerName = await getVkUserName(like.liker_id);
                const liker = likerName || `ID ${like.liker_id}`;
                const likeAction = type === 'like_add' ? 'поставил(а) лайк' : 'убрал(а) лайк';
                const objectTypeDisplayName = getObjectTypeDisplayName(like.object_type);
                const objectLink = getObjectLinkForLike(like.object_owner_id, like.object_type, like.object_id, like.post_id);

                let likesCountTotal = await getVkLikesCount(like.object_owner_id, like.object_id, like.object_type);
                let likesCountStringTotal = likesCountTotal !== null ? ` (<b>всего ${likesCountTotal}</b>)` : '';

                messageText = `
👍 <b>${liker}</b> ${likeAction} ${objectTypeDisplayName}.
${objectLink ? `<a href="${objectLink}">Ссылка на объект</a>` : 'Ссылка недоступна.'}
❤️ Количество лайков: <b>${likesCountTotal !== null ? likesCountTotal : 'неизвестно'}</b>
`;
                await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                break;
            case 'lead_forms_new':
                const lead = object;
                const userLink = `https://vk.com/id${lead.user_id}`;
                const formLink = `https://vk.com/app${lead.form_id}`;
                const leadUserName = await getVkUserName(lead.user_id);
                const leadUser = leadUserName || `ID ${lead.user_id}`;
                const answers = lead.answers.map(answer => ` • <b>${escapeHtml(answer.key)}</b>: ${escapeHtml(answer.answer)}`).join('\n');
                
                messageText = `
📝 <b>Новая заявка (Лид)</b>
👤 Пользователь: <a href="${userLink}">${leadUser}</a>
📊 ID формы: <code>${lead.form_id}</code>
🔗 Ссылка на форму: <a href="${formLink}">Открыть</a>

<b>Ответы:</b>
${answers}
`;
                
                if (LEAD_CHAT_ID) {
                    await sendTelegramMessageWithRetry(LEAD_CHAT_ID, messageText, { parse_mode: 'HTML' });
                } else {
                    console.warn(`[${new Date().toISOString()}] LEAD_CHAT_ID не установлен. Заявка будет отправлена в основной чат.`);
                    await sendTelegramMessageWithRetry(telegramChatId, messageText, { parse_mode: 'HTML' });
                }
                break;
            default:
                console.log(`[${new Date().toISOString()}] Получено событие ${type}, которое не обрабатывается.`);
                break;
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при обработке события ${type}:`, error);
        try {
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
        console.log(`[${new Date().toISOString()}] Команды Telegram бота успешно установлены.`);
    }).catch(err => {
        console.error(`[${new Date().toISOString()}] Ошибка при установке команд Telegram бота:`, err);
    });
});
