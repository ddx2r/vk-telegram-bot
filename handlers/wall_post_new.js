module.exports = async ({ object }, { getVkUserName, processAttachments, escapeHtml, TELEGRAM_CHAT_ID }) => {
  const post = object.post || object;
  let telegramMessage = '';
  let attachmentsInfo = '';
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
  return { message: telegramMessage + attachmentsInfo, parseMode: 'HTML' };
};
