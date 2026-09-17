import { DurableObject } from "cloudflare:workers";
import { EXPIRY_COMMANDS, execute } from "./commands";
import { RespError, RespParseError, RespParser, SimpleString, encode, type Command, type Reply } from "./resp";
import { Store } from "./store";

/**
 * One LilRedis instance == one Redis "database". Every key in a namespace
 * lives in this object's SQLite file, so multi-key commands are atomic.
 */
export class LilRedis extends DurableObject<Env> {
	private readonly store: Store;
	/** Per-connection streaming parsers. Rebuilt lazily after hibernation. */
	private readonly parsers = new WeakMap<WebSocket, RespParser>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new Store(ctx.storage.sql);
	}

	// ------------------------------------------------------------------ HTTP

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
			this.ctx.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		}

		// Plain HTTP fallback: POST ["SET","foo","bar"]  ->  {"result":"OK"}
		if (request.method === "POST") {
			let cmd: unknown;
			try {
				cmd = await request.json();
			} catch {
				return Response.json({ error: "ERR body must be a JSON array of strings" }, { status: 400 });
			}
			if (!Array.isArray(cmd) || !cmd.every((x) => typeof x === "string")) {
				return Response.json({ error: "ERR body must be a JSON array of strings" }, { status: 400 });
			}
			const reply = await this.run(cmd);
			if (reply instanceof RespError) return Response.json({ error: reply.message }, { status: 400 });
			return Response.json({ result: toJson(reply) });
		}

		return new Response("lil-redis: connect via WebSocket, or POST a JSON command array", { status: 400 });
	}

	// ------------------------------------------------------------------- RPC

	/** Call from another Worker via the stub: `await stub.exec(["GET", "foo"])`. Throws on Redis errors. */
	async exec(cmd: Command): Promise<JsonReply> {
		const reply = await this.run(cmd);
		if (reply instanceof RespError) throw new Error(reply.message);
		return toJson(reply);
	}

	// ------------------------------------------------------------- WebSocket

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		let parser = this.parsers.get(ws);
		if (!parser) {
			parser = new RespParser();
			this.parsers.set(ws, parser);
		}

		const binary = typeof message !== "string";
		let commands: Command[];
		try {
			commands = parser.feed(binary ? new Uint8Array(message) : message);
		} catch (e) {
			if (e instanceof RespParseError) {
				// Redis closes the connection on protocol errors; we do too.
				ws.send(encode(new RespError(e.message)));
				ws.close(1002, e.message);
				return;
			}
			throw e;
		}

		for (const cmd of commands) {
			if (cmd.length === 0) continue;
			const reply = await this.run(cmd);
			const bytes = encode(reply);
			ws.send(binary ? bytes : new TextDecoder().decode(bytes));
			if (cmd[0]!.toUpperCase() === "QUIT") ws.close(1000, "bye");
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		this.parsers.delete(ws);
		// Echo the close handshake. 1005 ("no status") is not a legal code to *send*.
		try {
			ws.close(code === 1005 ? 1000 : code, reason);
		} catch {
			/* already closed */
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.parsers.delete(ws);
	}

	// ----------------------------------------------------------------- Alarm

	/** Fires when the earliest TTL is due: delete expired keys, reschedule for the next one. */
	async alarm(): Promise<void> {
		this.store.sweepExpired();
		await this.scheduleExpiry();
	}

	// -------------------------------------------------------------- Internal

	/** Executes a command atomically and keeps the expiry alarm in sync. */
	private async run(cmd: Command): Promise<Reply> {
		const reply = this.ctx.storage.transactionSync(() => execute(this.store, cmd));
		if (EXPIRY_COMMANDS.has(cmd[0]!.toUpperCase())) await this.scheduleExpiry();
		return reply;
	}

	private async scheduleExpiry(): Promise<void> {
		const next = this.store.nextExpiry();
		const current = await this.ctx.storage.getAlarm();
		if (next === null) {
			if (current !== null) await this.ctx.storage.deleteAlarm();
		} else if (current === null || next < current) {
			await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
		}
	}
}

export type JsonScalar = string | number | null;
/** Non-recursive on purpose: keeps the RPC stub's type mapping shallow. No v1 command nests arrays. */
export type JsonReply = JsonScalar | JsonScalar[];

/** Flatten RESP reply classes into structured-clone-safe values. */
function toJson(reply: Reply): JsonReply {
	if (reply instanceof SimpleString) return reply.value;
	if (reply instanceof RespError) return reply.message;
	if (Array.isArray(reply)) return reply.map((r) => toJson(r) as JsonScalar);
	return reply;
}
