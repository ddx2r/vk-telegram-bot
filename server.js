// server.js - Основной файл сервера для обработки VK Callback API и пересылки в Telegram

// Импорт необходимых модулей
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin'); // Импорт Firebase Admin SDK

// Инициализация Express приложения
const app = express();
app.use(bodyParser.json());

// Получение переменных окружения
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_SECRET_KEY = process.env.VK_SECRET_KEY;
const VK_SERVICE_KEY = process.env.VK_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LEAD_CHAT_ID = process.env.LEAD_CHAT_ID; // Чат для заявок
const SERVICE_CHAT_ID = process.env.SERVICE_CHAT_ID; // Чат для служебных сообщений и логов

// --- Настройка Firebase ---
// Сервисный аккаунт Firebase должен быть настроен на Railway через переменную окружения GOOGLE_APPLICATION_CREDENTIALS.
// Если переменная не установлена, нужно предоставить serviceAccountKey.json файл.
try {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
    console.log(`[${new Date().toISOString()}] Firebase Admin SDK успешно инициализирован.`);
} catch (error) {
    console.error(`[${new Date().toISOString()}] Ошибка при инициализации Firebase Admin SDK:`, error);
    process.exit(1);
}

const db = admin.firestore();

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !LEAD_CHAT_ID || !SERVICE_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные (VK_GROUP_ID, VK_SECRET_KEY, VK_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LEAD_CHAT_ID, SERVICE_CHAT_ID) установлены.');
    process.exit(1);
}

// Инициализация Telegram бота
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Инициализация in-memory кэша для дедупликации (TTL 60 секунд)
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Временное хранилище для настроек событий. Будет заменено на Firestore.
const eventToggleState = {};

// Функция для загрузки настроек событий из Firestore
async function loadEventSettings() {
    try {
        const docRef = db.collection('settings').doc('eventToggleState');
        const doc = await docRef.get();
        if (doc.exists) {
            Object.assign(eventToggleState, doc.data());
            console.log(`[${new Date().toISOString()}] Настройки событий успешно загружены из Firestore.`);
        } else {
            console.log(`[${new Date().toISOString()}] Документ настроек событий не найден. Используются настройки по умолчанию.`);
            // Устанавливаем настройки по умолчанию, если их нет в Firestore
            const defaultSettings = {
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
                'lead_forms_new': true,
                'message_reply': true,
                'donut_subscription_create': true,
                'donut_subscription_prolonged': true,
                'donut_subscription_expired': true,
                'donut_subscription_cancelled': true,
                'donut_money_withdraw': true,
                'donut_money_withdraw_error': true
            };
            Object.assign(eventToggleState, defaultSettings);
            await docRef.set(defaultSettings);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при загрузке настроек событий из Firestore:`, error);
    }
}

// Функция для сохранения настроек событий в Firestore
async function saveEventSettings() {
    try {
        const docRef = db.collection('settings').doc('eventToggleState');
        await docRef.set(eventToggleState);
        console.log(`[${new Date().toISOString()}] Настройки событий успешно сохранены в Firestore.`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при сохранении настроек событий в Firestore:`, error);
    }
}


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

// Функция для получения имени пользователя VK по ID, теперь с дополнительной информацией
async function getVkUserName(userId, withAdditionalInfo = false) {
    if (!userId) return null;
    try {
        const fields = withAdditionalInfo ? 'city,sex,bdate' : '';
        const response = await axios.get(`https://api.vk.com/method/users.get`, {
            params: {
                user_ids: userId,
                fields: fields,
                access_token: VK_SERVICE_KEY,
                v: '5.131'
            },
            timeout: 5000
        });

        if (response.data && response.data.response && response.data.response.length > 0) {
            const user = response.data.response[0];
            let userName = `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
            let userInfo = '';
            if (withAdditionalInfo) {
                if (user.city && user.city.title) {
                    userInfo += `Город: ${escapeHtml(user.city.title)}\n`;
                }
                if (user.bdate) {
                    const bdate = new Date(user.bdate.split('.').reverse().join('-'));
                    const ageDiff = Date.now() - bdate.getTime();
                    const age = Math.abs(new Date(ageDiff).getFullYear() - 1970);
                    userInfo += `Возраст: ${age}\n`;
                }
            }
            return { userName, userInfo };
        }
        return null;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении имени пользователя VK (ID: ${userId}):`, error.response ? error.response.data : error.message);
        return null;
    }
}


// Функция для получения информации о группе VK по ID
async function getVkGroupInfo(groupId) {
    try {
        const response = await axios.get(`https://api.vk.com/method/groups.getById`, {
            params: {
                group_ids: groupId,
                access_token: VK_SERVICE_KEY,
                v: '5.131'
            },
            timeout: 5000
        });

        if (response.data && response.data.response && response.data.response.length > 0) {
            const group = response.data.response[0];
            return {
                name: group.name,
                screen_name: group.screen_name
            };
        }
        return null;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении информации о группе VK (ID: ${groupId}):`, error.response ? error.response.data : error.message);
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


// Функция для обработки вложений
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

// Middleware для проверки подписи VK Callback API
function verifyVkSignature(req, res, next) {
    const signature = req.headers['x-vk-event-container-signature'];
    const body = JSON.stringify(req.body);
    const hash = crypto.createHmac('sha256', VK_SECRET_KEY).update(body).digest('hex');

    if (!signature || signature !== hash) {
        console.warn(`[${new Date().toISOString()}] Ошибка проверки подписи VK. Запрос будет проигнорирован.`, { signature, hash, body });
        return res.status(400).send('bad signature');
    }

    next();
}

// Функция для обработки дедупликации
async function isDuplicate(type, objectId, ownerId) {
    const hash = crypto.createHash('md5').update(`${type}_${objectId}_${ownerId}`).digest('hex');
    const docRef = db.collection('deduplication').doc(hash);
    const doc = await docRef.get();
    if (doc.exists) {
        return true;
    } else {
        await docRef.set({ timestamp: admin.firestore.FieldValue.serverTimestamp() });
        return false;
    }
}

// --- Обработчики команд Telegram ---
const allowedChatIds = [TELEGRAM_CHAT_ID, LEAD_CHAT_ID, SERVICE_CHAT_ID];

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (!allowedChatIds.includes(String(chatId))) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в разрешенных чатах.');
        return;
    }
    const uptime = process.uptime();
    const uptimeDays = Math.floor(uptime / 86400);
    const uptimeHours = Math.floor((uptime % 86400) / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);

    const message = `
✅ Бот активен и прослушивает события VK.
<b>Время работы:</b> ${uptimeDays} дн. ${uptimeHours} ч. ${uptimeMinutes} мин.
<b>Ожидаемое поведение:</b>
- Обычные события VK пересылаются в чат с ID: <code>${TELEGRAM_CHAT_ID}</code>
- Заявки (leads) и выходы из группы пересылаются в чат с ID: <code>${LEAD_CHAT_ID}</code>
- Служебные сообщения (логи) пересылаются в чат с ID: <code>${SERVICE_CHAT_ID}</code>
`.trim();
    await sendTelegramMessageWithRetry(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    if (!allowedChatIds.includes(String(chatId))) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в разрешенных чатах.');
        return;
    }
    const commands = `
<b>Список команд:</b>
/status - Проверить статус бота и время работы.
/help - Показать список команд.
/my_chat_id - Узнать ID текущего чата.
/test_notification - Отправить тестовое уведомление.
/list_events - Показать статус событий VK (включено/отключено).
/toggle_event &lt;event_type&gt; - Включить/отключить событие. Пример: <code>/toggle_event wall_post_new</code>
`.trim();
    await sendTelegramMessageWithRetry(chatId, commands, { parse_mode: 'HTML' });
});

bot.onText(/\/my_chat_id/, async (msg) => {
    const chatId = msg.chat.id;
    await sendTelegramMessageWithRetry(chatId, `ID этого чата: <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/test_notification/, async (msg) => {
    const chatId = msg.chat.id;
    if (!allowedChatIds.includes(String(chatId))) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в разрешенных чатах.');
        return;
    }
    await sendTelegramMessageWithRetry(chatId, '✅ Тестовое уведомление успешно отправлено.');
});

bot.onText(/\/list_events/, async (msg) => {
    const chatId = msg.chat.id;
    if (!allowedChatIds.includes(String(chatId))) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в разрешенных чатах.');
        return;
    }
    let message = '<b>Статус событий VK:</b>\n';
    for (const [event, enabled] of Object.entries(eventToggleState)) {
        message += `- <code>${event}</code>: ${enabled ? '✅ Включено' : '❌ Отключено'}\n`;
    }
    await sendTelegramMessageWithRetry(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/\/toggle_event (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!allowedChatIds.includes(String(chatId))) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в разрешенных чатах.');
        return;
    }
    const eventType = match[1];
    if (eventToggleState.hasOwnProperty(eventType)) {
        eventToggleState[eventType] = !eventToggleState[eventType];
        await saveEventSettings();
        await sendTelegramMessageWithRetry(chatId, `Статус события <code>${eventType}</code> изменен на: ${eventToggleState[eventType] ? '✅ Включено' : '❌ Отключено'}`, { parse_mode: 'HTML' });
    } else {
        await sendTelegramMessageWithRetry(chatId, `Событие <code>${eventType}</code> не найдено. Используйте команду <code>/list_events</code> для просмотра доступных.`, { parse_mode: 'HTML' });
    }
});

// Основной обработчик запросов от VK Callback API
app.post('/', verifyVkSignature, async (req, res) => {
    const body = req.body;
    const type = body.type;
    const object = body.object;
    const groupId = body.group_id;
    const secret = body.secret;

    if (secret && secret !== VK_SECRET_KEY) {
        await sendTelegramMessageWithRetry(SERVICE_CHAT_ID, `⚠️ <b>Критическая ошибка: Неверный секретный ключ от VK!</b>
Проверьте настройки Callback API.`, { parse_mode: 'HTML' });
        console.error(`[${new Date().toISOString()}] Ошибка: Неверный секретный ключ.`, secret);
        return res.status(400).send('bad secret key');
    }

    if (body.type === 'confirmation') {
        if (groupId == VK_GROUP_ID) {
            console.log(`[${new Date().toISOString()}] Запрос на подтверждение от VK.`);
            return res.send(process.env.VK_CONFIRMATION_TOKEN); // Убедитесь, что эта переменная окружения установлена
        } else {
            console.warn(`[${new Date().toISOString()}] Запрос на подтверждение от VK для другой группы.`, groupId);
            return res.status(400).send('invalid group id');
        }
    }

    // Проверяем, включено ли событие
    if (!eventToggleState[type]) {
        console.log(`[${new Date().toISOString()}] Событие ${type} отключено. Пропускаем.`);
        return res.send('ok');
    }

    // Основная логика обработки событий
    try {
        let telegramText = '';
        let targetChatId = TELEGRAM_CHAT_ID;
        let isServiceMessage = false;

        console.log(`[${new Date().toISOString()}] Получен запрос от VK. Тип: ${type}, Group ID: ${groupId}`);

        switch (type) {
            case 'wall_post_new':
            case 'wall_repost':
            case 'wall_reply_new':
            case 'photo_new':
            case 'video_new':
            case 'audio_new':
            case 'board_post_new':
            case 'market_order_new':
            case 'poll_vote_new':
            case 'message_new':
            case 'message_reply':
            case 'wall_reply_edit':
            case 'wall_reply_delete':
            case 'photo_comment_new':
            case 'photo_comment_edit':
            case 'photo_comment_delete':
            case 'video_comment_new':
            case 'video_comment_edit':
            case 'video_comment_delete':
            case 'market_comment_new':
            case 'market_comment_edit':
            case 'market_comment_delete':
            case 'donut_subscription_create':
            case 'donut_subscription_prolonged':
            case 'donut_subscription_expired':
            case 'donut_subscription_cancelled':
            case 'donut_money_withdraw':
            case 'donut_money_withdraw_error':
            case 'like_add':
            case 'like_remove':
            case 'group_change_photo':
            case 'group_change_settings':
            case 'group_officers_edit':
            case 'user_block':
            case 'user_unblock':
            case 'group_join':
            case 'group_leave':
            case 'lead_forms_new':
                // Обработка событий
                break;
            default:
                await sendTelegramMessageWithRetry(SERVICE_CHAT_ID, `❓ <b>Неизвестное или необработанное событие VK:</b>\n\nТип: <code>${escapeHtml(type)}</code>\n<pre>${escapeHtml(JSON.stringify(body, null, 2))}</pre>`, { parse_mode: 'HTML' });
                return res.send('ok');
        }

        // Логика дедупликации
        const objectId = object.id || object.post_id || object.user_id || object.comment_id || object.form_id;
        const ownerId = object.owner_id || object.from_id || object.user_id;

        if (objectId && ownerId) {
            if (await isDuplicate(type, objectId, ownerId)) {
                console.log(`[${new Date().toISOString()}] Дублирующееся событие получено и проигнорировано: Тип: ${type}, Объект ID: ${objectId}, Владелец ID: ${ownerId}`);
                await sendTelegramMessageWithRetry(SERVICE_CHAT_ID, `🗑️ Дублирующееся событие получено и проигнорировано:\n\nТип: <code>${escapeHtml(type)}</code>\nОбъект ID: <code>${objectId}</code>\nВладелец ID: <code>${ownerId}</code>`, { parse_mode: 'HTML' });
                return res.send('ok');
            }
        }

        // Маршрутизация и обработка
        switch (type) {
            case 'wall_post_new':
                const post = object;
                const attachmentsSummaryPost = await processAttachments(post.attachments, TELEGRAM_CHAT_ID, 'Новый пост:');
                telegramText = `📝 <b>Новый пост на стене VK:</b>\n\n${escapeHtml(post.text)}\n\n<a href="https://vk.com/wall${post.owner_id}_${post.id}">Посмотреть пост</a>${attachmentsSummaryPost}`;
                break;
            case 'wall_repost':
                const repost = object;
                const attachmentsSummaryRepost = await processAttachments(repost.attachments, TELEGRAM_CHAT_ID, 'Новый репост:');
                telegramText = `🔁 <b>Новый репост в VK:</b>\n\n${escapeHtml(repost.text)}\n\n<a href="https://vk.com/wall${repost.owner_id}_${repost.id}">Посмотреть репост</a>${attachmentsSummaryRepost}`;
                break;
            case 'wall_reply_new':
                const newReply = object;
                const newReplyUser = await getVkUserName(newReply.from_id);
                const attachmentsSummaryReply = await processAttachments(newReply.attachments, TELEGRAM_CHAT_ID, 'Новый комментарий:');
                telegramText = `💬 <b>Новый комментарий:</b>\n\n<b>От:</b> <a href="https://vk.com/id${newReply.from_id}">${newReplyUser || `ID ${newReply.from_id}`}</a>\n<b>Текст:</b> ${escapeHtml(newReply.text)}\n\n<a href="https://vk.com/wall${newReply.owner_id}_${newReply.post_id}?reply=${newReply.id}">Посмотреть комментарий</a>${attachmentsSummaryReply}`;
                break;
            case 'wall_reply_edit':
                const editReply = object;
                const editReplyUser = await getVkUserName(editReply.from_id);
                telegramText = `✍️ <b>Отредактирован комментарий:</b>\n\n<b>От:</b> <a href="https://vk.com/id${editReply.from_id}">${editReplyUser || `ID ${editReply.from_id}`}</a>\n<b>Текст:</b> ${escapeHtml(editReply.text)}\n\n<a href="https://vk.com/wall${editReply.owner_id}_${editReply.post_id}?reply=${editReply.id}">Посмотреть комментарий</a>`;
                break;
            case 'wall_reply_delete':
                const deleteReply = object;
                telegramText = `🗑️ <b>Удален комментарий:</b>\n\nКомментарий ID <code>${deleteReply.id}</code> к посту <code>${deleteReply.post_id}</code> был удален пользователем <code>${deleteReply.deleter_id}</code>.`;
                break;
            case 'photo_new':
                const newPhoto = object;
                const newPhotoUser = await getVkUserName(newPhoto.user_id);
                const photoUrl = newPhoto.sizes?.find(s => s.type === 'x')?.url || newPhoto.sizes?.[newPhoto.sizes.length - 1]?.url;
                if (photoUrl) {
                    await sendTelegramMedia(TELEGRAM_CHAT_ID, 'photo', photoUrl, `📸 <b>Новое фото в альбоме:</b>\n\n<b>Автор:</b> <a href="https://vk.com/id${newPhoto.user_id}">${newPhotoUser || `ID ${newPhoto.user_id}`}</a>\n<b>Описание:</b> ${escapeHtml(newPhoto.text || 'Без описания')}\n\n<a href="https://vk.com/photo${newPhoto.owner_id}_${newPhoto.id}">Посмотреть фото</a>`);
                } else {
                    telegramText = `📸 <b>Новое фото в альбоме:</b>\n\n<b>Автор:</b> <a href="https://vk.com/id${newPhoto.user_id}">${newPhotoUser || `ID ${newPhoto.user_id}`}</a>\n<b>Описание:</b> ${escapeHtml(newPhoto.text || 'Без описания')}\n\n<a href="https://vk.com/photo${newPhoto.owner_id}_${newPhoto.id}">Посмотреть фото</a>`;
                }
                break;
            case 'video_new':
                const newVideo = object;
                const newVideoUser = await getVkUserName(newVideo.user_id || newVideo.owner_id);
                let directVideoUrl = null;
                try {
                    const videoResp = await axios.get(`https://api.vk.com/method/video.get`, {
                        params: {
                            videos: `${newVideo.owner_id}_${newVideo.id}`,
                            access_token: VK_SERVICE_KEY,
                            v: '5.131'
                        },
                        timeout: 5000
                    });
                    if (videoResp.data?.response?.items?.[0]?.files) {
                        directVideoUrl = videoResp.data.response.items[0].files.mp4_1080 ||
                                         videoResp.data.response.items[0].files.mp4_720 ||
                                         videoResp.data.response.items[0].files.mp4_480;
                    }
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] Ошибка при получении URL видео через VK API:`, error.message);
                }

                if (directVideoUrl) {
                    await sendTelegramMedia(TELEGRAM_CHAT_ID, 'video', directVideoUrl, `🎥 <b>Новое видео в VK:</b>\n\n<b>Название:</b> ${escapeHtml(newVideo.title || 'Без названия')}\n<b>Автор:</b> <a href="https://vk.com/id${newVideo.owner_id}">${newVideoUser || `ID ${newVideo.owner_id}`}</a>\n\n<a href="https://vk.com/video${newVideo.owner_id}_${newVideo.id}">Посмотреть видео</a>`);
                } else {
                    telegramText = `🎥 <b>Новое видео в VK:</b>\n\n<b>Название:</b> ${escapeHtml(newVideo.title || 'Без названия')}\n<b>Автор:</b> <a href="https://vk.com/id${newVideo.owner_id}">${newVideoUser || `ID ${newVideo.owner_id}`}</a>\n\n<a href="https://vk.com/video${newVideo.owner_id}_${newVideo.id}">Посмотреть видео</a> (прямая отправка недоступна)`;
                }
                break;
            case 'audio_new':
                const newAudio = object;
                telegramText = `🎵 <b>Новая аудиозапись в VK:</b>\n\n<b>Исполнитель:</b> ${escapeHtml(newAudio.artist)}\n<b>Название:</b> ${escapeHtml(newAudio.title)}\n\n<a href="https://vk.com/audio${newAudio.owner_id}_${newAudio.id}">Прослушать</a>`;
                break;
            case 'market_order_new':
                const newOrder = object;
                const orderUser = await getVkUserName(newOrder.user_id);
                telegramText = `🛒 <b>Новый заказ в магазине:</b>\n\n<b>Заказчик:</b> <a href="https://vk.com/id${newOrder.user_id}">${orderUser || `ID ${newOrder.user_id}`}</a>\n<b>Сумма:</b> ${newOrder.total_price} ${newOrder.currency_text}\n<b>Статус:</b> ${newOrder.status_name}`;
                break;
            case 'message_new':
                const newMessage = object;
                const newMessageUser = await getVkUserName(newMessage.from_id);
                const attachmentsSummaryMessage = await processAttachments(newMessage.attachments, TELEGRAM_CHAT_ID, 'Новое сообщение:');
                telegramText = `✉️ <b>Новое сообщение от подписчика:</b>\n\n<b>От:</b> <a href="https://vk.com/id${newMessage.from_id}">${newMessageUser || `ID ${newMessage.from_id}`}</a>\n<b>Текст:</b> ${escapeHtml(newMessage.text)}\n\n<a href="https://vk.com/im?sel=${newMessage.peer_id}">Ответить</a>${attachmentsSummaryMessage}`;
                break;
            case 'message_reply':
                const replyMessage = object;
                const replyUser = await getVkUserName(replyMessage.from_id);
                telegramText = `📝 <b>Новый ответ на сообщение в VK:</b>\n\n<b>От:</b> <a href="https://vk.com/id${replyMessage.from_id}">${replyUser || `ID ${replyMessage.from_id}`}</a>\n<b>Текст:</b> ${escapeHtml(replyMessage.text)}\n\n<a href="https://vk.com/im?sel=${replyMessage.peer_id}">Перейти к диалогу</a>`;
                break;
            case 'like_add':
                const likeObject = object;
                const likeUser = await getVkUserName(likeObject.liker_id);
                const likedObjectType = getObjectTypeDisplayName(likeObject.object_type);
                const likedObjectLink = getObjectLinkForLike(likeObject.owner_id, likeObject.object_type, likeObject.object_id, likeObject.post_id);
                telegramText = `👍 <b>Новый лайк:</b>\n\nПользователь <a href="https://vk.com/id${likeObject.liker_id}">${likeUser || `ID ${likeObject.liker_id}`}</a> поставил лайк <a href="${likedObjectLink}">к этому ${likedObjectType}</a>.`;
                break;
            case 'like_remove':
                const unlikeObject = object;
                const unlikeUser = await getVkUserName(unlikeObject.liker_id);
                const unlikedObjectType = getObjectTypeDisplayName(unlikeObject.object_type);
                const unlikedObjectLink = getObjectLinkForLike(unlikeObject.owner_id, unlikeObject.object_type, unlikeObject.object_id, unlikeObject.post_id);
                telegramText = `💔 <b>Лайк удален:</b>\n\nПользователь <a href="https://vk.com/id${unlikeObject.liker_id}">${unlikeUser || `ID ${unlikeObject.liker_id}`}</a> удалил свой лайк <a href="${unlikedObjectLink}">с этого ${unlikedObjectType}</a>.`;
                break;
            case 'group_join':
                const joinUser = await getVkUserName(object.user_id, true);
                targetChatId = LEAD_CHAT_ID;
                telegramText = `✅ <b>Новый подписчик:</b>\n\n<a href="https://vk.com/id${object.user_id}">${joinUser.userName || `ID ${object.user_id}`}</a> присоединился к сообществу!\n\n${joinUser.userInfo}`;
                break;
            case 'group_leave':
                const leaveUser = await getVkUserName(object.user_id, true);
                targetChatId = LEAD_CHAT_ID;
                telegramText = `❌ <b>Пользователь покинул сообщество:</b>\n\n<a href="https://vk.com/id${object.user_id}">${leaveUser.userName || `ID ${object.user_id}`}</a> покинул сообщество.\n\n${leaveUser.userInfo}`;
                break;
            case 'user_block':
                const blockedUser = await getVkUserName(object.user_id);
                targetChatId = SERVICE_CHAT_ID;
                isServiceMessage = true;
                telegramText = `🚫 <b>Пользователь заблокирован:</b>\n\n<a href="https://vk.com/id${object.user_id}">${blockedUser || `ID ${object.user_id}`}</a> был заблокирован администратором <a href="https://vk.com/id${object.admin_id}">ID ${object.admin_id}</a>.
<b>Причина:</b> ${escapeHtml(object.reason || 'Не указана')}`;
                break;
            case 'user_unblock':
                const unblockedUser = await getVkUserName(object.user_id);
                targetChatId = SERVICE_CHAT_ID;
                isServiceMessage = true;
                telegramText = `🔓 <b>Пользователь разблокирован:</b>\n\n<a href="https://vk.com/id${object.user_id}">${unblockedUser || `ID ${object.user_id}`}</a> был разблокирован администратором <a href="https://vk.com/id${object.admin_id}">ID ${object.admin_id}</a>.`;
                break;
            case 'lead_forms_new':
                const lead = object;
                const leadUser = await getVkUserName(lead.user_id);
                const groupInfo = await getVkGroupInfo(lead.group_id);
                targetChatId = LEAD_CHAT_ID;
                let answersText = lead.answers.map(ans => `<b>${escapeHtml(ans.question)}:</b> ${escapeHtml(ans.answer)}`).join('\n');
                telegramText = `📝 <b>Новая заявка по форме: ${escapeHtml(lead.form_name)}</b>\n\n<b>Сообщество:</b> <a href="https://vk.com/${groupInfo.screen_name}">${groupInfo.name}</a>\n<b>Пользователь:</b> <a href="https://vk.com/id${lead.user_id}">${leadUser || `ID ${lead.user_id}`}</a>\n\n${answersText}\n\n<a href="https://vk.com/club${lead.group_id}">Перейти к сообществу</a>`;
                break;
            default:
                break;
        }

        if (telegramText) {
            await sendTelegramMessageWithRetry(targetChatId, telegramText, { parse_mode: 'HTML' });
        } else if (targetChatId === TELEGRAM_CHAT_ID) { // Убедимся, что мы не отправляем "Некорректный объект" в служебный чат
            if (type === 'video_new') {
                await sendTelegramMessageWithRetry(targetChatId, `🎥 <b>Новое видео в VK:</b> (некорректный объект видео)`, { parse_mode: 'HTML' });
            } else if (type === 'wall_post_new') {
                await sendTelegramMessageWithRetry(targetChatId, `📝 <b>Новый пост на стене VK:</b> (некорректный объект поста)`, { parse_mode: 'HTML' });
            } else if (type === 'wall_repost') {
                await sendTelegramMessageWithRetry(targetChatId, `🔁 <b>Новый репост в VK:</b> (некорректный объект репоста)`, { parse_mode: 'HTML' });
            }
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Критическая ошибка при обработке события VK:`, error);
        try {
            await sendTelegramMessageWithRetry(SERVICE_CHAT_ID, `❌ <b>Критическая ошибка при обработке события VK:</b>\nТип: <code>${escapeHtml(type)}</code>\nСообщение: ${escapeHtml(error.message || 'Неизвестная ошибка')}\n\nПроверьте логи Railway для деталей.`, { parse_mode: 'HTML' });
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
    // Загружаем настройки событий из Firestore при запуске
    loadEventSettings();
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
    }).catch((err) => {
        console.error(`[${new Date().toISOString()}] Ошибка при установке команд Telegram бота:`, err.message);
    });
});
