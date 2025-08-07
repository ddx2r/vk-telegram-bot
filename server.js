# -*- coding: utf-8 -*-
import json
import logging
import os
import requests
from typing import Dict, Any

from telegram import Bot

# --- Настройки ---
# VK
VK_GROUP_ID = os.getenv("VK_GROUP_ID", "198160981")  # ID вашей группы VK
VK_TOKEN = os.getenv("VK_TOKEN")
VK_SECRET_KEY = os.getenv("VK_SECRET_KEY")

# Telegram
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
# ---

# Настройка логирования
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(levelname)s - %(message)s')

# Инициализация Telegram бота
if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
    bot = Bot(token=TELEGRAM_BOT_TOKEN)
else:
    bot = None
    logging.warning(
        "Переменные окружения TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы. "
        "Сообщения не будут отправляться в Telegram.")

def send_telegram_message(message: str):
    """
    Отправляет сообщение в указанный чат Telegram.
    :param message: Текст сообщения.
    """
    if bot:
        try:
            bot.send_message(chat_id=TELEGRAM_CHAT_ID, text=message, parse_mode="HTML")
            logging.info("Сообщение успешно отправлено в Telegram.")
        except Exception as e:
            logging.error(f"Ошибка при отправке сообщения в Telegram: {e}")

def get_vk_user_info(user_id: int) -> Dict[str, Any]:
    """
    Получает информацию о пользователе VK.
    :param user_id: ID пользователя VK.
    :return: Словарь с именем и фамилией пользователя.
    """
    try:
        response = requests.get(
            "https://api.vk.com/method/users.get",
            params={
                "user_ids": user_id,
                "fields": "photo_50",
                "access_token": VK_TOKEN,
                "v": "5.131"
            }
        )
        data = response.json()
        if "response" in data and len(data["response"]) > 0:
            user = data["response"][0]
            return {
                "first_name": user.get("first_name", "Неизвестно"),
                "last_name": user.get("last_name", "Неизвестно"),
                "url": f"https://vk.com/id{user_id}"
            }
    except Exception as e:
        logging.error(f"Ошибка при получении информации о пользователе VK: {e}")
    return {"first_name": "Неизвестно", "last_name": "Неизвестно", "url": "#"}

def handle_lead_forms_new_event(event: Dict[str, Any]):
    """
    Обрабатывает событие о новой заявке через lead form.
    :param event: Объект события 'lead_forms_new'.
    """
    lead_data = event.get("object", {})
    user_id = lead_data.get("user_id")
    form_name = lead_data.get("form_name")
    answers = lead_data.get("answers", [])

    user_info = get_vk_user_info(user_id)
    user_link = user_info["url"]
    user_full_name = f"{user_info['first_name']} {user_info['last_name']}"

    message_parts = [
        f"<b>Новая заявка по форме:</b> {form_name}",
        f"<b>Пользователь:</b> <a href='{user_link}'>{user_full_name}</a>"
    ]

    for answer in answers:
        question = answer.get("question")
        answer_text = answer.get("answer")
        if question and answer_text:
            message_parts.append(f"<b>{question}:</b> {answer_text}")

    full_message = "\n".join(message_parts)
    send_telegram_message(full_message)
    logging.info(f"Обработана новая заявка по форме: {form_name}")

def handle_event(event: Dict[str, Any]) -> str:
    """
    Главный обработчик событий VK.
    :param event: Объект события, полученный от VK.
    :return: Строка-ответ для VK Callback API.
    """
    event_type = event.get("type")
    
    # Обрабатываем событие с новой заявкой через lead form
    if event_type == "lead_forms_new":
        handle_lead_forms_new_event(event)
        return "ok"

    # Игнорируем событие message_reply, так как оно дублирует информацию из lead_forms_new
    if event_type == "message_reply":
        logging.info("Игнорируем событие 'message_reply', так как оно дублирует заявку.")
        return "ok"

    # В противном случае логируем как неизвестное
    logging.warning(
        f"❓ Неизвестное или необработанное событие VK:\nТип: {event_type}\n"
        f"{json.dumps(event.get('object'), indent=2, ensure_ascii=False)}"
    )
    return "ok"

def main(request):
    """
    Основная точка входа для Cloud Functions.
    :param request: Объект HTTP-запроса.
    """
    try:
        data = request.get_json()
        logging.info(f"Получен запрос: {data}")

        # Проверка Callback API
        if "type" in data and data["type"] == "confirmation":
            if data.get("group_id") == int(VK_GROUP_ID):
                logging.info("Запрос подтверждения VK Callback API")
                return VK_SECRET_KEY
            else:
                logging.error("Неверный group_id в запросе подтверждения")
                return "error", 400

        # Обработка событий
        if "type" in data and data.get("secret") == VK_SECRET_KEY:
            return handle_event(data)

        logging.warning("Неверный секретный ключ или неизвестный тип запроса.")
        return "error", 400
    except Exception as e:
        logging.error(f"Произошла ошибка при обработке запроса: {e}", exc_info=True)
        return "error", 500

