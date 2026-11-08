import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("telegram relay worker", () => {
	it("answers on / without calling Telegram", async () => {
		const request = new Request("http://example.com/");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("telegram relay");
	});

	it("returns 404 for paths that are not Bot API", async () => {
		const response = await SELF.fetch("http://example.com/admin");
		expect(response.status).toBe(404);
	});

	it("rejects a foreign bot token when BOT_TOKEN is set", async () => {
		const request = new Request("http://example.com/bot123:abc/getMe");
		const response = await worker.fetch(request, { ...env, BOT_TOKEN: "999:other" });
		expect(response.status).toBe(404);
	});
});
