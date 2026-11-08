export default {
  async fetch(request) {
    const url = new URL(request.url);

     Простой ответ, если открыть адрес в браузере
    if (!url.pathname.startsWith(bot)) {
      return new Response(telegram relay, { status 200 });
    }

    const headers = new Headers(request.headers);
    headers.delete(host);  иначе Bot API увидит чужой Host

    return fetch(httpsapi.telegram.org + url.pathname + url.search, {
      method request.method,
      headers,
      body request.method === GET  request.method === HEAD  undefined  request.body,
    });
  },
};