export default {
  async fetch() {
    return new Response("VK Telegram bot worker placeholder.", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }
};
