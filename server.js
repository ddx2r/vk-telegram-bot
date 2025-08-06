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
            }
        });

        if (response.data && response.data.response && response.data.response.length > 0) {
            const user = response.data.response[0];
            return `${escapeHtml(user.first_name)} ${escapeHtml(user.last_name)}`;
        }
        return null; // Возвращаем null, если имя не найдено
    } catch (error) {
        console.error(`Ошибка при получении имени пользователя VK (ID: ${userId}):`, error.response ? error.response.data : error.message);
        // Отправляем сообщение об ошибке в Telegram
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `⚠️ Ошибка при получении имени пользователя VK (ID: ${userId}): ${escapeHtml(error.message)}`,
                parse_mode: 'HTML'
            });
        } catch (telegramError) {
            console.error('Ошибка при отправке уведомления об ошибке в Telegram:', telegramError.message);
        }
        return null; // Возвращаем null при ошибке
    }
}

// Обработчик POST-запросов от VK Callback API
app.post('/webhook', async (req, res) => { // Маршрут /webhook
    const { type, object, group_id, secret } = req.body;

    console.log('Получен запрос от VK:', type, object, group_id);

    // Проверка секретного ключа для безопасности
    if (secret !== VK_SECRET_KEY) {
        console.warn('Получен запрос с неверным секретным ключом:', secret);
        return res.status(403).send('Forbidden: Invalid secret key');
    }

    // Игнорируем запрос на подтверждение, так как адрес уже подтвержден
    if (type === 'confirmation') {
        console.log('Получен запрос подтверждения, но адрес уже подтвержден. Игнорируем.');
        return res.send('ok');
    }

    // Логика дедупликации
    const eventHash = crypto.createHash('md5').update(JSON.stringify({
        type,
        objectId: object.id || object.message?.id || object.post?.id || object.photo?.id || object.video?.id || object.user_id
    })).digest('hex');

    if (deduplicationCache.has(eventHash)) {
        console.log(`Дублирующееся событие получено и проигнорировано: ${type} - ${eventHash}`);
        return res.send('ok');
    }
    deduplicationCache.set(eventHash, true);

    // Обработка различных типов событий VK
    let telegramMessage = '';
    let parseMode = 'HTML';

    try {
        let userName = '';
        switch (type) {
            case 'message_new':
                const message = object.message;
                if (message.text) {
                    userName = await getVkUserName(message.from_id);
                    const senderDisplay = userName ? userName : `ID ${message.from_id}`;

                    telegramMessage = `💬 <b>Новое сообщение в VK:</b>\n`;
                    telegramMessage += `<b>Отправитель:</b> <a href="https://vk.com/id${message.from_id}">${senderDisplay}</a>\n`;
                    telegramMessage += `<b>Сообщение:</b> <i>${escapeHtml(message.text)}</i>`;
                }
                break;
            case 'wall_post_new':
                const post = object.post;
                if (post.text) {
                    userName = await getVkUserName(post.from_id);
                    const authorDisplay = userName ? userName : `ID ${post.from_id}`;

                    telegramMessage = `📝 <b>Новый пост на стене VK:</b>\n`;
                    telegramMessage += `<b>Автор:</b> <a href="https://vk.com/id${post.from_id}">${authorDisplay}</a>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>\n`;
                    telegramMessage += `<i>${escapeHtml(post.text)}</i>`;
                }
                break;
            case 'photo_new':
                const photo = object.photo;
                const photoUrl = photo.sizes.find(s => s.type === 'x')?.url || photo.sizes[photo.sizes.length - 1]?.url;
                if (photoUrl) {
                    userName = await getVkUserName(photo.owner_id);
                    const ownerDisplay = userName ? userName : `ID ${photo.owner_id}`;

                    telegramMessage = `📸 <b>Новое фото в VK:</b>\n`;
                    telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${photo.owner_id}">${ownerDisplay}</a>\n`;
                    telegramMessage += `<a href="${photoUrl}">Ссылка на фото</a>`;
                }
                break;
            case 'video_new':
                const video = object.video;
                userName = await getVkUserName(video.owner_id);
                const videoOwnerDisplay = userName ? userName : `ID ${video.owner_id}`;

                telegramMessage = `🎥 <b>Новое видео в VK:</b>\n`;
                telegramMessage += `<b>Владелец:</b> <a href="https://vk.com/id${video.owner_id}">${videoOwnerDisplay}</a>\n`;
                telegramMessage += `<b>Название:</b> ${escapeHtml(video.title || 'Без названия')}\n`;
                telegramMessage += `<a href="https://vk.com/video${video.owner_id}_${video.id}">Ссылка на видео</a>`;
                break;
            case 'group_join':
                const joinEvent = object;
                userName = await getVkUserName(joinEvent.user_id);
                const joinUserDisplay = userName ? userName : `ID ${joinEvent.user_id}`;

                telegramMessage = `➕ <b>Новый участник в VK:</b> <a href="https://vk.com/id${joinEvent.user_id}">${joinUserDisplay}</a> вступил в группу!`;
                break;
            case 'group_leave':
                const leaveEvent = object;
                userName = await getVkUserName(leaveEvent.user_id);
                const leaveUserDisplay = userName ? userName : `ID ${leaveEvent.user_id}`;

                telegramMessage = `➖ <b>Участник покинул VK:</b> <a href="https://vk.com/id${leaveEvent.user_id}">${leaveUserDisplay}</a> покинул группу.`;
                break;
            default:
                console.log(`Необработанный тип события VK: ${type}`);
                break;
        }

        if (telegramMessage) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: telegramMessage,
                parse_mode: parseMode,
                disable_web_page_preview: true
            });
            console.log(`Сообщение успешно отправлено в Telegram для типа события: ${type}`);
        }

    } catch (error) {
        console.error(`Ошибка при обработке события VK или отправке сообщения в Telegram для типа ${type}:`, error.response ? error.response.data : error.message);
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `❌ <b>Критическая ошибка при обработке события VK:</b>\nТип: ${escapeHtml(type)}\nСообщение: ${escapeHtml(error.message)}`,
                parse_mode: 'HTML'
            });
        } catch (telegramError) {
            console.error('Ошибка при отправке критического уведомления об ошибке в Telegram:', telegramError.message);
        }
    }

    res.send('ok');
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер VK-Telegram бота запущен на порту ${PORT}`);
});
