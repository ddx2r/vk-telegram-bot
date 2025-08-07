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
        const displayName = EVENT_NAMES[type] || type;
        eventList += `\`${displayName}\`: ${eventToggleState[type] ? '✅ Включено' : '❌ Отключено'}\n`;
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
        const displayName = EVENT_NAMES[eventType] || eventType;
        await sendTelegramMessageWithRetry(chatId, `Уведомления для события \`${displayName}\` теперь ${status}.`);
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

    // Исключаем нежелательные типы событий (typing_status, message_read, message_reply)
    if (type === 'typing_status' || type === 'message_read' || type === 'message_reply') {
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
        let userName = '';
        let authorDisplay = '';
        let ownerDisplay = '';
        let attachmentsInfo = '';
        let messageText = '';

        switch (type) {
            case 'message_new':
                const message = object.message;
                const messagePayload = message.payload ? JSON.parse(message.payload) : {};
                const peerId = message.peer_id;

                if (messagePayload.command === 'toggle_notification') {
                    // Обработка нажатия на кнопку в VK
                    const eventTypeToToggle = messagePayload.event_type;
                    if (eventTypeToToggle in eventToggleState) {
                        eventToggleState[eventTypeToToggle] = !eventToggleState[eventTypeToToggle];
                        const statusText = eventToggleState[eventTypeToToggle] ? 'включены' : 'выключены';
                        const displayName = EVENT_NAMES[eventTypeToToggle] || eventTypeToToggle;
                        console.log(`[${new Date().toISOString()}] Уведомления для события '${displayName}' теперь ${statusText}.`);
                        // Отправляем сообщение-подтверждение и обновляем клавиатуру
                        await sendTelegramMessageWithRetry(TELEGRAM_CHAT_ID, `Уведомления для события <b>${displayName}</b> теперь ${statusText}.`, { parse_mode: 'HTML' });
                        await sendVkMessageWithKeyboard(peerId);
                    } else {
                        console.warn(`[${new Date().toISOString()}] Неизвестный тип события в payload: ${eventTypeToToggle}`);
                        await sendVkMessageWithKeyboard(peerId);
                    }
                    return res.send('ok'); // Важно завершить обработку здесь

                } else if (message.text.trim().toLowerCase() === '/list_events') {
                    // Обработка текстовой команды /list_events из VK
                    await sendVkMessageWithKeyboard(peerId);
                    return res.send('ok'); // Важно завершить обработку здесь
                }
                
                // Если это обычное сообщение, продолжаем обработку
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

            case 'lead_forms_new':
                const leadData = object;
                if (leadData) {
                    userName = await getVkUserName(leadData.user_id);
                    const userDisplay = userName ? userName : `ID ${leadData.user_id}`;
                    const formName = leadData.form_name;
                    const answers = leadData.answers;

                    telegramMessage = `📈 <b>Новая заявка по форме:</b>\n`;
                    telegramMessage += `<b>Форма:</b> ${escapeHtml(formName)}\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${leadData.user_id}">${userDisplay}</a>\n`;
                    
                    if (answers && answers.length > 0) {
                        telegramMessage += `<b>Ответы:</b>\n`;
                        answers.forEach(answer => {
                            if (answer.question && answer.answer) {
                                telegramMessage += ` - ${escapeHtml(answer.question)}: <i>${escapeHtml(answer.answer)}</i>\n`;
                            }
                        });
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено lead_forms_new без объекта:`, object);
                    telegramMessage = `📈 <b>Новая заявка по форме:</b> (некорректный объект заявки)`;
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
                    telegramMessage = `✏️ <b>Комментарий к посту изменен в VK:</b> (некорректный объект комментария)`;
                }
                break;

            case 'wall_reply_delete':
                const wallCommentDelete = object;
                if (wallCommentDelete) {
                    telegramMessage = `🗑️ <b>Комментарий к посту удален в VK:</b>\n`;
                    if (wallCommentDelete.post_id) {
                         telegramMessage += `<b>ID комментария:</b> <code>${wallCommentDelete.id}</code>\n`;
                         telegramMessage += `<a href="https://vk.com/wall${wallCommentDelete.owner_id}_${wallCommentDelete.post_id}">Ссылка на пост</a>\n`;
                    } else {
                        telegramMessage += `<b>ID комментария:</b> <code>${wallCommentDelete.id}</code>\n`;
                        telegramMessage += `<b>ID поста:</b> <code>${wallCommentDelete.post_id}</code>\n`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_reply_delete без объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к посту удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_new':
                const boardPost = object;
                if (boardPost) {
                    userName = await getVkUserName(boardPost.from_id);
                    authorDisplay = userName ? userName : `ID ${boardPost.from_id}`;
                    attachmentsInfo = await processAttachments(boardPost.attachments, TELEGRAM_CHAT_ID, `Пост в обсуждении от ${authorDisplay}:`);

                    telegramMessage = `📝 <b>Новый пост в обсуждении VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${boardPost.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/topic-${VK_GROUP_ID}_${boardPost.topic_id}?post=${boardPost.id}">Ссылка на пост</a>\n`;
                    if (boardPost.text) {
                        telegramMessage += `<i>${escapeHtml(boardPost.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_new без объекта:`, object);
                    telegramMessage = `📝 <b>Новый пост в обсуждении VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_edit':
                const boardPostEdit = object;
                if (boardPostEdit) {
                    userName = await getVkUserName(boardPostEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${boardPostEdit.from_id}`;
                    attachmentsInfo = await processAttachments(boardPostEdit.attachments, TELEGRAM_CHAT_ID, `Измененный пост в обсуждении от ${authorDisplay}:`);

                    telegramMessage = `✏️ <b>Пост в обсуждении изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${boardPostEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/topic-${VK_GROUP_ID}_${boardPostEdit.topic_id}?post=${boardPostEdit.id}">Ссылка на пост</a>\n`;
                    if (boardPostEdit.text) {
                        telegramMessage += `<i>${escapeHtml(boardPostEdit.text)}</i>`;
                    } else {
                        telegramMessage += `<i>(без текста)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_edit без объекта:`, object);
                    telegramMessage = `✏️ <b>Пост в обсуждении изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_delete':
                const boardPostDelete = object;
                if (boardPostDelete) {
                    telegramMessage = `🗑️ <b>Пост в обсуждении удален в VK:</b>\n`;
                    telegramMessage += `<b>ID поста:</b> <code>${boardPostDelete.id}</code>\n`;
                    telegramMessage += `<a href="https://vk.com/topic-${VK_GROUP_ID}_${boardPostDelete.topic_id}">Ссылка на обсуждение</a>\n`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_delete без объекта:`, object);
                    telegramMessage = `🗑️ <b>Пост в обсуждении удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'photo_new':
                const photo = object;
                if (photo) {
                    userName = await getVkUserName(photo.user_id);
                    authorDisplay = userName ? userName : `ID ${photo.user_id}`;
                    attachmentsInfo = await processAttachments([{ type: 'photo', photo: photo }], TELEGRAM_CHAT_ID, `Новое фото от ${authorDisplay}:`);
                    
                    telegramMessage = `📸 <b>Новое фото в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${photo.user_id}">${authorDisplay}</a>\n`;
                    if (photo.text) {
                        telegramMessage += `<i>${escapeHtml(photo.text)}</i>\n`;
                    }
                    telegramMessage += `<a href="https://vk.com/photo${photo.owner_id}_${photo.id}">Ссылка на фото</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_new без объекта:`, object);
                    telegramMessage = `📸 <b>Новое фото в VK:</b> (некорректный объект)`;
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
                if (photoCommentDelete) {
                    telegramMessage = `🗑️ <b>Комментарий к фото удален в VK:</b>\n`;
                    telegramMessage += `<b>ID комментария:</b> <code>${photoCommentDelete.id}</code>\n`;
                    telegramMessage += `<a href="https://vk.com/photo${photoCommentDelete.owner_id}_${photoCommentDelete.photo_id}">Ссылка на фото</a>\n`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_comment_delete без объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к фото удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'video_new':
                const video = object;
                if (video) {
                    userName = await getVkUserName(video.owner_id);
                    authorDisplay = userName ? userName : `ID ${video.owner_id}`;
                    attachmentsInfo = await processAttachments([{ type: 'video', video: video }], TELEGRAM_CHAT_ID, `Новое видео от ${authorDisplay}:`);

                    telegramMessage = `🎥 <b>Новое видео в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${video.owner_id}">${authorDisplay}</a>\n`;
                    if (video.title) {
                        telegramMessage += `<b>Название:</b> <i>${escapeHtml(video.title)}</i>\n`;
                    }
                    telegramMessage += `<a href="https://vk.com/video${video.owner_id}_${video.id}">Ссылка на видео</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_new без объекта:`, object);
                    telegramMessage = `🎥 <b>Новое видео в VK:</b> (некорректный объект)`;
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
                if (videoCommentDelete) {
                    telegramMessage = `🗑️ <b>Комментарий к видео удален в VK:</b>\n`;
                    telegramMessage += `<b>ID комментария:</b> <code>${videoCommentDelete.id}</code>\n`;
                    telegramMessage += `<a href="https://vk.com/video${videoCommentDelete.owner_id}_${videoCommentDelete.video_id}">Ссылка на видео</a>\n`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_comment_delete без объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к видео удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'audio_new':
                const audio = object;
                if (audio) {
                    telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b>\n`;
                    telegramMessage += `<b>Исполнитель:</b> ${escapeHtml(audio.artist || 'Неизвестный')}\n`;
                    telegramMessage += `<b>Название:</b> ${escapeHtml(audio.title || 'Без названия')}\n`;
                    telegramMessage += `<a href="https://vk.com/audio${audio.owner_id}_${audio.id}">Ссылка на аудио</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено audio_new без объекта:`, object);
                    telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b> (некорректный объект)`;
                }
                break;
            
            case 'market_order_new':
                const order = object;
                if (order) {
                    userName = await getVkUserName(order.user_id);
                    authorDisplay = userName ? userName : `ID ${order.user_id}`;

                    telegramMessage = `🛒 <b>Новый заказ в VK:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${order.user_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Идентификатор:</b> <code>${order.id}</code>\n`;
                    if (order.items && order.items.length > 0) {
                        telegramMessage += `<b>Товары:</b>\n`;
                        order.items.forEach(item => {
                            telegramMessage += ` - <a href="https://vk.com/product-${VK_GROUP_ID}_${item.product.id}">${escapeHtml(item.product.title)}</a> (${item.quantity} шт.)\n`;
                        });
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_order_new без объекта:`, object);
                    telegramMessage = `🛒 <b>Новый заказ в VK:</b> (некорректный объект)`;
                }
                break;
            
            case 'market_comment_new':
                const marketComment = object;
                if (marketComment) {
                    userName = await getVkUserName(marketComment.from_id);
                    authorDisplay = userName ? userName : `ID ${marketComment.from_id}`;
                    
                    telegramMessage = `💬 <b>Новый комментарий к товару в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${marketComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/product-${marketComment.owner_id}_${marketComment.item_id}?reply=${marketComment.id}">Ссылка на комментарий</a>\n`;
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

            case 'market_comment_edit':
                const marketCommentEdit = object;
                if (marketCommentEdit) {
                    userName = await getVkUserName(marketCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${marketCommentEdit.from_id}`;
                    
                    telegramMessage = `✏️ <b>Комментарий к товару изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${marketCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/product-${marketCommentEdit.owner_id}_${marketCommentEdit.item_id}?reply=${marketCommentEdit.id}">Ссылка на комментарий</a>\n`;
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
                if (marketCommentDelete) {
                    telegramMessage = `🗑️ <b>Комментарий к товару удален в VK:</b>\n`;
                    telegramMessage += `<b>ID комментария:</b> <code>${marketCommentDelete.id}</code>\n`;
                    telegramMessage += `<a href="https://vk.com/product-${marketCommentDelete.owner_id}_${marketCommentDelete.item_id}">Ссылка на товар</a>\n`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_comment_delete без объекта:`, object);
                    telegramMessage = `🗑️ <b>Комментарий к товару удален в VK:</b> (некорректный объект)`;
                }
                break;

            case 'poll_vote_new':
                const pollVote = object;
                if (pollVote) {
                    userName = await getVkUserName(pollVote.member_id);
                    authorDisplay = userName ? userName : `ID ${pollVote.member_id}`;
                    
                    telegramMessage = `📊 <b>Новый голос в опросе в VK:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${pollVote.member_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>ID опроса:</b> <code>${pollVote.poll_id}</code>\n`;
                    telegramMessage += `<b>ID ответа:</b> <code>${pollVote.option_id}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено poll_vote_new без объекта:`, object);
                    telegramMessage = `📊 <b>Новый голос в опросе в VK:</b> (некорректный объект)`;
                }
                break;

            case 'group_join':
                const groupJoin = object;
                if (groupJoin) {
                    userName = await getVkUserName(groupJoin.user_id);
                    authorDisplay = userName ? userName : `ID ${groupJoin.user_id}`;

                    telegramMessage = `🚪 <b>Новый участник в группе:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${groupJoin.user_id}">${authorDisplay}</a>\n`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_join без объекта:`, object);
                    telegramMessage = `🚪 <b>Новый участник в группе:</b> (некорректный объект)`;
                }
                break;
            
            case 'group_leave':
                const groupLeave = object;
                if (groupLeave) {
                    userName = await getVkUserName(groupLeave.user_id);
                    authorDisplay = userName ? userName : `ID ${groupLeave.user_id}`;

                    telegramMessage = `🏃 <b>Участник покинул группу:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${groupLeave.user_id}">${authorDisplay}</a>\n`;
                    if (groupLeave.self) {
                        telegramMessage += `<i>(Самостоятельно)</i>`;
                    } else {
                        telegramMessage += `<i>(Был исключен)</i>`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_leave без объекта:`, object);
                    telegramMessage = `🏃 <b>Участник покинул группу:</b> (некорректный объект)`;
                }
                break;

            case 'group_change_photo':
                const groupChangePhoto = object;
                if (groupChangePhoto) {
                    telegramMessage = `🖼️ <b>Фото группы изменено:</b>\n`;
                    telegramMessage += `<b><a href="${groupChangePhoto.photo.sizes.find(s => s.type === 'x').url}">Новая фотография</a></b>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_change_photo без объекта:`, object);
                    telegramMessage = `🖼️ <b>Фото группы изменено:</b> (некорректный объект)`;
                }
                break;

            case 'group_change_settings':
                const groupChangeSettings = object;
                if (groupChangeSettings) {
                    userName = await getVkUserName(groupChangeSettings.user_id);
                    authorDisplay = userName ? userName : `ID ${groupChangeSettings.user_id}`;
                    
                    telegramMessage = `⚙️ <b>Настройки группы изменены:</b>\n`;
                    telegramMessage += `<b>Кем:</b> <a href="https://vk.com/id${groupChangeSettings.user_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Изменено:</b> <code>${groupChangeSettings.changes}</code>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_change_settings без объекта:`, object);
                    telegramMessage = `⚙️ <b>Настройки группы изменены:</b> (некорректный объект)`;
                }
                break;

            case 'group_officers_edit':
                const officerEdit = object;
                if (officerEdit) {
                    const officerName = await getVkUserName(officerEdit.user_id);
                    const officerDisplay = officerName ? officerName : `ID ${officerEdit.user_id}`;
                    
                    telegramMessage = `👮 <b>Список руководителей изменен:</b>\n`;
                    telegramMessage += `<b>Кем:</b> <a href="https://vk.com/id${officerEdit.admin_id}">${await getVkUserName(officerEdit.admin_id) || `ID ${officerEdit.admin_id}`}</a>\n`;
                    if (officerEdit.level_new > officerEdit.level_old) {
                        telegramMessage += `<b>Добавлен:</b> <a href="https://vk.com/id${officerEdit.user_id}">${officerDisplay}</a> (уровень ${officerEdit.level_new})\n`;
                    } else if (officerEdit.level_new < officerEdit.level_old) {
                        telegramMessage += `<b>Понижен/удален:</b> <a href="https://vk.com/id${officerEdit.user_id}">${officerDisplay}</a> (уровень ${officerEdit.level_old} -> ${officerEdit.level_new})\n`;
                    } else {
                         telegramMessage += `<b>Изменен:</b> <a href="https://vk.com/id${officerEdit.user_id}">${officerDisplay}</a>\n`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_officers_edit без объекта:`, object);
                    telegramMessage = `👮 <b>Список руководителей изменен:</b> (некорректный объект)`;
                }
                break;

            case 'user_block':
                const userBlock = object;
                if (userBlock) {
                    userName = await getVkUserName(userBlock.user_id);
                    authorDisplay = userName ? userName : `ID ${userBlock.user_id}`;
                    
                    telegramMessage = `⛔️ <b>Пользователь заблокирован:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${userBlock.user_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Администратор:</b> <a href="https://vk.com/id${userBlock.admin_id}">${await getVkUserName(userBlock.admin_id) || `ID ${userBlock.admin_id}`}</a>\n`;
                    telegramMessage += `<b>Причина:</b> ${userBlock.reason_id}\n`;
                    if (userBlock.comment) {
                        telegramMessage += `<b>Комментарий:</b> <i>${escapeHtml(userBlock.comment)}</i>\n`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено user_block без объекта:`, object);
                    telegramMessage = `⛔️ <b>Пользователь заблокирован:</b> (некорректный объект)`;
                }
                break;

            case 'user_unblock':
                const userUnblock = object;
                if (userUnblock) {
                    userName = await getVkUserName(userUnblock.user_id);
                    authorDisplay = userName ? userName : `ID ${userUnblock.user_id}`;
                    
                    telegramMessage = `✅ <b>Пользователь разблокирован:</b>\n`;
                    telegramMessage += `<b>Пользователь:</b> <a href="https://vk.com/id${userUnblock.user_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Администратор:</b> <a href="https://vk.com/id${userUnblock.admin_id}">${await getVkUserName(userUnblock.admin_id) || `ID ${userUnblock.admin_id}`}</a>\n`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено user_unblock без объекта:`, object);
                    telegramMessage = `✅ <b>Пользователь разблокирован:</b> (некорректный объект)`;
                }
                break;
                
            case 'like_add':
                const likeAdd = object;
                if (likeAdd) {
                    userName = await getVkUserName(likeAdd.liker_id);
                    authorDisplay = userName ? userName : `ID ${likeAdd.liker_id}`;
                    const objectTypeDisplayName = getObjectTypeDisplayName(likeAdd.object_type);
                    const objectLink = getObjectLinkForLike(likeAdd.owner_id, likeAdd.object_type, likeAdd.object_id, likeAdd.post_id);
                    const currentLikesCount = await getVkLikesCount(likeAdd.owner_id, likeAdd.object_id, likeAdd.object_type);

                    telegramMessage = `👍 <b>Новый лайк в VK!</b>\n`;
                    telegramMessage += `<b>Кто:</b> <a href="https://vk.com/id${likeAdd.liker_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>К чему:</b> ${objectLink ? `<a href="${objectLink}">${objectTypeDisplayName}</a>` : objectTypeDisplayName}\n`;
                    if (currentLikesCount !== null) {
                        telegramMessage += `<b>Всего лайков:</b> ${currentLikesCount}`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено like_add без объекта:`, object);
                    telegramMessage = `👍 <b>Новый лайк в VK:</b> (некорректный объект)`;
                }
                break;
            
            case 'like_remove':
                const likeRemove = object;
                if (likeRemove) {
                    userName = await getVkUserName(likeRemove.liker_id);
                    authorDisplay = userName ? userName : `ID ${likeRemove.liker_id}`;
                    const objectTypeDisplayName = getObjectTypeDisplayName(likeRemove.object_type);
                    const objectLink = getObjectLinkForLike(likeRemove.owner_id, likeRemove.object_type, likeRemove.object_id, likeRemove.post_id);
                    const currentLikesCount = await getVkLikesCount(likeRemove.owner_id, likeRemove.object_id, likeRemove.object_type);

                    telegramMessage = `👎 <b>Лайк удален в VK:</b>\n`;
                    telegramMessage += `<b>Кто:</b> <a href="https://vk.com/id${likeRemove.liker_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>К чему:</b> ${objectLink ? `<a href="${objectLink}">посту</a>` : objectTypeDisplayName}\n`;
                    if (currentLikesCount !== null) {
                        telegramMessage += `<b>Всего лайков:</b> ${currentLikesCount}`;
                    }
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено like_remove без объекта:`, object);
                    telegramMessage = `👎 <b>Лайк удален в VK:</b> (некорректный объект)`;
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
    console.log(`[${new Date().toISOString()}] Сервер запущен на порту ${PORT}`);
});
