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
const VK_API_TOKEN = process.env.VK_API_TOKEN; // Добавляем VK_API_TOKEN для нового запроса

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !VK_API_TOKEN) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные (VK_GROUP_ID, VK_SECRET_KEY, VK_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VK_API_TOKEN) установлены.');
    process.exit(1); // Завершаем процесс, если переменные не установлены
}

// Инициализация Telegram бота
// Внимание: для работы команд бота, он должен быть добавлен в чат и иметь доступ к сообщениям.
// Если бот должен отвечать на команды в приватном чате, TELEGRAM_CHAT_ID должен быть ID этого приватного чата.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true }); // Включаем polling для приема команд

// Инициализация кэша для дедупликации (TTL 60 секунд)
// Внимание: Этот кэш является in-memory и будет сброшен при каждом перезапуске контейнера на Railway.
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Временное хранилище для настроек событий (не сохраняется при перезапусках Railway)
// Добавлено событие lead_forms_new
const eventToggleState = {
    'message_new': true,
    'lead_forms_new': true, // Новое событие для отслеживания заявок
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
};

// Вспомогательный словарь для красивых названий событий
const EVENT_NAMES = {
    'message_new': 'Новое сообщение',
    'lead_forms_new': 'Новая заявка',
    'wall_post_new': 'Новый пост',
    'wall_repost': 'Новый репост',
    'wall_reply_new': 'Новый коммент. к посту',
    'wall_reply_edit': 'Изменён. коммент. к посту',
    'wall_reply_delete': 'Удалён. коммент. к посту',
    'board_post_new': 'Новый пост в обсуждении',
    'board_post_edit': 'Изменён. пост в обсуждении',
    'board_post_delete': 'Удалён. пост в обсуждении',
    'photo_new': 'Новое фото',
    'photo_comment_new': 'Новый коммент. к фото',
    'photo_comment_edit': 'Изменён. коммент. к фото',
    'photo_comment_delete': 'Удалён. коммент. к фото',
    'video_new': 'Новое видео',
    'video_comment_new': 'Новый коммент. к видео',
    'video_comment_edit': 'Изменён. коммент. к видео',
    'video_comment_delete': 'Удалён. коммент. к видео',
    'audio_new': 'Новое аудио',
    'market_order_new': 'Новый заказ',
    'market_comment_new': 'Новый коммент. к товару',
    'market_comment_edit': 'Изменён. коммент. к товару',
    'market_comment_delete': 'Удалён. коммент. к товару',
    'poll_vote_new': 'Новый голос в опросе',
    'group_join': 'Новый участник',
    'group_leave': 'Участник покинул группу',
    'group_change_photo': 'Смена фото группы',
    'group_change_settings': 'Смена настроек группы',
    'group_officers_edit': 'Изменён. список руководителей',
    'user_block': 'Пользователь заблокирован',
    'user_unblock': 'Пользователь разблокирован',
    'like_add': 'Новый лайк',
    'like_remove': 'Удалён. лайк',
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

// Функция для отправки сообщения в VK с клавиатурой
async function sendVkMessageWithKeyboard(peerId) {
    const buttons = Object.keys(eventToggleState).map(eventType => {
        const status = eventToggleState[eventType];
        const buttonText = `${EVENT_NAMES[eventType] || eventType} (${status ? 'Вкл.' : 'Выкл.'})`;
        return {
            "action": {
                "type": "text",
                "label": buttonText,
                "payload": JSON.stringify({ command: 'toggle_notification', event_type: eventType })
            },
            "color": status ? "primary" : "negative"
        };
    });

    const keyboard = {
        "one_time": false,
        "buttons": buttons.map(btn => [btn]) // Каждый элемент - это массив с одной кнопкой
    };

    try {
        await axios.post('https://api.vk.com/method/messages.send', null, {
            params: {
                peer_id: peerId,
                message: 'Выберите тип событий для включения/выключения уведомлений:',
                keyboard: JSON.stringify(keyboard),
                access_token: VK_SERVICE_KEY,
                v: '5.131',
                random_id: crypto.randomInt(2**31 - 1)
            },
            timeout: 5000
        });
        console.log(`[${new Date().toISOString()}] Клавиатура успешно отправлена в VK. `);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при отправке клавиатуры в VK:`, error.response ? error.response.data : error.message);
    }
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
        // Отправляем сообщение об ошибке в Telegram (в основной чат)
        try {
            await bot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ Ошибка при получении имени пользователя VK (ID: ${userId}): ${escapeHtml(error.message || 'Неизвестная ошибка')}. Событие будет отправлено с ID.`, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (telegramError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке уведомления об ошибке в Telegram:`, telegramError.message);
        }
        return null; // Возвращаем null при ошибке
    }
}

// Новая асинхронная функция для получения количества лайков для поста
// Используем wall.getById, так как он предоставляет детальную информацию о посте
async function getPostLikesCount(ownerId, postId) {
    try {
        const response = await axios.get('https://api.vk.com/method/wall.getById', {
            params: {
                posts: `${ownerId}_${postId}`,
                access_token: VK_API_TOKEN,
                v: '5.131'
            },
            timeout: 5000 // Таймаут 5 секунд
        });
        
        if (response.data && response.data.response && response.data.response[0] && response.data.response[0].likes) {
            return response.data.response[0].likes.count;
        }
        console.warn(`[${new Date().toISOString()}] VK API не вернул количество лайков для поста. Ответ:`, response.data);
        return null;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Ошибка при получении количества лайков для поста ${ownerId}_${postId}:`, error.response ? error.response.data : error.message);
        return null;
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
        // Можно отправить критическое уведомление, но чтобы не спамить, ограничимся логом.
    }
}

// Функция для отправки мультимедиа в Telegram
async function sendTelegramMedia(chatId, type, fileUrl, caption, options = {}) {
    try {
        // Скачиваем файл с VK URL
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
    let attachmentsSummary = ''; // Это будет добавлено к основному сообщению
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
                    fallbackLink = photoUrl; // Все равно предоставляем ссылку для контекста
                }
                attachmentsSummary += `📸 <a href="${fallbackLink || 'javascript:void(0)'}">Фото</a>`;
                if (photo.text) attachmentsSummary += ` <i>(${escapeHtml(photo.text)})</i>`;
                attachmentsSummary += '\n';
                break;
            case 'video':
                const video = attach.video;
                let directVideoUrl = null;
                // Пытаемся получить прямую MP4 ссылку сначала
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
                            // Приоритизируем MP4 более высокого качества
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
                    fallbackLink = directVideoUrl; // Предоставляем прямую ссылку, если успешно
                } else if (video.player) { // Откат к URL проигрывателя, если прямая ссылка не найдена
                    fallbackLink = video.player;
                } else if (video.owner_id && video.id) { // Откат к ссылке на страницу VK
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
            case 'wall': // Вложенный пост
                const wallPost = attach.wall;
                if (wallPost.owner_id && wallPost.id) {
                    attachmentsSummary += `📝 Вложенный пост: <a href="https://vk.com/wall${wallPost.owner_id}_${wallPost.id}">Ссылка</a>\n`;
                }
                break;
            case 'graffiti':
                const graffiti = attach.graffiti;
                if (graffiti && graffiti.url) {
                    // Граффити обычно являются изображениями, можно попробовать отправить напрямую как фото
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
        case 'post':
            return 'посту';
        case 'photo':
            return 'фотографии';
        case 'video':
            return 'видео';
        case 'comment':
            return 'комментарию';
        case 'topic':
            return 'обсуждению';
        case 'market':
            return 'товару';
        default:
            return `объекту типа <code>${escapeHtml(type)}</code>`;
    }
}

// Helper to construct VK object links for likes
function getObjectLinkForLike(ownerId, objectType, objectId, postId) {
    // Для лайков на комментарии, если есть post_id, используем его для построения ссылки на комментарий в контексте поста
    if (objectType === 'comment' && postId) {
        return `https://vk.com/wall${ownerId}_${postId}?reply=${objectId}`;
    }
    // Для остальных типов, строим простую ссылку
    switch (objectType) {
        case 'post':
            return `https://vk.com/wall${ownerId}_${objectId}`;
        case 'photo':
            return `https://vk.com/photo${ownerId}_${objectId}`;
        case 'video':
            return `https://vk.com/video${ownerId}_${objectId}`;
        case 'comment':
            return `https://vk.com/id${ownerId}?w=wall${ownerId}_${objectId}`; // Fallback для комментариев без post_id
        case 'topic':
            return `https://vk.com/topic-${VK_GROUP_ID}_${objectId}`;
        case 'market':
            return `https://vk.com/market-${ownerId}?w=product-${ownerId}_${objectId}`;
        default:
            return null;
    }
}

// --- Обработчики команд Telegram ---
// Эти команды работают в основном Telegram чате
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
    const helpMessage = ` 👋 *Доступные команды:*
/status - Проверить статус бота.
/help - Показать это сообщение.
/my_chat_id - Узнать свой ID чата.
/settings - Показать настройки уведомлений и отправить клавиатуру.

*Управление уведомлениями через клавиатуру:*
Нажмите на кнопку с названием события, чтобы переключить его состояние. "Вкл." означает, что уведомления для этого события будут отправляться в чат.

*Как работать с этим ботом:*
1. Установите все переменные окружения на вашем хостинге.
2. Пропишите Callback API в настройках вашей группы VK.
3. Бот начнет отправлять уведомления о включенных событиях в чат с ID: <code>${TELEGRAM_CHAT_ID}</code>.

_Этот бот был создан на основе открытого исходного кода._
`;
    await sendTelegramMessageWithRetry(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/my_chat_id/, async (msg) => {
    const chatId = msg.chat.id;
    await sendTelegramMessageWithRetry(chatId, `Ваш ID чата: <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== TELEGRAM_CHAT_ID) {
        await sendTelegramMessageWithRetry(chatId, 'Извините, эта команда доступна только в основном чате.');
        return;
    }
    // Отправляем клавиатуру с настройками
    await sendVkMessageWithKeyboard(TELEGRAM_CHAT_ID);
    await sendTelegramMessageWithRetry(chatId, 'Отправил в VK клавиатуру для управления уведомлениями. Нажмите на кнопку, чтобы включить/выключить событие.');
});

// Основной обработчик команд от Telegram
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Игнорируем команды, которые мы уже обработали
    if (text && (text.startsWith('/status') || text.startsWith('/help') || text.startsWith('/my_chat_id') || text.startsWith('/settings'))) {
        return;
    }

    // Обработка команд с клавиатуры VK
    if (text && msg.reply_to_message && msg.reply_to_message.text === 'Выберите тип событий для включения/выключения уведомлений:') {
        const payload = JSON.parse(text.split('(')[0].trim());
        if (payload && payload.command === 'toggle_notification') {
            const eventType = payload.event_type;
            eventToggleState[eventType] = !eventToggleState[eventType];
            await sendVkMessageWithKeyboard(chatId); // Обновляем клавиатуру
            const status = eventToggleState[eventType] ? 'включены' : 'выключены';
            await sendTelegramMessageWithRetry(chatId, `Уведомления для события "${EVENT_NAMES[eventType]}" теперь ${status}.`);
        }
    }
});


// Главный обработчик запросов от VK Callback API
app.post('/', async (req, res) => {
    const { body } = req;
    const type = body.type;

    console.log(`[${new Date().toISOString()}] Получено событие от VK: ${type}`);

    // Проверка на наличие подписи запроса
    const vkSignature = req.headers['x-vk-signature'];
    const calculatedSignature = crypto.createHmac('sha256', VK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    if (vkSignature !== calculatedSignature) {
        console.warn(`[${new Date().toISOString()}] Ошибка: Неверная подпись запроса от VK. Возможно, это попытка подделки. VK Signature: ${vkSignature}, Calculated Signature: ${calculatedSignature}`);
        res.status(403).send('Forbidden');
        return;
    }

    // Обработка запроса подтверждения
    if (type === 'confirmation') {
        if (body.group_id == VK_GROUP_ID) {
            console.log(`[${new Date().toISOString()}] Запрос подтверждения успешно обработан.`);
            return res.send(VK_SECRET_KEY);
        }
        console.warn(`[${new Date().toISOString()}] Запрос подтверждения для неверной группы.`);
        return res.status(400).send('Bad Request');
    }

    // Проверка, что уведомления для данного типа события включены
    if (!eventToggleState[type]) {
        console.log(`[${new Date().toISOString()}] Уведомления для события ${type} отключены. Запрос игнорируется.`);
        res.send('ok');
        return;
    }

    // Проверка на дедупликацию
    const eventHash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex');
    if (deduplicationCache.has(eventHash)) {
        console.warn(`[${new Date().toISOString()}] Обнаружено дублирующее событие ${type}, игнорируется.`);
        res.send('ok');
        return;
    }
    deduplicationCache.set(eventHash, true);


    let telegramMessage = '';
    let parseMode = 'HTML'; // Используем HTML по умолчанию

    try {
        switch (type) {
            case 'message_new':
                const message = body.object.message;
                const user = body.object.client_info;
                const attachments = message.attachments;

                let attachmentsSummary = await processAttachments(attachments, TELEGRAM_CHAT_ID, `💬 Новое сообщение от VK:`);

                const messageText = message.text ? `\n\n${escapeHtml(message.text)}` : '';
                const userLink = `<a href="https://vk.com/id${message.from_id}">пользователя</a>`;

                telegramMessage = `💬 <b>Новое сообщение от VK</b>
    - От: ${userLink} (ID: <code>${message.from_id}</code>)
    - Текст:${messageText}
    ${attachmentsSummary}`;
                break;
            case 'lead_forms_new':
                const lead = body.object;
                const formLink = `https://vk.com/app${lead.form_id}`;
                const formTitle = escapeHtml(lead.lead_name || 'Неизвестная форма');

                telegramMessage = `📝 <b>Новая заявка в VK:</b>
    - Форма: <a href="${formLink}">${formTitle}</a>
    - От: <a href="https://vk.com/id${lead.user_id}">пользователя</a> (ID: <code>${lead.user_id}</code>)
    - Заявка ID: <code>${lead.lead_id}</code>
    - Дата: ${new Date(lead.date * 1000).toLocaleString()}`;
                break;
            case 'wall_post_new':
                const post = body.object;
                const postUrl = `https://vk.com/wall${post.owner_id}_${post.id}`;
                const postText = post.text ? `\n\n${escapeHtml(post.text)}` : '<i>(Без текста)</i>';
                const attachmentsSummaryPost = await processAttachments(post.attachments, TELEGRAM_CHAT_ID, `📝 Новый пост:`);
                telegramMessage = `🔔 <b>Новый пост в VK</b>
    - Автор: <a href="https://vk.com/id${post.from_id}">пользователь</a> (ID: <code>${post.from_id}</code>)
    - Пост: <a href="${postUrl}">ссылка</a>
    - Текст поста:${postText}
    ${attachmentsSummaryPost}`;
                break;
            case 'wall_repost':
                const repost = body.object;
                const repostUrl = `https://vk.com/wall${repost.owner_id}_${repost.id}`;
                const originalPost = repost.copy_history?.[0];
                let originalPostInfo = '';
                if (originalPost) {
                    originalPostInfo = ` на <a href="https://vk.com/wall${originalPost.owner_id}_${originalPost.id}">оригинальный пост</a>`;
                }
                const repostText = repost.text ? `\n\n${escapeHtml(repost.text)}` : '<i>(Без текста)</i>';
                const attachmentsSummaryRepost = await processAttachments(repost.attachments, TELEGRAM_CHAT_ID, `📝 Новый репост:`);
                telegramMessage = `🔁 <b>Новый репост в VK</b>
    - Автор: <a href="https://vk.com/id${repost.from_id}">пользователь</a> (ID: <code>${repost.from_id}</code>)
    - Репост: <a href="${repostUrl}">ссылка</a>${originalPostInfo}
    - Текст репоста:${repostText}
    ${attachmentsSummaryRepost}`;
                break;
            case 'wall_reply_new':
            case 'wall_reply_edit':
            case 'wall_reply_delete':
                const reply = body.object;
                const replyUrl = `https://vk.com/wall${reply.owner_id}_${reply.post_id}?reply=${reply.id}`;
                const replyText = reply.text ? `\n\n${escapeHtml(reply.text)}` : '<i>(Без текста)</i>';
                const action = type === 'wall_reply_new' ? 'Новый' : type === 'wall_reply_edit' ? 'Изменён' : 'Удалён';
                telegramMessage = `🗣️ <b>${action} комментарий к посту</b>
    - Автор: <a href="https://vk.com/id${reply.from_id}">пользователь</a> (ID: <code>${reply.from_id}</code>)
    - Комментарий: <a href="${replyUrl}">ссылка</a>
    - Текст комментария:${replyText}`;
                break;
            case 'board_post_new':
            case 'board_post_edit':
            case 'board_post_delete':
                const boardPost = body.object;
                const boardPostUrl = `https://vk.com/topic-${boardPost.group_id}_${boardPost.topic_id}?post=${boardPost.id}`;
                const boardPostText = boardPost.text ? `\n\n${escapeHtml(boardPost.text)}` : '<i>(Без текста)</i>';
                const boardAction = type === 'board_post_new' ? 'Новый' : type === 'board_post_edit' ? 'Изменён' : 'Удалён';
                telegramMessage = `📝 <b>${boardAction} пост в обсуждении</b>
    - Автор: <a href="https://vk.com/id${boardPost.from_id}">пользователь</a> (ID: <code>${boardPost.from_id}</code>)
    - Пост: <a href="${boardPostUrl}">ссылка</a>
    - Текст поста:${boardPostText}`;
                break;
            case 'photo_new':
                const newPhoto = body.object;
                const newPhotoUrl = `https://vk.com/photo${newPhoto.owner_id}_${newPhoto.id}`;
                const newPhotoAttachmentsSummary = await processAttachments([{ type: 'photo', photo: newPhoto }], TELEGRAM_CHAT_ID, `📸 Новое фото:`);
                telegramMessage = `📸 <b>Новое фото в альбоме</b>
    - Автор: <a href="https://vk.com/id${newPhoto.user_id}">пользователь</a> (ID: <code>${newPhoto.user_id}</code>)
    - Фото: <a href="${newPhotoUrl}">ссылка</a>
    ${newPhotoAttachmentsSummary}`;
                break;
            case 'photo_comment_new':
            case 'photo_comment_edit':
            case 'photo_comment_delete':
                const photoComment = body.object;
                const photoCommentUrl = `https://vk.com/photo${photoComment.owner_id}_${photoComment.photo_id}?reply=${photoComment.id}`;
                const photoCommentText = photoComment.text ? `\n\n${escapeHtml(photoComment.text)}` : '<i>(Без текста)</i>';
                const photoCommentAction = type === 'photo_comment_new' ? 'Новый' : type === 'photo_comment_edit' ? 'Изменён' : 'Удалён';
                telegramMessage = `🗣️ <b>${photoCommentAction} комментарий к фото</b>
    - Автор: <a href="https://vk.com/id${photoComment.from_id}">пользователь</a> (ID: <code>${photoComment.from_id}</code>)
    - Комментарий: <a href="${photoCommentUrl}">ссылка</a>
    - Текст комментария:${photoCommentText}`;
                break;
            case 'video_new':
                const newVideo = body.object;
                const newVideoUrl = `https://vk.com/video${newVideo.owner_id}_${newVideo.id}`;
                const newVideoAttachmentsSummary = await processAttachments([{ type: 'video', video: newVideo }], TELEGRAM_CHAT_ID, `🎥 Новое видео:`);
                telegramMessage = `🎥 <b>Новое видео</b>
    - Автор: <a href="https://vk.com/id${newVideo.user_id}">пользователь</a> (ID: <code>${newVideo.user_id}</code>)
    - Видео: <a href="${newVideoUrl}">ссылка</a>
    - Заголовок: ${escapeHtml(newVideo.title || 'Без названия')}
    ${newVideoAttachmentsSummary}`;
                break;
            case 'video_comment_new':
            case 'video_comment_edit':
            case 'video_comment_delete':
                const videoComment = body.object;
                const videoCommentUrl = `https://vk.com/video${videoComment.owner_id}_${videoComment.video_id}?reply=${videoComment.id}`;
                const videoCommentText = videoComment.text ? `\n\n${escapeHtml(videoComment.text)}` : '<i>(Без текста)</i>';
                const videoCommentAction = type === 'video_comment_new' ? 'Новый' : type === 'video_comment_edit' ? 'Изменён' : 'Удалён';
                telegramMessage = `🗣️ <b>${videoCommentAction} комментарий к видео</b>
    - Автор: <a href="https://vk.com/id${videoComment.from_id}">пользователь</a> (ID: <code>${videoComment.from_id}</code>)
    - Комментарий: <a href="${videoCommentUrl}">ссылка</a>
    - Текст комментария:${videoCommentText}`;
                break;
            case 'market_order_new':
                const order = body.object;
                const orderUrl = `https://vk.com/market?act=orders&sort=new&order_id=${order.id}`;
                telegramMessage = `📦 <b>Новый заказ в магазине</b>
    - ID заказа: <code>${order.id}</code>
    - Клиент: <a href="https://vk.com/id${order.user_id}">пользователь</a> (ID: <code>${order.user_id}</code>)
    - Ссылка: <a href="${orderUrl}">Просмотреть заказ</a>
    - Статус: ${escapeHtml(order.status_name || 'Неизвестно')}`;
                break;
            case 'market_comment_new':
            case 'market_comment_edit':
            case 'market_comment_delete':
                const marketComment = body.object;
                const marketCommentUrl = `https://vk.com/market-${marketComment.group_id}?w=product-${marketComment.group_id}_${marketComment.item_id}?reply=${marketComment.id}`;
                const marketCommentText = marketComment.text ? `\n\n${escapeHtml(marketComment.text)}` : '<i>(Без текста)</i>';
                const marketCommentAction = type === 'market_comment_new' ? 'Новый' : type === 'market_comment_edit' ? 'Изменён' : 'Удалён';
                telegramMessage = `🗣️ <b>${marketCommentAction} комментарий к товару</b>
    - Автор: <a href="https://vk.com/id${marketComment.from_id}">пользователь</a> (ID: <code>${marketComment.from_id}</code>)
    - Комментарий: <a href="${marketCommentUrl}">ссылка</a>
    - Текст комментария:${marketCommentText}`;
                break;
            case 'poll_vote_new':
                const pollVote = body.object;
                const pollUrl = `https://vk.com/wall${pollVote.owner_id}_${pollVote.post_id}`; // Ссылка на пост, где был опрос
                const userNamePoll = await getVkUserName(pollVote.voter_id) || `ID: <code>${pollVote.voter_id}</code>`;
                const answerText = pollVote.option_id ? `\n    - Вариант ответа ID: <code>${pollVote.option_id}</code>` : '';
                telegramMessage = `🗳️ <b>Новый голос в опросе</b>
    - Автор: ${userNamePoll}
    - Пост: <a href="${pollUrl}">ссылка</a>
    - Опрос ID: <code>${pollVote.poll_id}</code>
    ${answerText}`;
                break;
            case 'group_join':
                const joinUser = body.object;
                const userNameJoin = await getVkUserName(joinUser.user_id) || `ID: <code>${joinUser.user_id}</code>`;
                telegramMessage = `🥳 <b>Новый участник:</b> <a href="https://vk.com/id${joinUser.user_id}">${userNameJoin}</a>`;
                break;
            case 'group_leave':
                const leaveUser = body.object;
                const userNameLeave = await getVkUserName(leaveUser.user_id) || `ID: <code>${leaveUser.user_id}</code>`;
                telegramMessage = `🚪 <b>Участник покинул группу:</b> <a href="https://vk.com/id${leaveUser.user_id}">${userNameLeave}</a>`;
                break;
            case 'user_block':
                const blockUser = body.object;
                const userNameBlock = await getVkUserName(blockUser.user_id) || `ID: <code>${blockUser.user_id}</code>`;
                const reason = blockUser.reason ? `\n    - Причина: ${escapeHtml(blockUser.reason)}` : '';
                telegramMessage = `🚫 <b>Пользователь заблокирован:</b> <a href="https://vk.com/id${blockUser.user_id}">${userNameBlock}</a>${reason}`;
                break;
            case 'user_unblock':
                const unblockUser = body.object;
                const userNameUnblock = await getVkUserName(unblockUser.user_id) || `ID: <code>${unblockUser.user_id}</code>`;
                const adminNameUnblock = await getVkUserName(unblockUser.admin_id) || `ID: <code>${unblockUser.admin_id}</code>`;
                telegramMessage = `🔓 <b>Пользователь разблокирован:</b> <a href="https://vk.com/id${unblockUser.user_id}">${userNameUnblock}</a>
    - Администратор: <a href="https://vk.com/id${unblockUser.admin_id}">${adminNameUnblock}</a>`;
                break;
            case 'like_add':
            case 'like_remove':
                const object = body.object;
                if (object) {
                    const likerName = await getVkUserName(object.liker_id) || `ID: <code>${object.liker_id}</code>`;
                    const objectLink = getObjectLinkForLike(object.owner_id, object.object_type, object.object_id, object.post_id);
                    const objectDisplayName = getObjectTypeDisplayName(object.object_type);
                    const action = type === 'like_add' ? '❤️ <b>Новый лайк в VK:</b>' : '👎 <b>Лайк удален в VK:</b>';
                    
                    let totalLikesMessage = '';
                    if (object.object_type === 'post') {
                        const totalLikesCount = await getPostLikesCount(object.owner_id, object.object_id);
                        if (totalLikesCount !== null) {
                            totalLikesMessage = `\n    - <b>Всего лайков:</b> ${totalLikesCount}`;
                        }
                    }

                    telegramMessage = `${action}
    - От: <a href="https://vk.com/id${object.liker_id}">${likerName}</a>
    - На: ${objectDisplayName} <a href="${objectLink}">ссылка</a>${totalLikesMessage}`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено ${type} без объекта:`, object);
                    telegramMessage = `❓ <b>Событие ${type}</b> (некорректный объект)`;
                }
                break;

            default:
                console.warn(`[${new Date().toISOString()}] Неизвестный или необработанный тип события: ${type}`);
                telegramMessage = `❓ <b>Неизвестное или необработанное событие:</b> <code>${escapeHtml(type)}</code>`;
                break;
        }

        // Если есть сообщение, отправляем его в Telegram
        if (telegramMessage) {
            await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, telegramMessage, { parse_mode: parseMode });
        }
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Общая ошибка при обработке события ${type}:`, error);
        await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, `⚠️ <b>Критическая ошибка при обработке события</b> <code>${escapeHtml(type)}</code>: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
    }

    res.send('ok'); // Важно всегда возвращать 'ok' для VK Callback API
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
