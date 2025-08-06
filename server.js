// server.js - Основной файл сервера для обработки VK Callback API и пересылки в Telegram

// Импорт необходимых модулей
const express = require('express'); // Веб-фреймворк для Node.js
const bodyParser = require('body-parser'); // Для парсинга JSON-запросов
const axios = require('axios'); // Для выполнения HTTP-запросов (к Telegram API)

// Инициализация Express приложения
const app = express();
// Использование body-parser для обработки JSON-тела запросов
app.use(bodyParser.json());

// Получение переменных окружения
// Эти переменные будут установлены на Railway
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_SECRET_KEY = process.env.VK_SECRET_KEY;
const VK_CONFIRMATION_STRING = process.env.VK_CONFIRMATION_STRING;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Проверка наличия всех необходимых переменных окружения
if (!VK_GROUP_ID || !VK_SECRET_KEY || !VK_CONFIRMATION_STRING || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Ошибка: Отсутствуют необходимые переменные окружения. Пожалуйста, убедитесь, что все переменные (VK_GROUP_ID, VK_SECRET_KEY, VK_CONFIRMATION_STRING, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) установлены.');
    process.exit(1); // Завершаем процесс, если переменные не установлены
}

// Массив для хранения последних отправленных сообщений, чтобы избежать дублирования
const sentMessages = [];
const MESSAGE_LIFETIME_MS = 60 * 1000; // 1 минута для хранения сообщений

// Функция для очистки старых сообщений из кэша
setInterval(() => {
    const now = Date.now();
    for (let i = 0; i < sentMessages.length; i++) {
        if (now - sentMessages[i].timestamp > MESSAGE_LIFETIME_MS) {
            sentMessages.splice(i, 1);
            i--; // Уменьшаем индекс, так как элемент был удален
        }
    }
}, MESSAGE_LIFETIME_MS);

// Обработчик POST-запросов от VK Callback API
app.post('/vk-webhook', async (req, res) => {
    const { type, object, group_id, secret } = req.body;

    console.log('Получен запрос от VK:', type, object, group_id);

    // Проверка секретного ключа для безопасности
    if (secret !== VK_SECRET_KEY) {
        console.warn('Получен запрос с неверным секретным ключом:', secret);
        return res.status(403).send('Forbidden: Invalid secret key');
    }

    // Обработка запроса на подтверждение сервера
    if (type === 'confirmation' && String(group_id) === String(VK_GROUP_ID)) {
        console.log('Отправка строки подтверждения:', VK_CONFIRMATION_STRING);
        return res.send(VK_CONFIRMATION_STRING);
    }

    // Обработка различных типов событий VK
    let messageText = '';
    let parseMode = 'MarkdownV2'; // По умолчанию используем MarkdownV2 для форматирования

    switch (type) {
        case 'message_new':
            // Новое сообщение
            const message = object.message;
            if (message.text) {
                const messageHash = `${message.peer_id}-${message.text}`;
                const isDuplicate = sentMessages.some(m => m.hash === messageHash && Date.now() - m.timestamp < MESSAGE_LIFETIME_MS);

                if (isDuplicate) {
                    console.log('Дублирующееся сообщение, пропускаем:', message.text);
                    return res.send('ok'); // Важно отправить 'ok', чтобы VK не повторял запрос
                }

                sentMessages.push({ hash: messageHash, timestamp: Date.now() });

                messageText = `*Новое сообщение от VK:*\n\n\`\`\`\n${escapeMarkdownV2(message.text)}\n\`\`\``;
            } else {
                messageText = `*Новое сообщение от VK:* (без текста)`;
            }
            break;

        case 'wall_post_new':
            // Новая запись на стене
            const post = object;
            messageText = `*Новая запись на стене VK:*\n\n${escapeMarkdownV2(post.text || 'Без текста')}\n\n[Посмотреть пост](https://vk.com/wall${post.owner_id}_${post.id})`;
            break;

        case 'board_post_new':
            // Новое сообщение в обсуждениях
            const boardPost = object;
            messageText = `*Новое сообщение в обсуждениях VK:*\n\nТема: ${escapeMarkdownV2(boardPost.topic_title)}\nАвтор: ${escapeMarkdownV2(boardPost.from_id)}\nТекст: \`\`\`\n${escapeMarkdownV2(boardPost.text)}\n\`\`\`\n\n[Посмотреть обсуждение](https://vk.com/topic-${boardPost.group_id}_${boardPost.topic_id}?post=${boardPost.id})`;
            break;

        case 'photo_new':
            // Новое фото
            const photo = object;
            messageText = `*Новое фото в VK:*\n\n[Посмотреть фото](${photo.sizes.find(s => s.type === 'x')?.url || photo.sizes[photo.sizes.length - 1].url})`;
            break;

        case 'video_new':
            // Новое видео
            const video = object;
            messageText = `*Новое видео в VK:*\n\nНазвание: ${escapeMarkdownV2(video.title)}\n\n[Посмотреть видео](https://vk.com/video${video.owner_id}_${video.id})`;
            break;

        case 'audio_new':
            // Новая аудиозапись
            const audio = object;
            messageText = `*Новая аудиозапись в VK:*\n\nИсполнитель: ${escapeMarkdownV2(audio.artist)}\nНазвание: ${escapeMarkdownV2(audio.title)}`;
            break;

        case 'market_order_new':
            // Новый заказ в товарах
            const order = object;
            messageText = `*Новый заказ в VK Маркете:*\n\nСумма: ${order.total_price.amount / 100} ${order.total_price.currency.name}\n\n[Посмотреть заказ](https://vk.com/market?w=orders/view/${order.id})`;
            break;

        case 'group_join':
            // Пользователь вступил в группу
            const joinUser = object.user_id;
            messageText = `*В группу вступил новый пользователь:* [ID ${joinUser}](https://vk.com/id${joinUser})`;
            break;

        case 'group_leave':
            // Пользователь покинул группу
            const leaveUser = object.user_id;
            messageText = `*Пользователь покинул группу:* [ID ${leaveUser}](https://vk.com/id${leaveUser})`;
            break;

        default:
            // Для всех остальных типов событий
            console.log('Неизвестный тип события VK:', type);
            // Можно отправить общую информацию о событии, если нужно
            messageText = `*Неизвестное событие VK:*\n\nТип: \`${type}\`\n\n\`\`\`json\n${escapeMarkdownV2(JSON.stringify(object, null, 2))}\n\`\`\``;
            break;
    }

    // Отправка сообщения в Telegram, если оно сформировано
    if (messageText) {
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: messageText,
                parse_mode: parseMode,
                disable_web_page_preview: true // Отключаем предпросмотр ссылок для более чистого вывода
            });
            console.log('Сообщение успешно отправлено в Telegram.');
        } catch (error) {
            console.error('Ошибка при отправке сообщения в Telegram:', error.response ? error.response.data : error.message);
        }
    }

    // Всегда отправляем 'ok' в VK, чтобы предотвратить повторные запросы
    res.send('ok');
});

// Функция для экранирования символов MarkdownV2
function escapeMarkdownV2(text) {
    // Символы, которые нужно экранировать в MarkdownV2
    const charsToEscape = /([_*\\[\]()~`>#+\-=|{}.!])/g;
    return text.replace(charsToEscape, '\\$1');
}

// Запуск сервера
const PORT = process.env.PORT || 3000; // Railway предоставит свой порт
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
