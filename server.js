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
const LEAD_CHAT_ID = process.env.LEAD_CHAT_ID; // <-- Новый чат для лидов

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_SERVICE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные (VK_GROUP_ID, VK_SECRET_KEY, VK_SERVICE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) установлены.');
    process.exit(1); // Завершаем процесс, если переменные не установлены
}

// Предупреждение если LEAD_CHAT_ID не задан
if (!LEAD_CHAT_ID) {
    console.warn('Внимание: Переменная окружения LEAD_CHAT_ID не установлена. Уведомления для лидов не будут отправляться.');
}

// Инициализация Telegram бота
// Внимание: для работы команд бота, он должен быть добавлен в чат и иметь доступ к сообщениям.
// Если бот должен отвечать на команды в приватном чате, TELEGRAM_CHAT_ID должен быть ID этого приватного чата.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true }); // Включаем polling для приема команд

// Инициализация кэша для дедупликации (TTL 60 секунд)
// Внимание: Этот кэш является in-memory и будет сброшен при каждом перезапуске контейнера на Railway.
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Временное хранилище для настроек событий (не сохраняется при перезапусках Railway)
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

// Удаляем кэш имен пользователей полностью
// const userNameCache = new Map(); // УДАЛЕНО

// Функция для получения имени пользователя VK по ID
async function getVkUserName(userId) {
    if (!userId) return null;

    try {
        if (!/^\d+$/.test(userId)) {
            throw new Error(`Некорректный ID пользователя: ${userId}`);
        }

        const response = await axios.get(`https://api.vk.com/method/users.get`, {
            params: {
                user_ids: userId,
                access_token: VK_SERVICE_KEY,
                v: '5.131',
                lang: 'ru' // Гарантируем русский язык
            },
            timeout: 5000
        });

        if (response.data.error) {
            throw new Error(`VK API: ${response.data.error.error_msg}`);
        }

        if (response.data.response && response.data.response.length > 0) {
            const user = response.data.response[0];
            
            // Обработка деактивированных аккаунтов
            if (user.deactivated) {
                return `[Деактивирован] ID: ${userId}`;
            }
            
            // Форматируем имя на русском
            return `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
        }
        
        return `ID: ${userId}`;
    } catch (error) {
        console.error(`Ошибка при получении имени (ID: ${userId}):`, error.message);
        return `ID: ${userId}`;
    }
}

// Функция экранирования HTML (если еще не реализована)
function escapeHtml(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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
    // Для лайков на комментарии, если есть post_id, используем его для построения ссылки на комментарий в контексте поста
    if (objectType === 'comment' && postId) {
        return `https://vk.com/wall${ownerId}_${postId}?reply=${objectId}`;
    }

    // Для остальных типов, строим простую ссылку
    switch (objectType) {
        case 'post': return `https://vk.com/wall${ownerId}_${objectId}`;
        case 'photo': return `https://vk.com/photo${ownerId}_${objectId}`;
        case 'video': return `https://vk.com/video${ownerId}_${objectId}`;
        case 'comment': return `https://vk.com/id${ownerId}?w=wall${ownerId}_${objectId}`; // Fallback для комментариев без post_id
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


// --- Обработчик POST-запросов от VK Callback API ---

app.post('/webhook', async (req, res) => { // Маршрут /webhook
    const { type, object, group_id, secret } = req.body;

    console.log(`[${new Date().toISOString()}] Получен запрос от VK. Тип: ${type}, Group ID: ${group_id}`);

    // Проверка секретного ключа для безопасности
    if (secret !== VK_SECRET_KEY) {
        console.warn(`[${new Date().toISOString()}] Получен запрос с неверным секретным ключом: ${secret}. Ожидался: ${VK_SECRET_KEY}`);
        return res.status(403).send('Forbidden: Invalid secret key');
    }

    // Игнорируем запрос на подтверждение, так как адрес уже подтвержден
    if (type === 'confirmation') {
        console.log(`[${new Date().toISOString()}] Получен запрос подтверждения, но адрес уже подтвержден. Игнорируем.`);
        return res.send('ok');
    }

    // Исключаем нежелательные типы событий (typing_status, message_read)
    if (type === 'typing_status' || type === 'message_read') {
        console.log(`[${new Date().toISOString()}] Игнорируем событие типа: ${type}`);
        return res.send('ok');
    }

    // Проверяем, включены ли уведомления для этого типа события
    if (eventToggleState[type] === false) {
        console.log(`[${new Date().toISOString()}] Уведомления для события типа ${type} отключены. Игнорируем.`);
        return res.send('ok');
    }

    // Логика дедупликации
    const objectId = object?.id || object?.message?.id || object?.post?.id || object?.photo?.id || object?.video?.id || object?.user_id || object?.comment?.id || object?.topic_id || object?.poll_id || object?.item_id || object?.officer_id || object?.admin_id;
    const eventHash = crypto.createHash('md5').update(JSON.stringify({ type, objectId })).digest('hex');

    if (deduplicationCache.has(eventHash)) {
        console.log(`[${new Date().toISOString()}] Дублирующееся событие получено и проигнорировано: Тип: ${type}, Хеш: ${eventHash}`);
        // Закомментируем это сообщение, чтобы не засорять логи. Логика дедупликации всё ещё работает.
        // console.log(`[${new Date().toISOString()}] Дублирующееся событие получено и проигнорировано: Тип: ${type}, Хеш: ${eventHash}`);
        return res.send('ok');
    }
    deduplicationCache.set(eventHash, true);
    console.log(`[${new Date().toISOString()}] Событие принято и обработано: Тип: ${type}, Хеш: ${eventHash}`);


    // Обработка различных типов событий VK
    let telegramMessage = '';
    let parseMode = 'HTML';

    try {
  // Объявляем переменные ОДИН РАЗ в начале блока
        let telegramMessage = '';
        let parseMode = 'HTML';
        let userName = '';
        let authorDisplay = '';
        let ownerDisplay = '';
        let attachmentsInfo = '';

        switch (type) {
            case 'message_new':
                const message = object.message;
                if (message) {
                    userName = await getVkUserName(message.from_id);
                    const senderDisplay = userName ? userName : `ID ${message.from_id}`;
                    // Обрабатываем вложения отдельно после отправки основного текста
                    attachmentsInfo = await processAttachments(message.attachments, TELEGRAM_CHAT_ID, `Сообщение от ${senderDisplay}:`);

                    telegramMessage = `💬 <b>Новое сообщение в VK:</b>\n`;
                    telegramMessage += `<b>Отправитель:</b> <a href="https://vk.com/id${message.from_id}">${senderDisplay}</a>\n`;
                    if (message.text) {
                        telegramMessage += `<b>Сообщение:</b> <i>${escapeHtml(message.text)}</i>`;
                    } else {
                        telegramMessage += `<b>Сообщение:</b> <i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено message_new без объекта сообщения:`, object);
                    telegramMessage = `💬 <b>Новое сообщение в VK:</b> (некорректный объект сообщения)`;
                }
                break;

            case 'wall_post_new':
                // VK API может отправлять данные поста либо в 'object.post', либо напрямую в 'object'.
                // Мы проверяем оба варианта.
                const post = object.post || object;
                if (post && post.owner_id && post.id) {
                    const fromId = post.from_id || post.owner_id;
                    const userName = await getVkUserName(fromId);
                    const authorDisplay = userName ? userName : `ID ${fromId}`;
                    attachmentsInfo = await processAttachments(post.attachments, TELEGRAM_CHAT_ID, `Пост от ${authorDisplay}:`);

                    telegramMessage = `📝 <b>Новый пост на стене VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${fromId}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>\n`;
                    if (post.text) {
                        telegramMessage += `<i>${escapeHtml(post.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_post_new без необходимых полей:`, object);
                    telegramMessage = `📝 <b>Новый пост на стене VK:</b> (некорректный или неполный объект поста)`;
                }
                break;

            case 'wall_repost':
                const repostObject = object.post || object;
                const originalPost = repostObject?.copy_history?.[0];
                if (repostObject && originalPost) {
                    const fromId = repostObject.from_id || repostObject.owner_id;
                    userName = await getVkUserName(fromId);
                    authorDisplay = userName ? userName : `ID ${fromId}`;
                    attachmentsInfo = await processAttachments(originalPost.attachments, TELEGRAM_CHAT_ID, `Репост от ${authorDisplay}:`);

                    telegramMessage = `🔁 <b>Новый репост в VK:</b>\n`;
                    telegramMessage += `<b>Репостнул:</b> <a href="https://vk.com/id${fromId}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${originalPost.owner_id}_${originalPost.id}">Оригинальный пост</a>\n`;
                    if (originalPost.text) {
                        telegramMessage += `<i>${escapeHtml(originalPost.text.substring(0, 200) + (originalPost.text.length > 200 ? '...' : ''))}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_repost без оригинального поста или объекта:`, object);
                    telegramMessage = `🔁 <b>Новый репост в VK:</b> (некорректный объект репоста)`;
                }
                break;


            case 'wall_reply_new':
                const wallComment = object;
                if (wallComment) {
                    userName = await getVkUserName(wallComment.from_id);
                    authorDisplay = userName ? userName : `ID ${wallComment.from_id}`;
                    attachmentsInfo = await processAttachments(wallComment.attachments, TELEGRAM_CHAT_ID, `Комментарий к посту от ${authorDisplay}:`);

                    telegramMessage = `💬 <b>Новый комментарий к посту в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${wallComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${wallComment.owner_id}_${wallComment.post_id}?reply=${wallComment.id}">Ссылка на комментарий</a>\n`;
                    if (wallComment.text) {
                        telegramMessage += `<i>${escapeHtml(wallComment.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_reply_new без объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к посту в VK:</b> (некорректный объект комментария)`;
                }
                break;

            case 'wall_reply_edit':
                const wallCommentEdit = object;
                if (wallCommentEdit) {
                    userName = await getVkUserName(wallCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${wallCommentEdit.from_id}`;
                    attachmentsInfo = await processAttachments(wallCommentEdit.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к посту от ${authorDisplay}:`);

                    telegramMessage = `✏️ <b>Комментарий к посту изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${wallCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${wallCommentEdit.owner_id}_${wallCommentEdit.post_id}?reply=${wallCommentEdit.id}">Ссылка на комментарий</a>\n`;
                    if (wallCommentEdit.text) {
                        telegramMessage += `<i>${escapeHtml(wallCommentEdit.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_reply_edit без объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к посту изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'wall_reply_delete':
                const wallCommentDelete = object;
                if (wallCommentDelete && wallCommentDelete.deleter_id) {
                    userName = await getVkUserName(wallCommentDelete.deleter_id);
                    const deleterDisplay = userName ? userName : `ID ${wallCommentDelete.deleter_id}`;
                    telegramMessage = `🗑️ <b>Комментарий к посту удален в VK:</b>\n`;
                    telegramMessage += `<b>Удалил:</b> <a href="https://vk.com/id${wallCommentDelete.deleter_id}">${deleterDisplay}</a>\n`;
                    telegramMessage += `<b>Пост:</b> <a href="https://vk.com/wall${wallCommentDelete.owner_id}_${wallCommentDelete.post_id}">Пост</a>\n`;
                    telegramMessage += `ID комментария: <code>${wallCommentDelete.id}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_reply_delete без deleter_id или объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к посту удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_new':
                const boardPost = object;
                if (boardPost) {
                    userName = await getVkUserName(boardPost.from_id);
                    authorDisplay = userName ? userName : `ID ${boardPost.from_id}`;
                    attachmentsInfo = await processAttachments(boardPost.attachments, TELEGRAM_CHAT_ID, `Сообщение в обсуждении от ${authorDisplay}:`);

                    telegramMessage = `💬 <b>Новое сообщение в обсуждении VK:</b>\n`;
                    telegramMessage += `<b>Тема:</b> ${escapeHtml(boardPost.topic_title || 'Без названия')}\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${boardPost.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/topic-${boardPost.group_id}_${boardPost.topic_id}?post=${boardPost.id}">Ссылка на сообщение</a>\n`;
                    if (boardPost.text) {
                        telegramMessage += `<i>${escapeHtml(boardPost.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_new без объекта:`, object);
                    telegramMessage = `💬 <b>Новое сообщение в обсуждении VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_edit':
                const boardPostEdit = object;
                if (boardPostEdit) {
                    userName = await getVkUserName(boardPostEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${boardPostEdit.from_id}`;
                    attachmentsInfo = await processAttachments(boardPostEdit.attachments, TELEGRAM_CHAT_ID, `Измененное сообщение в обсуждении от ${authorDisplay}:`);

                    telegramMessage = `✏️ <b>Сообщение в обсуждении изменено в VK:</b>\n`;
                    telegramMessage += `<b>Тема:</b> ${escapeHtml(boardPostEdit.topic_title || 'Без названия')}\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${boardPostEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/topic-${boardPostEdit.group_id}_${boardPostEdit.topic_id}?post=${boardPostEdit.id}">Ссылка на сообщение</a>\n`;
                    if (boardPostEdit.text) {
                        telegramMessage += `<i>${escapeHtml(boardPostEdit.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_edit без объекта:`, object);
                    telegramMessage = `✏️ <b>Сообщение в обсуждении изменено в VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_delete':
                const boardPostDelete = object;
                if (boardPostDelete && boardPostDelete.id) {
                    telegramMessage = `🗑️ <b>Сообщение в обсуждении удалено в VK:</b>\n`;
                    telegramMessage += `<b>Тема:</b> ID темы <code>${boardPostDelete.topic_id}</code>\n`;
                    telegramMessage += `ID сообщения: <code>${boardPostDelete.id}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_delete без id или объекта:`, object);
                    telegramMessage = `🗑️ <b>Сообщение в обсуждении удалено в VK:</b> (некорректный объект)`;
                }
                break;

            case 'photo_new':
                const photo = object.photo;
                if (photo) {
                    userName = await getVkUserName(photo.owner_id);
                    ownerDisplay = userName ? userName : `ID ${photo.owner_id}`;
                    // Отправляем фото напрямую
                    await sendTelegramMedia(TELEGRAM_CHAT_ID, 'photo', photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url, `Новое фото от ${ownerDisplay}:`);

                    telegramMessage = `📸 <b>Новое фото в VK:</b>\n`;
                    telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${photo.owner_id}">${ownerDisplay}</a>\n`;
                    telegramMessage += `<a href="${photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url}">Ссылка на фото</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_new без объекта фото:`, object);
                    telegramMessage = `📸 <b>Новое фото в VK:</b> (некорректный объект фото)`;
                }
                break;

            case 'photo_comment_new':
                const photoComment = object;
                if (photoComment) {
                    userName = await getVkUserName(photoComment.from_id);
                    authorDisplay = userName ? userName : `ID ${photoComment.from_id}`;
                    attachmentsInfo = await processAttachments(photoComment.attachments, TELEGRAM_CHAT_ID, `Комментарий к фото от ${authorDisplay}:`);

                    telegramMessage = `💬 <b>Новый комментарий к фото в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${photoComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/photo${photoComment.owner_id}_${photoComment.photo_id}?reply=${photoComment.id}">Ссылка на комментарий</a>\n`;
                    if (photoComment.text) {
                        telegramMessage += `<i>${escapeHtml(photoComment.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_comment_new без объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к фото в VK:</b> (некорректный объект)`;
                }
                break;

            case 'photo_comment_edit':
                const photoCommentEdit = object;
                if (photoCommentEdit) {
                    userName = await getVkUserName(photoCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${photoCommentEdit.from_id}`;
                    attachmentsInfo = await processAttachments(photoCommentEdit.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к фото от ${authorDisplay}:`);

                    telegramMessage = `✏️ <b>Комментарий к фото изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${photoCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/photo${photoCommentEdit.owner_id}_${photoCommentEdit.photo_id}?reply=${photoCommentEdit.id}">Ссылка на комментарий</a>\n`;
                    if (photoCommentEdit.text) {
                        telegramMessage += `<i>${escapeHtml(photoCommentEdit.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_comment_edit без объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к фото изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'photo_comment_delete':
                const photoCommentDelete = object;
                if (photoCommentDelete && photoCommentDelete.deleter_id) {
                    userName = await getVkUserName(photoCommentDelete.deleter_id);
                    const deleterDisplay = userName ? userName : `ID ${photoCommentDelete.deleter_id}`;
                    telegramMessage = `🗑️ <b>Комментарий к фото удален в VK:</b>\n`;
                    telegramMessage += `<b>Удалил:</b> <a href="https://vk.com/id${photoCommentDelete.deleter_id}">${deleterDisplay}</a>\n`;
                    telegramMessage += `<b>Фото:</b> ID фото <code>${photoCommentDelete.photo_id}</code>\n`;
                    telegramMessage += `ID комментария: <code>${photoCommentDelete.id}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_comment_delete без deleter_id или объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к фото удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'video_new':
                const video = object.video;
                if (video) {
                    userName = await getVkUserName(video.owner_id);
                    ownerDisplay = userName ? userName : `ID ${video.owner_id}`;
                    // Пытаемся получить прямой URL для отправки
                    let videoUrl = video.player;
                    if (!videoUrl && video.owner_id && video.id) {
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
                                videoUrl = videoResp.data.response.items[0].files.mp4_1080 ||
                                           videoResp.data.response.items[0].files.mp4_720 ||
                                           videoResp.data.response.items[0].files.mp4_480 ||
                                           videoResp.data.response.items[0].files.mp4_360 ||
                                           videoResp.data.response.items[0].files.mp4_240;
                            }
                        } catch (error) {
                            console.error(`[${new Date().toISOString()}] Ошибка при получении URL видео через VK API:`, error.message);
                        }
                    }

                    if (videoUrl) {
                        await sendTelegramMedia(TELEGRAM_CHAT_ID, 'video', videoUrl, `Новое видео от ${ownerDisplay}: ${escapeHtml(video.title || 'Без названия')}`);
                    }

                    telegramMessage = `🎥 <b>Новое видео в VK:</b>\n`;
                    telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${video.owner_id}">${ownerDisplay}</a>\n`;
                    telegramMessage += `<b>Название:</b> ${escapeHtml(video.title || 'Без названия')}\n`;
                    telegramMessage += `<a href="https://vk.com/video${video.owner_id}_${video.id}">Ссылка на видео</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_new без объекта видео:`, object);
                    telegramMessage = `🎥 <b>Новое видео в VK:</b> (некорректный объект видео)`;
                }
                break;

            case 'video_comment_new':
                const videoComment = object;
                if (videoComment) {
                    userName = await getVkUserName(videoComment.from_id);
                    authorDisplay = userName ? userName : `ID ${videoComment.from_id}`;
                    attachmentsInfo = await processAttachments(videoComment.attachments, TELEGRAM_CHAT_ID, `Комментарий к видео от ${authorDisplay}:`);

                    telegramMessage = `💬 <b>Новый комментарий к видео в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${videoComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/video${videoComment.owner_id}_${videoComment.video_id}?reply=${videoComment.id}">Ссылка на комментарий</a>\n`;
                    if (videoComment.text) {
                        telegramMessage += `<i>${escapeHtml(videoComment.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_comment_new без объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к видео в VK:</b> (некорректный объект)`;
                }
                break;

            case 'video_comment_edit':
                const videoCommentEdit = object;
                if (videoCommentEdit) {
                    userName = await getVkUserName(videoCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${videoCommentEdit.from_id}`;
                    attachmentsInfo = await processAttachments(videoCommentEdit.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к видео от ${authorDisplay}:`);

                    telegramMessage = `✏️ <b>Комментарий к видео изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${videoCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/video${videoCommentEdit.owner_id}_${videoCommentEdit.video_id}?reply=${videoCommentEdit.id}">Ссылка на комментарий</a>\n`;
                    if (videoCommentEdit.text) {
                        telegramMessage += `<i>${escapeHtml(videoCommentEdit.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_comment_edit без объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к видео изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'video_comment_delete':
                const videoCommentDelete = object;
                if (videoCommentDelete && videoCommentDelete.deleter_id) {
                    userName = await getVkUserName(videoCommentDelete.deleter_id);
                    const deleterDisplay = userName ? userName : `ID ${videoCommentDelete.deleter_id}`;
                    telegramMessage = `🗑️ <b>Комментарий к видео удален в VK:</b>\n`;
                    telegramMessage += `<b>Удалил:</b> <a href="https://vk.com/id${videoCommentDelete.deleter_id}">${deleterDisplay}</a>\n`;
                    telegramMessage += `<b>Видео:</b> ID видео <code>${videoCommentDelete.video_id}</code>\n`;
                    telegramMessage += `ID комментария: <code>${videoCommentDelete.id}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_comment_delete без deleter_id или объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к видео удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'audio_new':
                const audio = object.audio;
                if (audio) {
                    userName = await getVkUserName(audio.owner_id);
                    ownerDisplay = userName ? userName : `ID ${audio.owner_id}`;
                    // Отправляем аудио напрямую
                    if (audio.url) {
                        await sendTelegramMedia(TELEGRAM_CHAT_ID, 'audio', audio.url, `Новая аудиозапись от ${ownerDisplay}: ${escapeHtml(audio.artist || 'Неизвестный')} - ${escapeHtml(audio.title || 'Без названия')}`);
                    }

                    telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b>\n`;
                    telegramMessage += `<b>Исполнитель:</b> ${escapeHtml(audio.artist || 'Неизвестный')}\n`;
                    telegramMessage += `<b>Название:</b> ${escapeHtml(audio.title || 'Без названия')}\n`;
                    telegramMessage += `<b>Добавил:</b> <a href="https://vk.com/id${audio.owner_id}">${ownerDisplay}</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено audio_new без объекта:`, object);
                    telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b> (некорректный объект)`;
                }
                break;

            case 'market_order_new':
                const order = object.order;
                if (order && order.id) {
                    userName = await getVkUserName(order.user_id);
                    const userDisplay = userName ? userName : `ID ${order.user_id}`;
                    telegramMessage = `🛒 <b>Новый заказ в VK Маркете:</b>\n`;
                    telegramMessage += `<b>Заказ ID:</b> <code>${order.id}</code>\n`;
                    telegramMessage += `<b>От:</b> <a href="https://vk.com/id${order.user_id}">${userDisplay}</a>\n`;
                    telegramMessage += `<b>Сумма:</b> ${order.total_price?.amount / 100 || 'N/A'} ${order.total_price?.currency?.name || 'руб.'}\n`;
                    telegramMessage += `<a href="https://vk.com/market?w=orders/view/${order.id}">Посмотреть заказ</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_order_new без id или объекта:`, object);
                    telegramMessage = `🛒 <b>Новый заказ в VK Маркете:</b> (некорректный объект)`;
                }
                break;

            case 'market_comment_new':
                const marketComment = object;
                if (marketComment) {
                    userName = await getVkUserName(marketComment.from_id);
                    authorDisplay = userName ? userName : `ID ${marketComment.from_id}`;
                    attachmentsInfo = await processAttachments(marketComment.attachments, TELEGRAM_CHAT_ID, `Комментарий к товару от ${authorDisplay}:`);

                    telegramMessage = `💬 <b>Новый комментарий к товару в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${marketComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Товар:</b> ID товара <code>${marketComment.item_id}</code>\n`;
                    if (marketComment.text) {
                        telegramMessage += `<i>${escapeHtml(marketComment.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_comment_new без объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к товару в VK:</b> (некорректный объект)`;
                }
                break;
				
case 'message_reply':
    const reply = object;
    if (reply.text && reply.peer_id) {
        // Пропускаем автоматические ответы бота
        if (reply.text.includes("Новая заявка по форме")) {
            console.log("Пропущен авто-ответ бота о заявке");
            return res.send('ok');
        }
        
        const userName = await getVkUserName(reply.from_id);
        const userDisplay = userName ? userName : `ID ${reply.from_id}`;
        
        let msg = `↩️ <b>Ответ бота в сообщениях:</b>\n`;
        msg += `<b>От:</b> <a href="https://vk.com/id${reply.from_id}">${userDisplay}</a>\n`;
        msg += `<b>Сообщение:</b>\n<i>${escapeHtml(reply.text)}</i>`;
        
        await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' });
    }
    break;
				
            case 'market_comment_edit':
                const marketCommentEdit = object;
                if (marketCommentEdit) {
                    userName = await getVkUserName(marketCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${marketCommentEdit.from_id}`;
                    attachmentsInfo = await processAttachments(marketCommentEdit.attachments, TELEGRAM_CHAT_ID, `Измененный комментарий к товару от ${authorDisplay}:`);

                    telegramMessage = `✏️ <b>Комментарий к товару изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${marketCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Товар:</b> ID товара <code>${marketCommentEdit.item_id}</code>\n`;
                    if (marketCommentEdit.text) {
                        telegramMessage += `<i>${escapeHtml(marketCommentEdit.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_comment_edit без объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к товару изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'market_comment_delete':
                const marketCommentDelete = object;
                if (marketCommentDelete && marketCommentDelete.deleter_id) {
                    userName = await getVkUserName(marketCommentDelete.deleter_id);
                    const deleterDisplay = userName ? userName : `ID ${marketCommentDelete.deleter_id}`;
                    telegramMessage = `🗑️ <b>Комментарий к товару удален в VK:</b>\n`;
                    telegramMessage += `<b>Удалил:</b> <a href="https://vk.com/id${marketCommentDelete.deleter_id}">${deleterDisplay}</a>\n`;
                    telegramMessage += `<b>Товар:</b> ID товара <code>${marketCommentDelete.item_id}</code>\n`;
                    telegramMessage += `ID комментария: <code>${marketCommentDelete.id}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_comment_delete без deleter_id или объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к товару удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'poll_vote_new':
                const pollVote = object;
                if (pollVote && pollVote.user_id) {
                    userName = await getVkUserName(pollVote.user_id);
                    const userDisplay = userName ? userName : `ID ${pollVote.user_id}`;
                    telegramMessage = `📊 <b>Новый голос в опросе VK:</b>\n`;
                    telegramMessage += `<b>От:</b> <a href="https://vk.com/id${pollVote.user_id}">${userDisplay}</a>\n`;
                    telegramMessage += `<b>Опрос ID:</b> <code>${pollVote.poll_id}</code>\n`;
                    telegramMessage += `<b>Вариант ответа ID:</b> <code>${pollVote.option_id}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено poll_vote_new без user_id или объекта:`, object);
                    telegramMessage = `📊 <b>Новый голос в опросе VK:</b> (некорректный объект)`;
                }
                break;

            case 'group_join':
                const joinEvent = object;
                if (joinEvent && joinEvent.user_id) {
                    userName = await getVkUserName(joinEvent.user_id);
                    const joinUserDisplay = userName ? userName : `ID ${joinEvent.user_id}`;

                    telegramMessage = `🎉 <b>Приветствуем нового участника!</b>\n✨ В нашу дружную команду присоединился(ась) <a href="https://vk.com/id${joinEvent.user_id}">${joinUserDisplay}</a>! Давайте поприветствуем!`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_join без user_id или объекта:`, object);
                    telegramMessage = `🎉 <b>Приветствуем нового участника!</b> (некорректный объект события)`;
                }
                break;

             case 'group_leave':
    const leaveEvent = object;
    if (leaveEvent && leaveEvent.user_id) {
        userName = await getVkUserName(leaveEvent.user_id);
        const leaveUserDisplay = userName ? userName : `ID ${leaveEvent.user_id}`;

        telegramMessage = `👋 <b>Проваливай!</b>\n😔 Сбежал(а) <a href="https://vk.com/id${leaveEvent.user_id}">${leaveUserDisplay}</a>. Не будем скучать!`;
        
        // Отправляем ТОЛЬКО в чат лидов (если настроен)
        if (LEAD_CHAT_ID) {
            await sendTelegramMessageWithRetry(LEAD_CHAT_ID, telegramMessage, { parse_mode: parseMode });
        } else {
            // Если чат лидов не настроен, отправляем в основной чат
            await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, telegramMessage, { parse_mode: parseMode });
        }
    } else {
        // Обработка ошибки...
    }
    break;

            case 'lead_forms_new':
    const leadForm = object;
    if (leadForm && leadForm.lead_id && leadForm.user_id) {
        try {
            const userName = await getVkUserName(leadForm.user_id);
            const userDisplay = userName ? userName : `ID ${leadForm.user_id}`;

            let telegramMessage = `📋 <b>Новая заявка в форме VK!</b>\n`;
            telegramMessage += `<b>Форма:</b> ${escapeHtml(leadForm.form_name || 'Без названия')}\n`;
            telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${leadForm.user_id}">${userDisplay}</a>\n`;

            if (leadForm.answers && leadForm.answers.length > 0) {
                telegramMessage += `<b>Данные заявки:</b>\n`;
                leadForm.answers.forEach(answer => {
                    const answerText = Array.isArray(answer.answer) 
                        ? answer.answer.join(', ') 
                        : answer.answer;
                    telegramMessage += `▸ <b>${escapeHtml(answer.key)}</b>: ${escapeHtml(answerText || '—')}\n`;
                });
            }

            if (LEAD_CHAT_ID) {
                await sendTelegramMessageWithRetry(LEAD_CHAT_ID, telegramMessage, { parse_mode: 'HTML' });
            }
        } catch (error) {
            console.error(`Ошибка обработки lead_forms_new:`, error.message);
            const fallbackMsg = `📋 <b>Новая заявка!\nФорма: ${leadForm.form_name}\nПользователь: ID ${leadForm.user_id}`;
            if (LEAD_CHAT_ID) await sendTelegramMessageWithRetry(LEAD_CHAT_ID, fallbackMsg, { parse_mode: 'HTML' });
        }
    }
    break;
                
            case 'group_change_photo':
                const changePhoto = object;
                if (changePhoto && changePhoto.user_id) {
                    userName = await getVkUserName(changePhoto.user_id);
                    const userDisplay = userName ? userName : `ID ${changePhoto.user_id}`;
                    telegramMessage = `🖼️ <b>Изменена главная фотография сообщества VK:</b>\n`;
                    telegramMessage += `<b>Изменил:</b> <a href="https://vk.com/id${changePhoto.user_id}">${userDisplay}</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_change_photo без user_id или объекта:`, object);
                    telegramMessage = `🖼️ <b>Изменена главная фотография сообщества VK:</b> (некорректный объект)`;
                }
                break;

            case 'group_change_settings':
                const changeSettings = object;
                if (changeSettings && changeSettings.user_id) {
                    userName = await getVkUserName(changeSettings.user_id);
                    const userDisplay = userName ? userName : `ID ${changeSettings.user_id}`;
                    telegramMessage = `⚙️ <b>Изменены настройки сообщества VK:</b>\n`;
                    telegramMessage += `<b>Изменил:</b> <a href="https://vk.com/id${changeSettings.user_id}">${userDisplay}</a>\n`;
                    telegramMessage += `<b>Настройка:</b> <code>${escapeHtml(changeSettings.changes?.[Object.keys(changeSettings.changes)[0]]?.field || 'Неизвестно')}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_change_settings без user_id или объекта:`, object);
                    telegramMessage = `⚙️ <b>Изменены настройки сообщества VK:</b> (некорректный объект)`;
                }
                break;

            case 'group_officers_edit':
                const officerEdit = object;
                if (officerEdit && officerEdit.admin_id && officerEdit.user_id) {
                    const adminName = await getVkUserName(officerEdit.admin_id);
                    const adminDisplay = adminName ? adminName : `ID ${officerEdit.admin_id}`;
                    const targetUserName = await getVkUserName(officerEdit.user_id);
                    const targetUserDisplay = targetUserName ? targetUserName : `ID ${officerEdit.user_id}`;

                    if (officerEdit.level_old === 0 && officerEdit.level_new > 0) {
                        telegramMessage = `👑 <b>Назначен новый руководитель в VK:</b>\n`;
                        telegramMessage += `<b>Назначил:</b> <a href="https://vk.com/id${officerEdit.admin_id}">${adminDisplay}</a>\n`;
                        telegramMessage += `<b>Назначен:</b> <a href="https://vk.com/id${officerEdit.user_id}">${targetUserDisplay}</a> (Уровень: ${officerEdit.level_new})`;
                    } else if (officerEdit.level_old > 0 && officerEdit.level_new === 0) {
                        telegramMessage = `🚫 <b>Руководитель снят в VK:</b>\n`;
                        telegramMessage += `<b>Снял:</b> <a href="https://vk.com/id${officerEdit.admin_id}">${adminDisplay}</a>\n`;
                        telegramMessage += `<b>Снят:</b> <a href="https://vk.com/id${officerEdit.user_id}">${targetUserDisplay}</a>`;
                    } else if (officerEdit.level_old > 0 && officerEdit.level_new > 0) {
                        telegramMessage = `🔄 <b>Уровень руководителя изменен в VK:</b>\n`;
                        telegramMessage += `<b>Изменил:</b> <a href="https://vk.com/id${officerEdit.admin_id}">${adminDisplay}</a>\n`;
                        telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${officerEdit.user_id}">${targetUserDisplay}</a> (С ${officerEdit.level_old} на ${officerEdit.level_new})`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_officers_edit без admin_id/user_id или объекта:`, object);
                    telegramMessage = `👑 <b>Изменение руководителей сообщества VK:</b> (некорректный объект)`;
                }
                break;

            case 'user_block':
                const userBlock = object;
                if (userBlock && userBlock.user_id && userBlock.admin_id) {
                    userName = await getVkUserName(userBlock.user_id);
                    const blockedUserDisplay = userName ? userName : `ID ${userBlock.user_id}`;
                    const adminName = await getVkUserName(userBlock.admin_id);
                    const adminDisplay = adminName ? adminName : `ID ${userBlock.admin_id}`;

                    telegramMessage = `⛔ <b>Пользователь заблокирован в VK:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${userBlock.user_id}">${blockedUserDisplay}</a>\n`;
                    telegramMessage += `<b>Заблокировал:</b> <a href="https://vk.com/id${userBlock.admin_id}">${adminDisplay}</a>\n`;
                    telegramMessage += `<b>Причина:</b> ${escapeHtml(userBlock.reason_text || 'Не указана')}`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено user_block без user_id/admin_id или объекта:`, object);
                    telegramMessage = `⛔ <b>Пользователь заблокирован в VK:</b> (некорректный объект)`;
                }
                break;

            case 'user_unblock':
                const userUnblock = object;
                if (userUnblock && userUnblock.user_id && userUnblock.admin_id) {
                    userName = await getVkUserName(userUnblock.user_id);
                    const unblockedUserDisplay = userName ? userName : `ID ${userUnblock.user_id}`;
                    const adminName = await getVkUserName(userUnblock.admin_id);
                    const adminDisplay = adminName ? adminName : `ID ${userUnblock.admin_id}`;

                    telegramMessage = `✅ <b>Пользователь разблокирован в VK:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${userUnblock.user_id}">${unblockedUserDisplay}</a>\n`;
                    telegramMessage += `<b>Разблокировал:</b> <a href="https://vk.com/id${userUnblock.admin_id}">${adminDisplay}</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено user_unblock без user_id/admin_id или объекта:`, object);
                    telegramMessage = `✅ <b>Пользователь разблокирован в VK:</b> (некорректный объект)`;
                }
                break;

            case 'like_add':
            case 'like_remove':
                const isAdd = type === 'like_add';
                const likeObject = object;

                if (likeObject && likeObject.liker_id && likeObject.object_type && likeObject.object_id) {
                    let ownerId = likeObject.owner_id;
                    // Если owner_id отсутствует, по умолчанию используем ID группы
                    if (!ownerId || ownerId === null) {
                        ownerId = -group_id;
                        console.warn(`[${new Date().toISOString()}] Отсутствует owner_id в payload события '${type}'. Используем ID группы по умолчанию: ${ownerId}`);
                    }

                    const objectLink = getObjectLinkForLike(ownerId, likeObject.object_type, likeObject.object_id, likeObject.post_id);
                    const objectTypeDisplayName = getObjectTypeDisplayName(likeObject.object_type);

                    const userName = await getVkUserName(likeObject.liker_id);
                    const likerDisplay = userName ? userName : `ID ${likeObject.liker_id}`;

                    const likesCount = ownerId ? await getVkLikesCount(ownerId, likeObject.object_id, likeObject.object_type) : null;
                    const likesCountText = likesCount !== null ? ` (Всего: ${likesCount})` : '';

                    telegramMessage = `<b>${isAdd ? '❤️ Новый лайк в VK' : '💔 Лайк удален в VK'}</b>\n`;
                    telegramMessage += `<b>От:</b> <a href="https://vk.com/id${likeObject.liker_id}">${likerDisplay}</a>\n`;
                    telegramMessage += `<b>${isAdd ? 'К' : 'С'}:</b> `;

                    if (objectLink) {
                        telegramMessage += `<a href="${objectLink}">${objectTypeDisplayName}</a>`;
                    } else {
                        telegramMessage += `${objectTypeDisplayName} ID <code>${likeObject.object_id}</code>`;
                    }
                    telegramMessage += likesCountText;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено событие '${type}' без необходимых полей (liker_id, object_type, object_id):`, likeObject);
                    telegramMessage = `<b>${isAdd ? '❤️ Новый лайк в VK' : '💔 Лайк удален в VK'}:</b> (некорректный объект)`;
                }
                break;

            default:
                console.log(`[${new Date().toISOString()}] Необработанный тип события VK: ${type}. Полный объект:`, JSON.stringify(object));
                telegramMessage = `❓ <b>Неизвестное или необработанное событие VK:</b>\nТип: <code>${escapeHtml(type)}</code>\n<pre>${escapeHtml(JSON.stringify(object, null, 2).substring(0, 1000) + (JSON.stringify(object, null, 2).length > 1000 ? '...' : ''))}</pre>`;
                break;
        }

            if (telegramMessage && type !== 'lead_forms_new') {
            await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, telegramMessage, { parse_mode: parseMode });
            console.log(`[${new Date().toISOString()}] Сообщение успешно отправлено в Telegram для типа события: ${type}.`);
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Критическая ошибка при обработке события VK или отправке сообщения в Telegram для типа ${type}:`, error.response ? error.response.data : error.message);
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
    }).catch(e => {
        console.error(`[${new Date().toISOString()}] Ошибка установки команд Telegram бота:`, e.message);
    });
});
