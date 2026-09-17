import { LilRedis } from "./lil-redis";

export { LilRedis };

/**
 * Routing:
 *   GET  /db/:namespace   (Upgrade: websocket)  -> RESP over WebSocket
 *   POST /db/:namespace   ["SET","k","v"]       -> {"result":"OK"}
 *
 * Every namespace maps to exactly one Durable Object.
 */
export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const match = /^\/db\/([A-Za-z0-9_.:-]{1,128})$/.exec(url.pathname);

		if (!match) {
			return new Response(
				[
					"lil-redis: a small Redis on Durable Objects",
					"",
					"  websocket:  wss://<host>/db/<namespace>      (send RESP or plain 'SET k v')",
					"  http:       POST /db/<namespace>  body: [\"GET\",\"k\"]",
					"",
				].join("\n"),
				{ status: match ? 200 : 404, headers: { "content-type": "text/plain" } },
			);
		}

		const namespace = match[1]!;
		const stub = env.LIL_REDIS.getByName(namespace);
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;
