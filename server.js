// server.js - Основной файл сервера для обработки VK Callback API и пересылки в Telegram

// Импорт необходимых модулей
const express = require('express'); // Веб-фреймворк для Node.js
const bodyParser = require('body-parser'); // Для парсинга JSON-запросов
const axios = require('axios'); // Для выполнения HTTP-запросов (к Telegram API)
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
// VK_CONFIRMATION_STRING больше не нужен, так как адрес уже подтвержден
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные (VK_GROUP_ID, VK_SECRET_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) установлены.');
    process.exit(1); // Завершаем процесс, если переменные не установлены
}

// Инициализация кэша для дедупликации (TTL 60 секунд)
// Это предотвращает отправку дублирующихся сообщений в Telegram в течение 60 секунд
const deduplicationCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Обработчик POST-запросов от VK Callback API
app.post('/webhook', async (req, res) => { // Изменен маршрут на /webhook согласно вашему примеру
    const { type, object, group_id, secret } = req.body;

    console.log('Получен запрос от VK:', type, object, group_id);

    // Проверка секретного ключа для безопасности
    // Это критически важно для предотвращения несанкционированных запросов
    if (secret !== VK_SECRET_KEY) {
        console.warn('Получен запрос с неверным секретным ключом:', secret);
        return res.status(403).send('Forbidden: Invalid secret key');
    }

    // Обработка запроса на подтверждение сервера удалена, так как адрес уже подтвержден.
    // Если VK все еще отправляет confirmation, и вы хотите его игнорировать, можно добавить:
    if (type === 'confirmation') {
        console.log('Получен запрос подтверждения, но адрес уже подтвержден. Игнорируем.');
        return res.send('ok'); // Важно отправить 'ok', чтобы VK не повторял запрос
    }

    // Логика дедупликации
    // Создаем уникальный хеш для каждого события, чтобы избежать дублирования.
    // Хеш включает тип события и его уникальный идентификатор.
    const eventHash = crypto.createHash('md5').update(JSON.stringify({
        type,
        objectId: object.id || object.message?.id || object.post?.id || object.photo?.id || object.video?.id || object.user_id
    })).digest('hex');

    if (deduplicationCache.has(eventHash)) {
        console.log(`Дублирующееся событие получено и проигнорировано: ${type} - ${eventHash}`);
        return res.send('ok'); // VK ожидает 'ok' даже для дубликатов
    }
    deduplicationCache.set(eventHash, true); // Добавляем хеш в кэш

    // Обработка различных типов событий VK
    let telegramMessage = '';
    let parseMode = 'HTML'; // Используем HTML для гибкости форматирования

    try {
        switch (type) {
            case 'message_new':
                const message = object.message;
                if (message.text) {
                    // Для дедупликации сообщений, согласно требованию "только само сообщение"
                    // Мы пересылаем только текст сообщения, без дополнительных уведомлений о "получении нового сообщения".
                    telegramMessage = `💬 <b>Новое сообщение в VK:</b>\n`;
                    telegramMessage += `<b>Отправитель:</b> <a href="https://vk.com/id${message.from_id}">ID ${message.from_id}</a>\n`;
                    telegramMessage += `<b>Сообщение:</b> <i>${escapeHtml(message.text)}</i>`;
                }
                break;
            case 'wall_post_new':
                const post = object.post;
                if (post.text) {
                    telegramMessage = `📝 <b>Новый пост на стене VK:</b>\n`;
                    telegramMessage += `<a href="https://vk.com/wall${post.owner_id}_${post.id}">Ссылка на пост</a>\n`;
                    telegramMessage += `<i>${escapeHtml(post.text)}</i>`;
                }
                break;
            case 'photo_new':
                const photo = object.photo;
                // VK API может возвращать несколько размеров фото, выбираем наибольший или нужный
                const photoUrl = photo.sizes.find(s => s.type === 'x')?.url || photo.sizes[photo.sizes.length - 1]?.url;
                if (photoUrl) {
                    telegramMessage = `📸 <b>Новое фото в VK:</b> <a href="${photoUrl}">Ссылка на фото</a>`;
                }
                break;
            case 'video_new':
                const video = object.video;
                telegramMessage = `🎥 <b>Новое видео в VK:</b> <a href="https://vk.com/video${video.owner_id}_${video.id}">Ссылка на видео</a>`;
                break;
            case 'group_join':
                const joinEvent = object;
                telegramMessage = `➕ <b>Новый участник в VK:</b> <a href="https://vk.com/id${joinEvent.user_id}">ID ${joinEvent.user_id}</a> вступил в группу!`;
                break;
            case 'group_leave':
                const leaveEvent = object;
                telegramMessage = `➖ <b>Участник покинул VK:</b> <a href="https://vk.com/id${leaveEvent.user_id}">ID ${leaveEvent.user_id}</a> покинул группу.`;
                break;
            // Дополнительные типы событий можно добавить здесь
            default:
                console.log(`Необработанный тип события VK: ${type}`);
                break;
        }

        if (telegramMessage) {
            // Отправка сообщения в Telegram
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: telegramMessage,
                parse_mode: parseMode,
                disable_web_page_preview: true // Отключаем предпросмотр ссылок для более чистого вывода
            });
            console.log(`Сообщение успешно отправлено в Telegram для типа события: ${type}`);
        }

    } catch (error) {
        console.error(`Ошибка при обработке события VK или отправке сообщения в Telegram для типа ${type}:`, error.response ? error.response.data : error.message);
        // В случае ошибки, все равно отправляем 'ok' VK, чтобы не вызывать повторные попытки
        // и не помечать вебхук как нерабочий.
    }

    res.send('ok'); // VK ожидает 'ok' для успешной обработки событий
});

// Вспомогательная функция для экранирования HTML-сущностей
function escapeHtml(text) {
    return text
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}

// Запуск сервера
const PORT = process.env.PORT || 3000; // Railway предоставит свой порт
app.listen(PORT, () => {
    console.log(`Сервер VK-Telegram бота запущен на порту ${PORT}`);
});
