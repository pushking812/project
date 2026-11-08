/**
 * Telegram Bot API relay для бота ask MCP.
 *
 * Бот обращается к <worker>/bot<токен>/<метод>, worker пересылает запрос
 * в https://api.telegram.org без изменений и отдаёт ответ как есть.
 *
 * Необязательно: секрет BOT_TOKEN (Settings -> Variables, Encrypt) — тогда
 * пропускаются только пути своего бота, остальные получают 404.
 */
export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// Проверка живости: откройте адрес воркера в браузере.
		if (url.pathname === "/") {
			return new Response("telegram relay", { status: 200 });
		}
		// Если задан секрет BOT_TOKEN, чужие пути не пересылаем.
		if (env.BOT_TOKEN && !url.pathname.startsWith(`/bot${env.BOT_TOKEN}/`)) {
			return new Response("not found", { status: 404 });
		}
		if (!url.pathname.startsWith("/bot")) {
			return new Response("not found", { status: 404 });
		}

		const headers = new Headers(request.headers);
		headers.delete("host"); // иначе Bot API увидит Host воркера, а не свой

		return fetch("https://api.telegram.org" + url.pathname + url.search, {
			method: request.method,
			headers,
			// Тело пересылается потоком: работают и JSON, и multipart (фото, документы).
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
		});
	},
};
