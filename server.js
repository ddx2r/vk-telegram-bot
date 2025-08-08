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
app.use(bodyParser.json());

// Получение переменных окружения
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_SECRET_KEY = process.env.VK_SECRET_KEY;
const VK_SERVICE_KEY = process.env.VK_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Основной чат (все события, кроме лидов и служебных)
const LEAD_CHAT_ID = process.env.LEAD_CHAT_ID; // Чат для заявок и выходов
const SERVICE_CHAT_ID = process.env.SERVICE_CHAT_ID; // Чат для логов и служебных сообщений
const VK_API_TOKEN = process.env.VK_API_TOKEN; // API-ключ для VK API, который не был указан, но может понадобиться для некоторых запросов

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !LEAD_CHAT_ID || !SERVICE_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Убедитесь, что установлены VK_GROUP_ID, VK_SECRET_KEY, VK_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LEAD_CHAT_ID, SERVICE_CHAT_ID.');
    process.exit(1);
}

// Инициализация Telegram бота
// polling: true необходим для обработки команд, но может вызывать проблемы с дублированием
// при получении одного и того же события через Callback API и через long-polling Telegram API
// Дополнительно проверяем `from_id` в обработчике команд, чтобы отвечать только на сообщения из нужных чатов.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Инициализация кэша для дедупликации (TTL 60 секунд)
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Временное хранилище для настроек событий
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
    'lead_forms_new': true, // Добавляем новое событие
    'message_reply': true, // Добавляем новое событие
    'message_event': true, // Добавляем новое событие
    'donut_subscription_create': true,
    'donut_subscription_prolonged': true,
    'donut_subscription_expired': true,
    'donut_subscription_cancelled': true,
    'donut_subscription_price_changed': true,
    'donut_money_withdraw': true,
    'donut_money_withdraw_error': true,
};

// Функция для экранирования HTML-сущностей
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

// Функция для получения имени пользователя VK по ID с дополнительной информацией
async function getVkUserInfo(userId) {
    if (!userId) return null;
    try {
        const response = await axios.get(`https://api.vk.com/method/users.get`, {
            params: {
                user_ids: userId,
                fields: 'city,bdate', // Запрашиваем город и дату рождения
                access_token: VK_SERVICE_KEY,
                v: '5.131'
            },
            timeout: 5000
        });

        if (response.data?.response?.length > 0) {
            const user = response.data.response[0];
            const name = `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
            const city = user.city?.title ? escapeHtml(user.city.title) : 'не указан';
            
            let age = 'не указан';
            if (user.bdate) {
                try {
                    const bdateParts = user.bdate.split('.');
                    if (bdateParts.length === 3) {
                        const [day, month, year] = bdateParts;
                        const birthDate = new Date(`${year}-${month}-${day}`);
                        const today = new Date();
                        let a = today.getFullYear() - birthDate.getFullYear();
                        const m = today.getMonth() - birthDate.getMonth();
                        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
                            a--;
                        }
                        if (!isNaN(a) && a > 0 && a < 150) {
                            age = a;
                        }
                    }
                } catch (e) {
                    console.warn(`Ошибка при расчете возраста для пользователя ${userId}: ${e.message}`);
                }
            }

            return {
                name,
                city,
                age
            };
        }
        return null;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении информации о пользователе VK (ID: ${userId}):`, error.response ? error.response.data : error.message);
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
        
        if (response.data?.response?.count !== undefined) {
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
    let sent = false;
    for (let i = 0; i < 3; i++) {
        try {
            // Убеждаемся, что text не пустой, чтобы избежать ошибок
            if (!text || text.trim() === '') {
                console.warn(`[${new Date().toISOString()}] Попытка отправить пустое сообщение в чат ${chatId}. Игнорируем.`);
                sent = true;
                break;
            }
            await bot.sendMessage(chatId, text, { ...options, disable_web_page_preview: true });
            sent = true;
            break;
        } catch (telegramSendError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке сообщения в Telegram (попытка ${i + 1}):`, telegramSendError.response ? telegramSendError.response.data : telegramSendError.message);
            if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
    if (!sent) {
        console.error(`[${new Date().toISOString()}] Не удалось отправить сообщение в Telegram в чат ${chatId} после нескольких попыток.`);
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
                break;
            } catch (mediaSendError) {
                console.error(`[${new Date().toISOString()}] Ошибка при отправке мультимедиа (${type}) в Telegram (попытка ${i + 1}):`, mediaSendError.response ? mediaSendError.response.data : mediaSendError.message);
                if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
        if (!sent) {
            console.error(`[${new Date().toISOString()}] Не удалось отправить мультимедиа (${type}) в Telegram после нескольких попыток.`);
            await sendTelegramMessageWithRetry(chatId, `⚠️ Не удалось отправить мультимедиа (${type}) в Telegram.`, { parse_mode: 'HTML' });
        }
    } catch (downloadError) {
        console.error(`[${new Date().toISOString()}] Ошибка при скачивании мультимедиа с VK URL (${fileUrl}):`, downloadError.message);
        await sendTelegramMessageWithRetry(chatId, `⚠️ Ошибка при скачивании мультимедиа с VK: ${escapeHtml(downloadError.message)}.`, { parse_mode: 'HTML' });
    }
}


// Функция для обработки вложений
async function processAttachments(attachments, chatId, captionPrefix = '', isFromMainChat = true) {
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
                if (sticker && sticker.images_with_background?.length > 0) {
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
                if (isFromMainChat) { // Только для основного чата, чтобы избежать спама
                    attachmentsSummary += `❓ Неизвестное вложение: ${attach.type}\n`;
                }
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
const allowedChatIds = new Set([TELEGRAM_CHAT_ID, LEAD_CHAT_ID, SERVICE_CHAT_ID].map(String));

bot.onText(/\/status/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!allowedChatIds.has(chatId)) {
        return sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в настроенных чатах.');
    }
    const message = `🤖 Бот активен и готов к работе!
<b>VK Group ID:</b> <code>${VK_GROUP_ID}</code>
<b>Chat ID для основных событий:</b> <code>${TELEGRAM_CHAT_ID}</code>
<b>Chat ID для лидов и выходов:</b> <code>${LEAD_CHAT_ID}</code>
<b>Chat ID для служебных сообщений:</b> <code>${SERVICE_CHAT_ID}</code>
<b>Настройки событий:</b>
${Object.entries(eventToggleState).map(([key, value]) => `  - ${key}: ${value ? '🟢 Включено' : '🔴 Отключено'}`).join('\n')}
`;
    await sendTelegramMessageWithRetry(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!allowedChatIds.has(chatId)) {
        return sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в настроенных чатах.');
    }
    const message = `
<b>Доступные команды:</b>
/status - Проверить статус бота и настройки событий.
/help - Показать этот список команд.
/my_chat_id - Узнать ID текущего чата.
/test_notification - Отправить тестовое уведомление.
/list_events - Показать статус всех событий VK.
/toggle_event <event_name> - Включить/отключить событие.
/test_lead - Отправить тестовую заявку (только для тестирования).
    `;
    await sendTelegramMessageWithRetry(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/\/my_chat_id/, async (msg) => {
    const chatId = msg.chat.id;
    await sendTelegramMessageWithRetry(chatId, `🆔 ID этого чата: <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/test_notification/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!allowedChatIds.has(chatId)) {
        return sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в настроенных чатах.');
    }
    const message = `🎉 Тестовое уведомление из чата <code>${chatId}</code> успешно отправлено!`;
    await sendTelegramMessageWithRetry(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/\/list_events/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!allowedChatIds.has(chatId)) {
        return sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в настроенных чатах.');
    }
    const eventsList = Object.entries(eventToggleState)
        .map(([event, state]) => `<b>${event}</b>: ${state ? '🟢 Включено' : '🔴 Отключено'}`)
        .join('\n');
    await sendTelegramMessageWithRetry(chatId, `<b>Статус событий VK:</b>\n${eventsList}`, { parse_mode: 'HTML' });
});

bot.onText(/\/toggle_event (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    if (!allowedChatIds.has(chatId)) {
        return sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в настроенных чатах.');
    }
    const eventName = match[1];
    if (eventToggleState.hasOwnProperty(eventName)) {
        eventToggleState[eventName] = !eventToggleState[eventName];
        const status = eventToggleState[eventName] ? 'включено' : 'отключено';
        await sendTelegramMessageWithRetry(chatId, `✅ Событие <b>${eventName}</b> теперь ${status}.`, { parse_mode: 'HTML' });
    } else {
        await sendTelegramMessageWithRetry(chatId, `⚠️ Неизвестное событие: <b>${eventName}</b>.`, { parse_mode: 'HTML' });
    }
});

bot.onText(/\/test_lead/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!allowedChatIds.has(chatId)) {
        return sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в настроенных чатах.');
    }
    
    // Имитация данных lead_forms_new
    const testPayload = {
        type: 'lead_forms_new',
        object: {
            lead_id: 9999999,
            group_id: Number(VK_GROUP_ID),
            user_id: 17336517,
            form_id: 1,
            form_name: "Тестовая форма",
            answers: [
                { "key": "phone_number", "question": "Номер телефона", "answer": "+7 (921) 555-55-55" },
                { "key": "age", "question": "Возраст", "answer": "25" },
                { "key": "custom_0", "question": "Имя", "answer": "Тестовый Пользователь" }
            ]
        }
    };
    
    await processVkCallback(testPayload);
    await sendTelegramMessageWithRetry(chatId, '✅ Тестовая заявка успешно отправлена.');
});

// --- Основной обработчик запросов от VK Callback API ---

app.post('/vk-callback', async (req, res) => {
    try {
        const { type, object, group_id, secret } = req.body;

        console.log(`[${new Date().toISOString()}] Получен запрос от VK. Тип: ${type}, Group ID: ${group_id}`);

        // 1. Проверка секретного ключа для защиты от поддельных запросов
        if (secret !== VK_SECRET_KEY) {
            console.error(`[${new Date().toISOString()}] Неверный секретный ключ. Запрос отклонен.`);
            return res.status(403).send('invalid secret key');
        }

        // 2. Проверка Group ID
        if (String(group_id) !== VK_GROUP_ID) {
            console.error(`[${new Date().toISOString()}] Неверный Group ID. Ожидается: ${VK_GROUP_ID}, Получено: ${group_id}`);
            return res.status(403).send('invalid group id');
        }

        // 3. Обработка типа 'confirmation'
        if (type === 'confirmation') {
            console.log(`[${new Date().toISOString()}] Получен запрос на подтверждение сервера.`);
            // Отправляем ключ подтверждения. Он не указан в коде, поэтому заглушка.
            // В реальном приложении нужно получить его из настроек VK
            return res.send('YOUR_CONFIRMATION_KEY_HERE');
        }

        // 4. Проверка на дубликаты
        const eventHash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex');
        if (deduplicationCache.has(eventHash)) {
            console.warn(`[${new Date().toISOString()}] Дублирующееся событие получено и проигнорировано: Тип: ${type}, Хеш: ${eventHash}`);
            return res.send('ok');
        }
        deduplicationCache.set(eventHash, true);

        // 5. Обработка события
        await processVkCallback(req.body);

        // 6. Отправка ответа VK
        res.send('ok');

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Критическая ошибка при обработке запроса VK:`, error);
        // Уведомление в служебный чат об ошибке
        try {
            await sendTelegramMessageWithRetry(SERVICE_CHAT_ID, `❌ <b>Критическая ошибка при обработке события VK:</b>\nТип: <code>${escapeHtml(req.body?.type || 'Неизвестный')}</code>\nСообщение: ${escapeHtml(error.message || 'Неизвестная ошибка')}\n\nПроверьте логи Railway для деталей.`, { parse_mode: 'HTML' });
        } catch (telegramError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке критического уведомления об ошибке в Telegram:`, telegramError.message);
        }
        res.status(500).send('error');
    }
});


// Функция-роутер для обработки событий
async function processVkCallback(payload) {
    const { type, object } = payload;
    
    // Проверяем, включено ли событие
    if (!eventToggleState[type]) {
        console.log(`[${new Date().toISOString()}] Событие '${type}' отключено в настройках.`);
        return;
    }

    let messageText = '';
    let targetChatId = TELEGRAM_CHAT_ID; // По умолчанию отправляем в основной чат

    switch (type) {
        case 'message_new':
            if (object.message?.peer_id === Number(VK_GROUP_ID)) { // Игнорируем сообщения от самого себя
                console.log(`[${new Date().toISOString()}] Получено сообщение от самого себя, игнорируем.`);
                return;
            }
            if (object.message?.text?.includes('/')) {
                 console.log(`[${new Date().toISOString()}] Получено служебное сообщение, игнорируем.`);
                 return;
            }
            const message = object.message;
            const senderInfo = await getVkUserInfo(message.from_id);
            const senderName = senderInfo ? `${senderInfo.name}` : `Пользователь <code>${message.from_id}</code>`;

            messageText = `📩 <b>Новое личное сообщение:</b>
<b>От:</b> <a href="https://vk.com/id${message.from_id}">${senderName}</a>
<b>Текст:</b> ${escapeHtml(message.text)}`;

            if (message.attachments) {
                const attachmentsSummary = await processAttachments(message.attachments, targetChatId);
                messageText += attachmentsSummary;
            }

            break;
        
        case 'wall_post_new':
        case 'wall_repost':
            const post = object;
            const postOwnerInfo = await getVkUserInfo(post.from_id);
            const postOwnerName = postOwnerInfo ? `${postOwnerInfo.name}` : `Пользователь <code>${post.from_id}</code>`;
            const postAction = type === 'wall_post_new' ? '📝 Новый пост' : '🔁 Новый репост';

            messageText = `${postAction} на стене VK:
<b>Автор:</b> <a href="https://vk.com/id${post.from_id}">${postOwnerName}</a>
<b>Текст:</b> ${escapeHtml(post.text || 'Без текста')}
<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>`;

            if (post.attachments) {
                const attachmentsSummary = await processAttachments(post.attachments, targetChatId);
                messageText += attachmentsSummary;
            }
            break;

        case 'like_add':
            const like = object;
            const likerInfo = await getVkUserInfo(like.liker_id);
            const likerName = likerInfo ? `${likerInfo.name}` : `Пользователь <code>${like.liker_id}</code>`;
            const objectLink = getObjectLinkForLike(like.owner_id, like.object_type, like.object_id, like.post_id);
            const objectDisplayName = getObjectTypeDisplayName(like.object_type);

            let likesCount = null;
            if (like.object_type !== 'comment') { // Для комментариев нет API для получения лайков
                likesCount = await getVkLikesCount(like.owner_id, like.object_id, like.object_type);
            }

            messageText = `👍 Новый лайк от <a href="https://vk.com/id${like.liker_id}">${likerName}</a>
<b>К:</b> ${objectDisplayName} <a href="${objectLink}">ссылка</a>`;

            if (likesCount !== null) {
                messageText += `\n<b>Общее количество лайков:</b> ${likesCount}`;
            }
            break;

        case 'like_remove':
            const unlike = object;
            const unlikerInfo = await getVkUserInfo(unlike.liker_id);
            const unlikerName = unlikerInfo ? `${unlikerInfo.name}` : `Пользователь <code>${unlike.liker_id}</code>`;
            const objectLinkRemove = getObjectLinkForLike(unlike.owner_id, unlike.object_type, unlike.object_id, unlike.post_id);
            const objectDisplayNameRemove = getObjectTypeDisplayName(unlike.object_type);
            
            messageText = `💔 Лайк от <a href="https://vk.com/id${unlike.liker_id}">${unlikerName}</a> удалён.
<b>К:</b> ${objectDisplayNameRemove} <a href="${objectLinkRemove}">ссылка</a>`;
            break;

        case 'video_new':
            const video = object;
            messageText = `🎥 Новое видео в VK: <a href="https://vk.com/video${video.owner_id}_${video.id}">${escapeHtml(video.title || 'Без названия')}</a>`;
            break;

        case 'photo_new':
            const photo = object;
            const photoUrl = photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url;
            messageText = `📸 Новая фотография в VK`;
            if (photoUrl) {
                await sendTelegramMedia(targetChatId, 'photo', photoUrl, `📸 Новая фотография от <a href="https://vk.com/photo${photo.owner_id}_${photo.id}">пользователя</a>`);
            }
            break;

        case 'audio_new':
            const audio = object;
            messageText = `🎵 Новое аудио в VK: <a href="${audio.url}">${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}</a>`;
            break;

        case 'lead_forms_new':
            targetChatId = LEAD_CHAT_ID;
            const lead = object;
            const leadUserInfo = await getVkUserInfo(lead.user_id);
            const leadUserName = leadUserInfo ? `${leadUserInfo.name}` : `Пользователь <code>${lead.user_id}</code>`;
            
            let leadText = `📝 <b>НОВАЯ ЗАЯВКА ПО ФОРМЕ!</b>
<b>Название формы:</b> ${escapeHtml(lead.form_name)}
<b>Пользователь:</b> <a href="https://vk.com/id${lead.user_id}">${leadUserName}</a>
`;
            lead.answers.forEach(answer => {
                leadText += `\n<b>${escapeHtml(answer.question)}:</b> ${escapeHtml(answer.answer)}`;
            });
            messageText = leadText;
            break;

        case 'group_join':
        case 'group_leave':
            targetChatId = LEAD_CHAT_ID;
            const eventUserId = object.user_id;
            const userInfo = await getVkUserInfo(eventUserId);
            const userName = userInfo ? `${userInfo.name}` : `Пользователь <code>${eventUserId}</code>`;
            const userLink = `https://vk.com/id${eventUserId}`;
            const action = type === 'group_join' ? '➕ Вступил' : '➖ Вышел';

            messageText = `${action} из сообщества <a href="${userLink}">${userName}</a>.
<b>Город:</b> ${userInfo?.city || 'не указан'}
<b>Возраст:</b> ${userInfo?.age || 'не указан'}`;
            break;

        // Другие события для пересылки в основной чат
        case 'wall_reply_new':
        case 'wall_reply_edit':
        case 'wall_reply_delete':
        case 'photo_comment_new':
        case 'photo_comment_edit':
        case 'photo_comment_delete':
        case 'video_comment_new':
        case 'video_comment_edit':
        case 'video_comment_delete':
        case 'board_post_new':
        case 'board_post_edit':
        case 'board_post_delete':
        case 'market_comment_new':
        case 'market_comment_edit':
        case 'market_comment_delete':
        case 'poll_vote_new':
        case 'group_change_photo':
        case 'group_change_settings':
        case 'group_officers_edit':
        case 'user_block':
        case 'user_unblock':
            // Здесь можно добавить детальную обработку для каждого из этих событий
            messageText = `📢 <b>Событие:</b> <code>${type}</code>\n${JSON.stringify(object, null, 2)}`;
            break;

        case 'message_reply':
        case 'message_event':
            // Игнорируем служебные сообщения от VK
            console.log(`[${new Date().toISOString()}] Игнорируем служебное событие '${type}'.`);
            return;

        // Дополнительные события Donut
        case 'donut_subscription_create':
        case 'donut_subscription_prolonged':
        case 'donut_subscription_expired':
        case 'donut_subscription_cancelled':
        case 'donut_subscription_price_changed':
        case 'donut_money_withdraw':
        case 'donut_money_withdraw_error':
            messageText = `🍩 <b>Событие VK Donut:</b> <code>${type}</code>\n${JSON.stringify(object, null, 2)}`;
            break;

        default:
            // Отправляем в служебный чат, чтобы не засорять основной
            targetChatId = SERVICE_CHAT_ID;
            messageText = `❓ <b>Неизвестное или необработанное событие VK:</b>\nТип: <code>${type}</code>\n\n<code>${JSON.stringify(payload.object, null, 2)}</code>`;
            break;
    }

    if (messageText) {
        await sendTelegramMessageWithRetry(targetChatId, messageText, { parse_mode: 'HTML' });
    }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Сервер VK-Telegram бота запущен на порту ${PORT}`);
    // Устанавливаем команды для Telegram бота при запуске
    const commands = [
        { command: 'status', description: 'Проверить статус бота' },
        { command: 'help', description: 'Показать список команд' },
        { command: 'my_chat_id', description: 'Узнать ID текущего чата' },
        { command: 'test_notification', description: 'Отправить тестовое уведомление' },
        { command: 'list_events', description: 'Показать статус событий VK' },
        { command: 'toggle_event', description: 'Включить/отключить событие' },
        { command: 'test_lead', description: 'Отправить тестовую заявку (только для тестирования)'}
    ];

    bot.setMyCommands(commands)
       .then(() => console.log(`[${new Date().toISOString()}] Команды бота успешно установлены.`))
       .catch(err => console.error(`[${new Date().toISOString()}] Ошибка при установке команд бота:`, err));

    // Отправляем служебное уведомление о старте бота
    sendTelegramMessageWithRetry(SERVICE_CHAT_ID, `🚀 Бот успешно запущен на Railway.`, { parse_mode: 'HTML' })
        .catch(err => console.error(`[${new Date().toISOString()}] Ошибка при отправке уведомления о запуске:`, err));
});
