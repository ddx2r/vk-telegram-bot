// server.js - Основной файл сервера для обработки VK Callback API и пересылки в Telegram

// Импорт необходимых модулей
const express = require('express'); // Веб-фреймворк для Node.js
const bodyParser = require('body-parser'); // Для парсинга JSON-запросов
const axios = require('axios'); // Для выполнения HTTP-запросов (к Telegram API и VK API)
const crypto = require('crypto'); // Для хеширования, используется для дедупликации
const NodeCache = require('node-cache'); // Для in-memory кэша дедупликации

// Инициализация Express приложения
const app = express();
// Использование body-parser для обработки JSON-тела запросов
app.use(bodyParser.json());

// Получение переменных окружения
// Эти переменные будут установлены на Railway
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_SECRET_KEY = process.env.VK_SECRET_KEY;
const VK_API_TOKEN = process.env.VK_API_TOKEN; // Добавлен VK API Token
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_API_TOKEN || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные (VK_GROUP_ID, VK_SECRET_KEY, VK_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) установлены.');
    process.exit(1); // Завершаем процесс, если переменные не установлены
}

// Инициализация кэша для дедупликации (TTL 60 секунд)
// Это предотвращает отправку дублирующихся сообщений в Telegram в течение 60 секунд
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

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
                access_token: VK_API_TOKEN,
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
        // Отправляем сообщение об ошибке в Telegram
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `⚠️ Ошибка при получении имени пользователя VK (ID: ${userId}): ${escapeHtml(error.message || 'Неизвестная ошибка')}. Событие будет отправлено с ID.`,
                parse_mode: 'HTML',
                timeout: 5000 // Таймаут 5 секунд для отправки уведомления об ошибке
            });
        } catch (telegramError) {
            console.error(`[${new Date().toISOString()}] Ошибка при отправке уведомления об ошибке в Telegram:`, telegramError.message);
        }
        return null; // Возвращаем null при ошибке
    }
}

// Обработчик POST-запросов от VK Callback API
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

    // Исключаем нежелательные типы событий
    if (type === 'typing_status' || type === 'message_read') {
        console.log(`[${new Date().toISOString()}] Игнорируем событие типа: ${type}`);
        return res.send('ok');
    }

    // Логика дедупликации
    // Создаем уникальный хеш для каждого события, чтобы избежать дублирования.
    // Хеш включает тип события и его уникальный идентификатор.
    const objectId = object?.id || object?.message?.id || object?.post?.id || object?.photo?.id || object?.video?.id || object?.user_id || object?.comment?.id || object?.topic_id || object?.poll_id || object?.item_id || object?.officer_id || object?.admin_id;
    const eventHash = crypto.createHash('md5').update(JSON.stringify({ type, objectId })).digest('hex');

    if (deduplicationCache.has(eventHash)) {
        console.log(`[${new Date().toISOString()}] Дублирующееся событие получено и проигнорировано: Тип: ${type}, Хеш: ${eventHash}`);
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

        switch (type) {
            case 'message_new':
                const message = object.message;
                if (message && message.text) {
                    userName = await getVkUserName(message.from_id);
                    const senderDisplay = userName ? userName : `ID ${message.from_id}`;

                    telegramMessage = `💬 <b>Новое сообщение в VK:</b>\n`;
                    telegramMessage += `<b>Отправитель:</b> <a href="https://vk.com/id${message.from_id}">${senderDisplay}</a>\n`;
                    telegramMessage += `<b>Сообщение:</b> <i>${escapeHtml(message.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено message_new без текста или объекта сообщения:`, object);
                    telegramMessage = `💬 <b>Новое сообщение в VK:</b> (без текста или с некорректным объектом сообщения)`;
                }
                break;

            case 'wall_post_new':
                const post = object.post;
                if (post && post.text) {
                    userName = await getVkUserName(post.from_id);
                    authorDisplay = userName ? userName : `ID ${post.from_id}`;

                    telegramMessage = `📝 <b>Новый пост на стене VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${post.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>\n`;
                    telegramMessage += `<i>${escapeHtml(post.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_post_new без текста или объекта поста:`, object);
                    telegramMessage = `📝 <b>Новый пост на стене VK:</b> (без текста или с некорректным объектом поста)`;
                }
                break;

            case 'wall_repost': // Новый репост записи на стене
                const repost = object.copy_history?.[0] || object.post;
                if (repost && repost.text) {
                    userName = await getVkUserName(object.owner_id); // Кто сделал репост
                    authorDisplay = userName ? userName : `ID ${object.owner_id}`;
                    telegramMessage = `🔁 <b>Новый репост в VK:</b>\n`;
                    telegramMessage += `<b>Репостнул:</b> <a href="https://vk.com/id${object.owner_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${repost.owner_id}_${repost.id}">Оригинальный пост</a>\n`;
                    telegramMessage += `<i>${escapeHtml(repost.text.substring(0, 200) + (repost.text.length > 200 ? '...' : ''))}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_repost без текста или объекта:`, object);
                    telegramMessage = `🔁 <b>Новый репост в VK:</b> (некорректный объект репоста)`;
                }
                break;

            case 'wall_reply_new': // Новый комментарий к записи на стене
                const wallComment = object;
                if (wallComment && wallComment.text) {
                    userName = await getVkUserName(wallComment.from_id);
                    authorDisplay = userName ? userName : `ID ${wallComment.from_id}`;
                    telegramMessage = `💬 <b>Новый комментарий к посту в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${wallComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${wallComment.owner_id}_${wallComment.post_id}?reply=${wallComment.id}">Ссылка на комментарий</a>\n`;
                    telegramMessage += `<i>${escapeHtml(wallComment.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_reply_new без текста или объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к посту в VK:</b> (некорректный объект комментария)`;
                }
                break;

            case 'wall_reply_edit': // Изменение комментария к записи на стене
                const wallCommentEdit = object;
                if (wallCommentEdit && wallCommentEdit.text) {
                    userName = await getVkUserName(wallCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${wallCommentEdit.from_id}`;
                    telegramMessage = `✏️ <b>Комментарий к посту изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${wallCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${wallCommentEdit.owner_id}_${wallCommentEdit.post_id}?reply=${wallCommentEdit.id}">Ссылка на комментарий</a>\n`;
                    telegramMessage += `<i>${escapeHtml(wallCommentEdit.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_reply_edit без текста или объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к посту изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'wall_reply_delete': // Удаление комментария к записи на стене
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

            case 'board_post_new': // Новое сообщение в обсуждении
                const boardPost = object;
                if (boardPost && boardPost.text) {
                    userName = await getVkUserName(boardPost.from_id);
                    authorDisplay = userName ? userName : `ID ${boardPost.from_id}`;
                    telegramMessage = `💬 <b>Новое сообщение в обсуждении VK:</b>\n`;
                    telegramMessage += `<b>Тема:</b> ${escapeHtml(boardPost.topic_title || 'Без названия')}\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${boardPost.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/topic-${boardPost.group_id}_${boardPost.topic_id}?post=${boardPost.id}">Ссылка на сообщение</a>\n`;
                    telegramMessage += `<i>${escapeHtml(boardPost.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_new без текста или объекта:`, object);
                    telegramMessage = `💬 <b>Новое сообщение в обсуждении VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_edit': // Изменение сообщения в обсуждении
                const boardPostEdit = object;
                if (boardPostEdit && boardPostEdit.text) {
                    userName = await getVkUserName(boardPostEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${boardPostEdit.from_id}`;
                    telegramMessage = `✏️ <b>Сообщение в обсуждении изменено в VK:</b>\n`;
                    telegramMessage += `<b>Тема:</b> ${escapeHtml(boardPostEdit.topic_title || 'Без названия')}\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${boardPostEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/topic-${boardPostEdit.group_id}_${boardPostEdit.topic_id}?post=${boardPostEdit.id}">Ссылка на сообщение</a>\n`;
                    telegramMessage += `<i>${escapeHtml(boardPostEdit.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено board_post_edit без текста или объекта:`, object);
                    telegramMessage = `✏️ <b>Сообщение в обсуждении изменено в VK:</b> (некорректный объект)`;
                }
                break;

            case 'board_post_delete': // Удаление сообщения в обсуждении
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
                if (photo && photo.owner_id) {
                    const photoUrl = photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url;
                    userName = await getVkUserName(photo.owner_id);
                    ownerDisplay = userName ? userName : `ID ${photo.owner_id}`;

                    telegramMessage = `📸 <b>Новое фото в VK:</b>\n`;
                    telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${photo.owner_id}">${ownerDisplay}</a>\n`;
                    telegramMessage += photoUrl ? `<a href="${photoUrl}">Ссылка на фото</a>` : `(Ссылка на фото недоступна)`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_new без owner_id или объекта фото:`, object);
                    telegramMessage = `📸 <b>Новое фото в VK:</b> (некорректный объект фото)`;
                }
                break;

            case 'photo_comment_new': // Новый комментарий к фотографии
                const photoComment = object;
                if (photoComment && photoComment.text) {
                    userName = await getVkUserName(photoComment.from_id);
                    authorDisplay = userName ? userName : `ID ${photoComment.from_id}`;
                    telegramMessage = `💬 <b>Новый комментарий к фото в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${photoComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/photo${photoComment.owner_id}_${photoComment.photo_id}?reply=${photoComment.id}">Ссылка на комментарий</a>\n`;
                    telegramMessage += `<i>${escapeHtml(photoComment.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_comment_new без текста или объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к фото в VK:</b> (некорректный объект)`;
                }
                break;

            case 'photo_comment_edit': // Изменение комментария к фотографии
                const photoCommentEdit = object;
                if (photoCommentEdit && photoCommentEdit.text) {
                    userName = await getVkUserName(photoCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${photoCommentEdit.from_id}`;
                    telegramMessage = `✏️ <b>Комментарий к фото изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${photoCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/photo${photoCommentEdit.owner_id}_${photoCommentEdit.photo_id}?reply=${photoCommentEdit.id}">Ссылка на комментарий</a>\n`;
                    telegramMessage += `<i>${escapeHtml(photoCommentEdit.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_comment_edit без текста или объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к фото изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'photo_comment_delete': // Удаление комментария к фотографии
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
                if (video && video.owner_id) {
                    userName = await getVkUserName(video.owner_id);
                    ownerDisplay = userName ? userName : `ID ${video.owner_id}`;

                    telegramMessage = `🎥 <b>Новое видео в VK:</b>\n`;
                    telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${video.owner_id}">${ownerDisplay}</a>\n`;
                    telegramMessage += `<b>Название:</b> ${escapeHtml(video.title || 'Без названия')}\n`;
                    telegramMessage += `<a href="https://vk.com/video${video.owner_id}_${video.id}">Ссылка на видео</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_new без owner_id или объекта видео:`, object);
                    telegramMessage = `🎥 <b>Новое видео в VK:</b> (некорректный объект видео)`;
                }
                break;

            case 'video_comment_new': // Новый комментарий к видео
                const videoComment = object;
                if (videoComment && videoComment.text) {
                    userName = await getVkUserName(videoComment.from_id);
                    authorDisplay = userName ? userName : `ID ${videoComment.from_id}`;
                    telegramMessage = `💬 <b>Новый комментарий к видео в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${videoComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/video${videoComment.owner_id}_${videoComment.video_id}?reply=${videoComment.id}">Ссылка на комментарий</a>\n`;
                    telegramMessage += `<i>${escapeHtml(videoComment.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_comment_new без текста или объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к видео в VK:</b> (некорректный объект)`;
                }
                break;

            case 'video_comment_edit': // Изменение комментария к видео
                const videoCommentEdit = object;
                if (videoCommentEdit && videoCommentEdit.text) {
                    userName = await getVkUserName(videoCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${videoCommentEdit.from_id}`;
                    telegramMessage = `✏️ <b>Комментарий к видео изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${videoCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/video${videoCommentEdit.owner_id}_${videoCommentEdit.video_id}?reply=${videoCommentEdit.id}">Ссылка на комментарий</a>\n`;
                    telegramMessage += `<i>${escapeHtml(videoCommentEdit.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_comment_edit без текста или объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к видео изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'video_comment_delete': // Удаление комментария к видео
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

            case 'audio_new': // Новая аудиозапись
                const audio = object.audio;
                if (audio && audio.owner_id) {
                    userName = await getVkUserName(audio.owner_id);
                    ownerDisplay = userName ? userName : `ID ${audio.owner_id}`;
                    telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b>\n`;
                    telegramMessage += `<b>Исполнитель:</b> ${escapeHtml(audio.artist || 'Неизвестный')}\n`;
                    telegramMessage += `<b>Название:</b> ${escapeHtml(audio.title || 'Без названия')}\n`;
                    telegramMessage += `<b>Добавил:</b> <a href="https://vk.com/id${audio.owner_id}">${ownerDisplay}</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено audio_new без owner_id или объекта:`, object);
                    telegramMessage = `🎵 <b>Новая аудиозапись в VK:</b> (некорректный объект)`;
                }
                break;

            case 'market_order_new': // Новый заказ в товарах
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

            case 'market_comment_new': // Новый комментарий к товару
                const marketComment = object;
                if (marketComment && marketComment.text) {
                    userName = await getVkUserName(marketComment.from_id);
                    authorDisplay = userName ? userName : `ID ${marketComment.from_id}`;
                    telegramMessage = `💬 <b>Новый комментарий к товару в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${marketComment.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Товар:</b> ID товара <code>${marketComment.item_id}</code>\n`;
                    telegramMessage += `<i>${escapeHtml(marketComment.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_comment_new без текста или объекта:`, object);
                    telegramMessage = `💬 <b>Новый комментарий к товару в VK:</b> (некорректный объект)`;
                }
                break;

            case 'market_comment_edit': // Изменение комментария к товару
                const marketCommentEdit = object;
                if (marketCommentEdit && marketCommentEdit.text) {
                    userName = await getVkUserName(marketCommentEdit.from_id);
                    authorDisplay = userName ? userName : `ID ${marketCommentEdit.from_id}`;
                    telegramMessage = `✏️ <b>Комментарий к товару изменен в VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${marketCommentEdit.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<b>Товар:</b> ID товара <code>${marketCommentEdit.item_id}</code>\n`;
                    telegramMessage += `<i>${escapeHtml(marketCommentEdit.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено market_comment_edit без текста или объекта:`, object);
                    telegramMessage = `✏️ <b>Комментарий к товару изменен в VK:</b> (некорректный объект)`;
                }
                break;

            case 'market_comment_delete': // Удаление комментария к товару
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

            case 'poll_vote_new': // Новый голос в опросе
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

                    telegramMessage = `➕ <b>Новый участник в VK:</b> <a href="https://vk.com/id${joinEvent.user_id}">${joinUserDisplay}</a> вступил в группу!`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_join без user_id или объекта:`, object);
                    telegramMessage = `➕ <b>Новый участник в VK:</b> (некорректный объект события)`;
                }
                break;

            case 'group_leave':
                const leaveEvent = object;
                if (leaveEvent && leaveEvent.user_id) {
                    userName = await getVkUserName(leaveEvent.user_id);
                    const leaveUserDisplay = userName ? userName : `ID ${leaveEvent.user_id}`;

                    telegramMessage = `➖ <b>Участник покинул VK:</b> <a href="https://vk.com/id${leaveEvent.user_id}">${leaveUserDisplay}</a> покинул группу.`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено group_leave без user_id или объекта:`, object);
                    telegramMessage = `➖ <b>Участник покинул VK:</b> (некорректный объект события)`;
                }
                break;

            case 'group_change_photo': // Изменение главной фотографии сообщества
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

            case 'group_change_settings': // Изменение настроек сообщества
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

            case 'group_officers_edit': // Изменение списка руководителей сообщества
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

            case 'user_block': // Пользователь заблокирован
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

            case 'user_unblock': // Пользователь разблокирован
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

            case 'like_add': // Добавление лайка
                const likeAdd = object;
                if (likeAdd && likeAdd.liker_id) {
                    userName = await getVkUserName(likeAdd.liker_id);
                    const likerDisplay = userName ? userName : `ID ${likeAdd.liker_id}`;
                    let itemLink = '';
                    if (likeAdd.object_type === 'post' && likeAdd.owner_id && likeAdd.object_id) {
                        itemLink = `<a href="https://vk.com/wall${likeAdd.owner_id}_${likeAdd.object_id}">посту</a>`;
                    } else if (likeAdd.object_type === 'photo' && likeAdd.owner_id && likeAdd.object_id) {
                        itemLink = `<a href="https://vk.com/photo${likeAdd.owner_id}_${likeAdd.object_id}">фотографии</a>`;
                    } else if (likeAdd.object_type === 'video' && likeAdd.owner_id && likeAdd.object_id) {
                        itemLink = `<a href="https://vk.com/video${likeAdd.owner_id}_${likeAdd.object_id}">видео</a>`;
                    } else if (likeAdd.object_type === 'comment' && likeAdd.owner_id && likeAdd.object_id) {
                        itemLink = `комментарию (ID ${likeAdd.object_id})`; // Сложно получить прямую ссылку на комментарий без контекста поста/фото/видео
                    }
                    telegramMessage = `👍 <b>Новый лайк в VK:</b>\n`;
                    telegramMessage += `<b>От:</b> <a href="https://vk.com/id${likeAdd.liker_id}">${likerDisplay}</a>\n`;
                    telegramMessage += `<b>К:</b> ${itemLink || `объекту типа <code>${escapeHtml(likeAdd.object_type)}</code> ID <code>${likeAdd.object_id}</code>`}`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено like_add без liker_id или объекта:`, object);
                    telegramMessage = `👍 <b>Новый лайк в VK:</b> (некорректный объект)`;
                }
                break;

            case 'like_remove': // Удаление лайка
                const likeRemove = object;
                if (likeRemove && likeRemove.liker_id) {
                    userName = await getVkUserName(likeRemove.liker_id);
                    const likerDisplay = userName ? userName : `ID ${likeRemove.liker_id}`;
                    let itemLink = '';
                    if (likeRemove.object_type === 'post' && likeRemove.owner_id && likeRemove.object_id) {
                        itemLink = `<a href="https://vk.com/wall${likeRemove.owner_id}_${likeRemove.object_id}">посту</a>`;
                    } else if (likeRemove.object_type === 'photo' && likeRemove.owner_id && likeRemove.object_id) {
                        itemLink = `<a href="https://vk.com/photo${likeRemove.owner_id}_${likeRemove.object_id}">фотографии</a>`;
                    } else if (likeRemove.object_type === 'video' && likeRemove.owner_id && likeRemove.object_id) {
                        itemLink = `<a href="https://vk.com/video${likeRemove.owner_id}_${likeRemove.object_id}">видео</a>`;
                    } else if (likeRemove.object_type === 'comment' && likeRemove.owner_id && likeRemove.object_id) {
                        itemLink = `комментарию (ID ${likeRemove.object_id})`;
                    }
                    telegramMessage = `👎 <b>Лайк удален в VK:</b>\n`;
                    telegramMessage += `<b>От:</b> <a href="https://vk.com/id${likeRemove.liker_id}">${likerDisplay}</a>\n`;
                    telegramMessage += `<b>К:</b> ${itemLink || `объекту типа <code>${escapeHtml(likeRemove.object_type)}</code> ID <code>${likeRemove.object_id}</code>`}`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено like_remove без liker_id или объекта:`, object);
                    telegramMessage = `👎 <b>Лайк удален в VK:</b> (некорректный объект)`;
                }
                break;

            default:
                console.log(`[${new Date().toISOString()}] Необработанный тип события VK: ${type}. Полный объект:`, JSON.stringify(object));
                telegramMessage = `❓ <b>Неизвестное или необработанное событие VK:</b>\nТип: <code>${escapeHtml(type)}</code>\n<pre>${escapeHtml(JSON.stringify(object, null, 2).substring(0, 1000) + (JSON.stringify(object, null, 2).length > 1000 ? '...' : ''))}</pre>`;
                break;
        }

        if (telegramMessage) {
            // Попытка отправить сообщение в Telegram с простой логикой повтора
            let sent = false;
            for (let i = 0; i < 3; i++) { // Повторить до 3 раз
                try {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: telegramMessage,
                        parse_mode: parseMode,
                        disable_web_page_preview: true
                    }, {
                        timeout: 5000 // Таймаут 5 секунд для отправки в Telegram
                    });
                    console.log(`[${new Date().toISOString()}] Сообщение успешно отправлено в Telegram для типа события: ${type}. Попытка: ${i + 1}`);
                    sent = true;
                    break;
                } catch (telegramSendError) {
                    console.error(`[${new Date().toISOString()}] Ошибка при отправке сообщения в Telegram (попытка ${i + 1}):`, telegramSendError.response ? telegramSendError.response.data : telegramSendError.message);
                    if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Экспоненциальная задержка
                }
            }
            if (!sent) {
                console.error(`[${new Date().toISOString()}] Не удалось отправить сообщение в Telegram после нескольких попыток для типа события: ${type}`);
                try {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: `❌ <b>Критическая ошибка:</b> Не удалось отправить уведомление о событии VK типа <code>${escapeHtml(type)}</code> в Telegram после нескольких попыток. Проверьте логи Railway.`,
                        parse_mode: 'HTML',
                        timeout: 5000
                    });
                } catch (finalTelegramError) {
                    console.error(`[${new Date().toISOString()}] Окончательная ошибка при отправке критического уведомления в Telegram:`, finalTelegramError.message);
                }
            }
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Критическая ошибка при обработке события VK или отправке сообщения в Telegram для типа ${type}:`, error.response ? error.response.data : error.message);
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `❌ <b>Критическая ошибка при обработке события VK:</b>\nТип: <code>${escapeHtml(type)}</code>\nСообщение: ${escapeHtml(error.message || 'Неизвестная ошибка')}\n\nПроверьте логи Railway для деталей.`,
                parse_mode: 'HTML',
                timeout: 5000
            });
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
});
