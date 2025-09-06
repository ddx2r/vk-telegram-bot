module.exports = async ({ object }, { getVkUserName, processAttachments, escapeHtml, TELEGRAM_CHAT_ID }) => {
  const message = object.message;
  let telegramMessage = '';
  let attachmentsInfo = '';
  if (message) {
    const userName = await getVkUserName(message.from_id);
    const senderDisplay = userName ? userName : `ID ${message.from_id}`;
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
  return { message: telegramMessage + attachmentsInfo, parseMode: 'HTML' };
};
