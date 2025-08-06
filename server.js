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

    // Логика дедупликации
    // Создаем уникальный хеш для каждого события, чтобы избежать дублирования.
    // Хеш включает тип события и его уникальный идентификатор.
    const objectId = object?.id || object?.message?.id || object?.post?.id || object?.photo?.id || object?.video?.id || object?.user_id;
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
                    const authorDisplay = userName ? userName : `ID ${post.from_id}`;

                    telegramMessage = `📝 <b>Новый пост на стене VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${post.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>\n`;
                    telegramMessage += `<i>${escapeHtml(post.text)}</i>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено wall_post_new без текста или объекта поста:`, object);
                    telegramMessage = `📝 <b>Новый пост на стене VK:</b> (без текста или с некорректным объектом поста)`;
                }
                break;
            case 'photo_new':
                const photo = object.photo;
                if (photo && photo.owner_id) {
                    const photoUrl = photo.sizes?.find(s => s.type === 'x')?.url || photo.sizes?.[photo.sizes.length - 1]?.url;
                    userName = await getVkUserName(photo.owner_id);
                    const ownerDisplay = userName ? userName : `ID ${photo.owner_id}`;

                    telegramMessage = `📸 <b>Новое фото в VK:</b>\n`;
                    telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${photo.owner_id}">${ownerDisplay}</a>\n`;
                    telegramMessage += photoUrl ? `<a href="${photoUrl}">Ссылка на фото</a>` : `(Ссылка на фото недоступна)`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено photo_new без owner_id или объекта фото:`, object);
                    telegramMessage = `📸 <b>Новое фото в VK:</b> (некорректный объект фото)`;
                }
                break;
            case 'video_new':
                const video = object.video;
                if (video && video.owner_id) {
                    userName = await getVkUserName(video.owner_id);
                    const videoOwnerDisplay = userName ? userName : `ID ${video.owner_id}`;

                    telegramMessage = `🎥 <b>Новое видео в VK:</b>\n`;
                    telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${video.owner_id}">${videoOwnerDisplay}</a>\n`;
                    telegramMessage += `<b>Название:</b> ${escapeHtml(video.title || 'Без названия')}\n`;
                    telegramMessage += `<a href="https://vk.com/video${video.owner_id}_${video.id}">Ссылка на видео</a>`;
                } else {
                    console.warn(`[${new Date().toISOString()}] Получено video_new без owner_id или объекта видео:`, object);
                    telegramMessage = `🎥 <b>Новое видео в VK:</b> (некорректный объект видео)`;
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
