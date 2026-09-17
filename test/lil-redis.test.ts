import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LilRedis } from "../src/lil-redis";

let n = 0;
/** Fresh namespace per test so state never leaks between tests. */
const ns = () => `t${Date.now()}-${n++}`;

async function cmd(db: string, ...args: string[]) {
	const res = await SELF.fetch(`https://lil/db/${db}`, {
		method: "POST",
		body: JSON.stringify(args),
	});
	const body = (await res.json()) as { result?: unknown; error?: string };
	if (body.error !== undefined) return new Error(body.error);
	return body.result;
}

describe("http", () => {
	it("404s outside /db/*", async () => {
		const res = await SELF.fetch("https://lil/nope");
		expect(res.status).toBe(404);
	});

	it("rejects bad bodies", async () => {
		const res = await SELF.fetch("https://lil/db/x", { method: "POST", body: "{}" });
		expect(res.status).toBe(400);
	});
});

describe("strings + keyspace", () => {
	it("SET/GET/DEL/EXISTS", async () => {
		const db = ns();
		expect(await cmd(db, "SET", "a", "1")).toBe("OK");
		expect(await cmd(db, "GET", "a")).toBe("1");
		expect(await cmd(db, "EXISTS", "a", "b")).toBe(1);
		expect(await cmd(db, "DEL", "a", "b")).toBe(1);
		expect(await cmd(db, "GET", "a")).toBeNull();
	});

	it("SET NX/XX/GET options", async () => {
		const db = ns();
		expect(await cmd(db, "SET", "k", "v1", "NX")).toBe("OK");
		expect(await cmd(db, "SET", "k", "v2", "NX")).toBeNull();
		expect(await cmd(db, "SET", "missing", "v", "XX")).toBeNull();
		expect(await cmd(db, "SET", "k", "v3", "GET")).toBe("v1");
		expect(await cmd(db, "GET", "k")).toBe("v3");
		expect(await cmd(db, "SET", "k", "v", "NX", "XX")).toEqual(new Error("ERR syntax error"));
	});

	it("INCR family", async () => {
		const db = ns();
		expect(await cmd(db, "INCR", "n")).toBe(1);
		expect(await cmd(db, "INCRBY", "n", "10")).toBe(11);
		expect(await cmd(db, "DECR", "n")).toBe(10);
		expect(await cmd(db, "INCRBYFLOAT", "n", "0.5")).toBe("10.5");
		await cmd(db, "SET", "s", "abc");
		expect(await cmd(db, "INCR", "s")).toEqual(new Error("ERR value is not an integer or out of range"));
	});

	it("MSET/MGET/APPEND/STRLEN", async () => {
		const db = ns();
		expect(await cmd(db, "MSET", "a", "1", "b", "2")).toBe("OK");
		expect(await cmd(db, "MGET", "a", "b", "c")).toEqual(["1", "2", null]);
		expect(await cmd(db, "APPEND", "a", "23")).toBe(3);
		expect(await cmd(db, "STRLEN", "a")).toBe(3);
	});

	it("KEYS / TYPE / RENAME / DBSIZE / FLUSHDB", async () => {
		const db = ns();
		await cmd(db, "MSET", "user:1", "a", "user:2", "b", "other", "c");
		expect(await cmd(db, "KEYS", "user:*")).toEqual(["user:1", "user:2"]);
		expect(await cmd(db, "TYPE", "user:1")).toBe("string");
		expect(await cmd(db, "TYPE", "nope")).toBe("none");
		expect(await cmd(db, "RENAME", "other", "user:3")).toBe("OK");
		expect(await cmd(db, "GET", "user:3")).toBe("c");
		expect(await cmd(db, "DBSIZE")).toBe(3);
		expect(await cmd(db, "FLUSHDB")).toBe("OK");
		expect(await cmd(db, "DBSIZE")).toBe(0);
	});

	it("WRONGTYPE on mismatched key types", async () => {
		const db = ns();
		await cmd(db, "LPUSH", "l", "x");
		expect(await cmd(db, "GET", "l")).toEqual(
			new Error("WRONGTYPE Operation against a key holding the wrong kind of value"),
		);
		expect(await cmd(db, "MGET", "l")).toEqual([null]); // MGET is lenient, like Redis
		// SET overwrites a container
		expect(await cmd(db, "SET", "l", "str")).toBe("OK");
		expect(await cmd(db, "TYPE", "l")).toBe("string");
		expect(await cmd(db, "LLEN", "l")).toEqual(
			new Error("WRONGTYPE Operation against a key holding the wrong kind of value"),
		);
	});

	it("unknown commands and arity errors", async () => {
		const db = ns();
		expect(await cmd(db, "FOO")).toEqual(new Error("ERR unknown command 'FOO', with args beginning with: "));
		expect(await cmd(db, "GET")).toEqual(new Error("ERR wrong number of arguments for 'get' command"));
	});
});

describe("expiry", () => {
	it("TTL/PTTL/PERSIST", async () => {
		const db = ns();
		expect(await cmd(db, "TTL", "nope")).toBe(-2);
		await cmd(db, "SET", "k", "v");
		expect(await cmd(db, "TTL", "k")).toBe(-1);
		expect(await cmd(db, "EXPIRE", "k", "100")).toBe(1);
		const ttl = (await cmd(db, "TTL", "k")) as number;
		expect(ttl).toBeGreaterThan(95);
		expect(ttl).toBeLessThanOrEqual(100);
		expect(await cmd(db, "PERSIST", "k")).toBe(1);
		expect(await cmd(db, "TTL", "k")).toBe(-1);
	});

	it("lazily expires keys on access", async () => {
		const db = ns();
		await cmd(db, "SET", "k", "v", "PX", "30");
		expect(await cmd(db, "GET", "k")).toBe("v");
		await new Promise((r) => setTimeout(r, 60));
		expect(await cmd(db, "GET", "k")).toBeNull();
		expect(await cmd(db, "TTL", "k")).toBe(-2);
	});

	it("SET without KEEPTTL clears the TTL; INCR keeps it", async () => {
		const db = ns();
		await cmd(db, "SET", "k", "1", "EX", "100");
		await cmd(db, "INCR", "k");
		expect((await cmd(db, "TTL", "k")) as number).toBeGreaterThan(0);
		await cmd(db, "SET", "k", "1");
		expect(await cmd(db, "TTL", "k")).toBe(-1);
		await cmd(db, "SET", "k", "2", "EX", "100");
		await cmd(db, "SET", "k", "3", "KEEPTTL");
		expect((await cmd(db, "TTL", "k")) as number).toBeGreaterThan(0);
	});

	it("schedules an alarm that sweeps expired keys", async () => {
		const db = ns();
		const stub = env.LIL_REDIS.getByName(db);
		await stub.exec(["SET", "k", "v", "PX", "20"]);
		await stub.exec(["SET", "forever", "v"]);

		await runInDurableObject(stub, async (_inst: LilRedis, state) => {
			expect(await state.storage.getAlarm()).not.toBeNull();
		});

		await new Promise((r) => setTimeout(r, 40));
		// Either the runtime already fired the alarm, or we fire it now.
		await runDurableObjectAlarm(stub);

		await runInDurableObject(stub, async (_inst: LilRedis, state) => {
			// key row gone without any client access -> the sweep did it
			const rows = state.storage.sql.exec("SELECT key FROM keys ORDER BY key").toArray();
			expect(rows).toEqual([{ key: "forever" }]);
			// nothing left to expire -> no alarm
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});

describe("hashes", () => {
	it("HSET/HGET/HGETALL/HDEL/HLEN/HINCRBY", async () => {
		const db = ns();
		expect(await cmd(db, "HSET", "h", "a", "1", "b", "2")).toBe(2);
		expect(await cmd(db, "HSET", "h", "a", "9")).toBe(0);
		expect(await cmd(db, "HGET", "h", "a")).toBe("9");
		expect(await cmd(db, "HGET", "h", "zz")).toBeNull();
		expect(await cmd(db, "HMGET", "h", "a", "zz")).toEqual(["9", null]);
		expect(await cmd(db, "HGETALL", "h")).toEqual(["a", "9", "b", "2"]);
		expect(await cmd(db, "HKEYS", "h")).toEqual(["a", "b"]);
		expect(await cmd(db, "HINCRBY", "h", "b", "5")).toBe(7);
		expect(await cmd(db, "HSETNX", "h", "a", "x")).toBe(0);
		expect(await cmd(db, "HEXISTS", "h", "a")).toBe(1);
		expect(await cmd(db, "HLEN", "h")).toBe(2);
		expect(await cmd(db, "HDEL", "h", "a", "b")).toBe(2);
		expect(await cmd(db, "EXISTS", "h")).toBe(0); // empty container is removed
	});
});

describe("lists", () => {
	it("push/pop/range/index/len", async () => {
		const db = ns();
		expect(await cmd(db, "RPUSH", "l", "b", "c")).toBe(2);
		expect(await cmd(db, "LPUSH", "l", "a")).toBe(3);
		expect(await cmd(db, "LRANGE", "l", "0", "-1")).toEqual(["a", "b", "c"]);
		expect(await cmd(db, "LRANGE", "l", "-2", "-1")).toEqual(["b", "c"]);
		expect(await cmd(db, "LRANGE", "l", "5", "10")).toEqual([]);
		expect(await cmd(db, "LINDEX", "l", "-1")).toBe("c");
		expect(await cmd(db, "LLEN", "l")).toBe(3);
		expect(await cmd(db, "LSET", "l", "1", "B")).toBe("OK");
		expect(await cmd(db, "LPOP", "l")).toBe("a");
		expect(await cmd(db, "RPOP", "l", "5")).toEqual(["c", "B"]);
		expect(await cmd(db, "LPOP", "l")).toBeNull();
		expect(await cmd(db, "EXISTS", "l")).toBe(0);
	});

	it("LTRIM", async () => {
		const db = ns();
		await cmd(db, "RPUSH", "l", "1", "2", "3", "4", "5");
		expect(await cmd(db, "LTRIM", "l", "1", "-2")).toBe("OK");
		expect(await cmd(db, "LRANGE", "l", "0", "-1")).toEqual(["2", "3", "4"]);
		await cmd(db, "LTRIM", "l", "5", "10");
		expect(await cmd(db, "EXISTS", "l")).toBe(0);
	});

	it("preserves order across many interleaved pushes", async () => {
		const db = ns();
		for (let i = 0; i < 20; i++) {
			await cmd(db, i % 2 ? "LPUSH" : "RPUSH", "l", String(i));
		}
		const got = (await cmd(db, "LRANGE", "l", "0", "-1")) as string[];
		const expected: string[] = [];
		for (let i = 0; i < 20; i++) i % 2 ? expected.unshift(String(i)) : expected.push(String(i));
		expect(got).toEqual(expected);
	});
});

describe("sets", () => {
	it("SADD/SREM/SMEMBERS/SISMEMBER/SCARD + algebra", async () => {
		const db = ns();
		expect(await cmd(db, "SADD", "s1", "a", "b", "c", "a")).toBe(3);
		expect(await cmd(db, "SADD", "s2", "b", "c", "d")).toBe(3);
		expect(await cmd(db, "SMEMBERS", "s1")).toEqual(["a", "b", "c"]);
		expect(await cmd(db, "SISMEMBER", "s1", "a")).toBe(1);
		expect(await cmd(db, "SMISMEMBER", "s1", "a", "z")).toEqual([1, 0]);
		expect(await cmd(db, "SCARD", "s1")).toBe(3);
		expect(await cmd(db, "SINTER", "s1", "s2")).toEqual(["b", "c"]);
		expect(await cmd(db, "SUNION", "s1", "s2")).toEqual(["a", "b", "c", "d"]);
		expect(await cmd(db, "SDIFF", "s1", "s2")).toEqual(["a"]);
		expect(await cmd(db, "SREM", "s1", "a", "b", "c")).toBe(3);
		expect(await cmd(db, "EXISTS", "s1")).toBe(0);
	});
});

describe("websocket + RESP", () => {
	async function connect(db: string) {
		const res = await SELF.fetch(`https://lil/db/${db}`, { headers: { Upgrade: "websocket" } });
		expect(res.status).toBe(101);
		const ws = res.webSocket!;
		ws.accept();
		const inbox: string[] = [];
		const waiters: ((s: string) => void)[] = [];
		ws.addEventListener("message", (ev) => {
			const s = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
			const w = waiters.shift();
			w ? w(s) : inbox.push(s);
		});
		const next = () =>
			inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<string>((r) => waiters.push(r));
		return { ws, next };
	}

	it("speaks RESP over a WebSocket", async () => {
		const { ws, next } = await connect(ns());
		ws.send("*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n");
		expect(await next()).toBe("+OK\r\n");
		ws.send("*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n");
		expect(await next()).toBe("$3\r\nbar\r\n");
		ws.send("*1\r\n$4\r\nPING\r\n");
		expect(await next()).toBe("+PONG\r\n");
		ws.close();
	});

	it("accepts inline commands and pipelines", async () => {
		const { ws, next } = await connect(ns());
		ws.send("RPUSH q 1 2 3\r\nLRANGE q 0 -1\r\n");
		expect(await next()).toBe(":3\r\n");
		expect(await next()).toBe("*3\r\n$1\r\n1\r\n$1\r\n2\r\n$1\r\n3\r\n");
		ws.close();
	});

	it("reassembles a command split across frames", async () => {
		const { ws, next } = await connect(ns());
		ws.send("*2\r\n$4\r\nECHO\r\n$5\r\nhel");
		ws.send("lo\r\n");
		expect(await next()).toBe("$5\r\nhello\r\n");
		ws.close();
	});

	it("returns RESP errors", async () => {
		const { ws, next } = await connect(ns());
		ws.send("NOPE\r\n");
		expect(await next()).toMatch(/^-ERR unknown command 'NOPE'/);
		ws.close();
	});
});

describe("rpc", () => {
	it("exec() returns plain values and throws on errors", async () => {
		const stub = env.LIL_REDIS.getByName(ns());
		expect(await stub.exec(["SET", "a", "1"])).toBe("OK");
		expect(await stub.exec(["MGET", "a", "b"])).toEqual(["1", null]);
		// Call the instance directly: the test harness's RPC wrapper reports
		// thrown RPC errors as unhandled rejections (harness quirk, not ours).
		await runInDurableObject(stub, async (inst: LilRedis) => {
			await expect(inst.exec(["LPUSH", "a", "x"])).rejects.toThrow(/WRONGTYPE/);
		});
	});
});
