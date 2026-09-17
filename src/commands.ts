/**
 * Command dispatcher: turns a parsed RESP command into a Reply using a Store.
 * Everything here is synchronous; the Durable Object wraps each call in a
 * transaction so multi-key commands (MSET, SINTER, ...) are atomic.
 */

import { OK, PONG, RespError, SimpleString, type Command, type Reply } from "./resp";
import { Store, WrongTypeError } from "./store";

type Handler = (store: Store, args: string[]) => Reply;

interface Spec {
	/** Minimum number of args (excluding the command name). */
	min: number;
	/** Maximum number of args, or -1 for variadic. */
	max: number;
	run: Handler;
}

const err = (msg: string) => new RespError(msg);
const syntaxErr = new Error("ERR syntax error");

function int(s: string, msg = "ERR value is not an integer or out of range"): number {
	if (!/^-?\d+$/.test(s)) throw new Error(msg);
	const n = Number(s);
	if (!Number.isSafeInteger(n)) throw new Error(msg);
	return n;
}

function float(s: string): number {
	const n = Number(s);
	if (s.trim() === "" || Number.isNaN(n)) throw new Error("ERR value is not a valid float");
	return n;
}

function bool(b: boolean): number {
	return b ? 1 : 0;
}

/** Commands that can add/remove/alter a TTL; the DO reschedules its alarm after these. */
export const EXPIRY_COMMANDS = new Set([
	"SET", "SETEX", "PSETEX", "GETEX", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT",
	"PERSIST", "DEL", "GETDEL", "RENAME", "FLUSHDB", "FLUSHALL",
]);

const commands: Record<string, Spec> = {
	// ---------------------------------------------------------------- connection
	PING: { min: 0, max: 1, run: (_s, a) => (a.length ? a[0]! : PONG) },
	ECHO: { min: 1, max: 1, run: (_s, a) => a[0]! },
	QUIT: { min: 0, max: 0, run: () => OK },
	SELECT: { min: 1, max: 1, run: () => OK }, // one logical db per namespace
	CLIENT: { min: 0, max: -1, run: () => OK },
	COMMAND: { min: 0, max: -1, run: () => [] },
	INFO: {
		min: 0,
		max: -1,
		run: (s) => `# Server\r\nredis_version:7.0.0-lil\r\nlil_redis:1\r\n# Keyspace\r\ndb0:keys=${s.dbsize()}\r\n`,
	},

	// ------------------------------------------------------------------ keyspace
	DEL: { min: 1, max: -1, run: (s, a) => a.reduce((n, k) => n + bool(s.del(k)), 0) },
	UNLINK: { min: 1, max: -1, run: (s, a) => a.reduce((n, k) => n + bool(s.del(k)), 0) },
	EXISTS: { min: 1, max: -1, run: (s, a) => a.reduce((n, k) => n + bool(s.exists(k)), 0) },
	TYPE: { min: 1, max: 1, run: (s, a) => new SimpleString(s.type(a[0]!)) },
	KEYS: { min: 1, max: 1, run: (s, a) => s.keys(a[0]!) },
	DBSIZE: { min: 0, max: 0, run: (s) => s.dbsize() },
	FLUSHDB: { min: 0, max: 1, run: (s) => (s.flush(), OK) },
	FLUSHALL: { min: 0, max: 1, run: (s) => (s.flush(), OK) },
	RENAME: {
		min: 2,
		max: 2,
		run: (s, a) => (s.rename(a[0]!, a[1]!) ? OK : err("ERR no such key")),
	},
	RENAMENX: {
		min: 2,
		max: 2,
		run: (s, a) => {
			if (!s.exists(a[0]!)) return err("ERR no such key");
			if (s.exists(a[1]!)) return 0;
			return bool(s.rename(a[0]!, a[1]!));
		},
	},

	// -------------------------------------------------------------------- expiry
	EXPIRE: { min: 2, max: 2, run: (s, a) => bool(s.expireAt(a[0]!, Date.now() + int(a[1]!) * 1000)) },
	PEXPIRE: { min: 2, max: 2, run: (s, a) => bool(s.expireAt(a[0]!, Date.now() + int(a[1]!))) },
	EXPIREAT: { min: 2, max: 2, run: (s, a) => bool(s.expireAt(a[0]!, int(a[1]!) * 1000)) },
	PEXPIREAT: { min: 2, max: 2, run: (s, a) => bool(s.expireAt(a[0]!, int(a[1]!))) },
	PERSIST: { min: 1, max: 1, run: (s, a) => bool(s.persist(a[0]!)) },
	PTTL: { min: 1, max: 1, run: (s, a) => s.pttl(a[0]!) },
	TTL: {
		min: 1,
		max: 1,
		run: (s, a) => {
			const ms = s.pttl(a[0]!);
			return ms < 0 ? ms : Math.ceil(ms / 1000);
		},
	},

	// ------------------------------------------------------------------- strings
	GET: { min: 1, max: 1, run: (s, a) => s.get(a[0]!) },
	SET: {
		min: 2,
		max: -1,
		run: (s, [key, value, ...opts]) => {
			let expiresAt: number | null | "keep" = null;
			let nx = false;
			let xx = false;
			let get = false;
			for (let i = 0; i < opts.length; i++) {
				const o = opts[i]!.toUpperCase();
				const next = () => {
					const v = opts[++i];
					if (v === undefined) throw syntaxErr;
					return v;
				};
				if (o === "EX") expiresAt = Date.now() + int(next()) * 1000;
				else if (o === "PX") expiresAt = Date.now() + int(next());
				else if (o === "EXAT") expiresAt = int(next()) * 1000;
				else if (o === "PXAT") expiresAt = int(next());
				else if (o === "KEEPTTL") expiresAt = "keep";
				else if (o === "NX") nx = true;
				else if (o === "XX") xx = true;
				else if (o === "GET") get = true;
				else throw syntaxErr;
			}
			if (nx && xx) throw syntaxErr;
			const prev = get ? s.get(key!) : undefined;
			const exists = s.exists(key!);
			if ((nx && exists) || (xx && !exists)) return get ? (prev ?? null) : null;
			s.set(key!, value!, expiresAt);
			return get ? (prev ?? null) : OK;
		},
	},
	SETNX: { min: 2, max: 2, run: (s, a) => (s.exists(a[0]!) ? 0 : (s.set(a[0]!, a[1]!), 1)) },
	SETEX: { min: 3, max: 3, run: (s, a) => (s.set(a[0]!, a[2]!, Date.now() + int(a[1]!) * 1000), OK) },
	PSETEX: { min: 3, max: 3, run: (s, a) => (s.set(a[0]!, a[2]!, Date.now() + int(a[1]!)), OK) },
	GETSET: {
		min: 2,
		max: 2,
		run: (s, a) => {
			const prev = s.get(a[0]!);
			s.set(a[0]!, a[1]!);
			return prev;
		},
	},
	GETDEL: {
		min: 1,
		max: 1,
		run: (s, a) => {
			const v = s.get(a[0]!);
			if (v !== null) s.del(a[0]!);
			return v;
		},
	},
	MGET: { min: 1, max: -1, run: (s, a) => a.map((k) => safeGet(s, k)) },
	MSET: {
		min: 2,
		max: -1,
		run: (s, a) => {
			if (a.length % 2) return err("ERR wrong number of arguments for 'mset' command");
			for (let i = 0; i < a.length; i += 2) s.set(a[i]!, a[i + 1]!);
			return OK;
		},
	},
	MSETNX: {
		min: 2,
		max: -1,
		run: (s, a) => {
			if (a.length % 2) return err("ERR wrong number of arguments for 'msetnx' command");
			for (let i = 0; i < a.length; i += 2) if (s.exists(a[i]!)) return 0;
			for (let i = 0; i < a.length; i += 2) s.set(a[i]!, a[i + 1]!);
			return 1;
		},
	},
	INCR: { min: 1, max: 1, run: (s, a) => s.incrBy(a[0]!, 1) },
	DECR: { min: 1, max: 1, run: (s, a) => s.incrBy(a[0]!, -1) },
	INCRBY: { min: 2, max: 2, run: (s, a) => s.incrBy(a[0]!, int(a[1]!)) },
	DECRBY: { min: 2, max: 2, run: (s, a) => s.incrBy(a[0]!, -int(a[1]!)) },
	INCRBYFLOAT: { min: 2, max: 2, run: (s, a) => s.incrByFloat(a[0]!, float(a[1]!)) },
	APPEND: { min: 2, max: 2, run: (s, a) => s.append(a[0]!, a[1]!) },
	STRLEN: { min: 1, max: 1, run: (s, a) => (s.get(a[0]!) ?? "").length },

	// -------------------------------------------------------------------- hashes
	HSET: {
		min: 3,
		max: -1,
		run: (s, [key, ...rest]) => {
			if (rest.length % 2) return err("ERR wrong number of arguments for 'hset' command");
			const pairs: [string, string][] = [];
			for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i]!, rest[i + 1]!]);
			return s.hset(key!, pairs);
		},
	},
	HMSET: {
		min: 3,
		max: -1,
		run: (s, [key, ...rest]) => {
			if (rest.length % 2) return err("ERR wrong number of arguments for 'hmset' command");
			const pairs: [string, string][] = [];
			for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i]!, rest[i + 1]!]);
			s.hset(key!, pairs);
			return OK;
		},
	},
	HSETNX: { min: 3, max: 3, run: (s, a) => bool(s.hsetnx(a[0]!, a[1]!, a[2]!)) },
	HGET: { min: 2, max: 2, run: (s, a) => s.hget(a[0]!, a[1]!) },
	HMGET: { min: 2, max: -1, run: (s, [key, ...fields]) => fields.map((f) => s.hget(key!, f)) },
	HGETALL: { min: 1, max: 1, run: (s, a) => s.hgetall(a[0]!).flat() },
	HKEYS: { min: 1, max: 1, run: (s, a) => s.hgetall(a[0]!).map((p) => p[0]) },
	HVALS: { min: 1, max: 1, run: (s, a) => s.hgetall(a[0]!).map((p) => p[1]) },
	HDEL: { min: 2, max: -1, run: (s, [key, ...fields]) => s.hdel(key!, fields) },
	HEXISTS: { min: 2, max: 2, run: (s, a) => bool(s.hget(a[0]!, a[1]!) !== null) },
	HLEN: { min: 1, max: 1, run: (s, a) => s.hlen(a[0]!) },
	HINCRBY: { min: 3, max: 3, run: (s, a) => s.hincrBy(a[0]!, a[1]!, int(a[2]!)) },

	// --------------------------------------------------------------------- lists
	LPUSH: { min: 2, max: -1, run: (s, [key, ...vals]) => s.push(key!, vals, "left") },
	RPUSH: { min: 2, max: -1, run: (s, [key, ...vals]) => s.push(key!, vals, "right") },
	LPUSHX: { min: 2, max: -1, run: (s, [key, ...vals]) => (s.exists(key!) ? s.push(key!, vals, "left") : 0) },
	RPUSHX: { min: 2, max: -1, run: (s, [key, ...vals]) => (s.exists(key!) ? s.push(key!, vals, "right") : 0) },
	LPOP: { min: 1, max: 2, run: (s, a) => popReply(s, a, "left") },
	RPOP: { min: 1, max: 2, run: (s, a) => popReply(s, a, "right") },
	LLEN: { min: 1, max: 1, run: (s, a) => s.llen(a[0]!) },
	LRANGE: { min: 3, max: 3, run: (s, a) => s.lrange(a[0]!, int(a[1]!), int(a[2]!)) },
	LINDEX: { min: 2, max: 2, run: (s, a) => s.lindex(a[0]!, int(a[1]!)) },
	LSET: {
		min: 3,
		max: 3,
		run: (s, a) => (s.lset(a[0]!, int(a[1]!), a[2]!) ? OK : err("ERR index out of range")),
	},
	LTRIM: { min: 3, max: 3, run: (s, a) => (s.ltrim(a[0]!, int(a[1]!), int(a[2]!)), OK) },

	// ---------------------------------------------------------------------- sets
	SADD: { min: 2, max: -1, run: (s, [key, ...m]) => s.sadd(key!, m) },
	SREM: { min: 2, max: -1, run: (s, [key, ...m]) => s.srem(key!, m) },
	SMEMBERS: { min: 1, max: 1, run: (s, a) => s.smembers(a[0]!) },
	SISMEMBER: { min: 2, max: 2, run: (s, a) => bool(s.sismember(a[0]!, a[1]!)) },
	SMISMEMBER: { min: 2, max: -1, run: (s, [key, ...m]) => m.map((x) => bool(s.sismember(key!, x))) },
	SCARD: { min: 1, max: 1, run: (s, a) => s.scard(a[0]!) },
	SINTER: { min: 1, max: -1, run: (s, a) => s.setOp("inter", a) },
	SUNION: { min: 1, max: -1, run: (s, a) => s.setOp("union", a) },
	SDIFF: { min: 1, max: -1, run: (s, a) => s.setOp("diff", a) },
};

/** MGET must return nil (not WRONGTYPE) for non-string keys. */
function safeGet(s: Store, key: string): string | null {
	try {
		return s.get(key);
	} catch (e) {
		if (e instanceof WrongTypeError) return null;
		throw e;
	}
}

function popReply(s: Store, a: string[], side: "left" | "right"): Reply {
	if (a.length === 1) {
		const [v] = s.pop(a[0]!, side, 1);
		return v ?? null;
	}
	const count = int(a[1]!);
	if (count < 0) throw new Error("ERR value is out of range, must be positive");
	if (!s.exists(a[0]!)) return null;
	return s.pop(a[0]!, side, count);
}

export function execute(store: Store, cmd: Command): Reply {
	if (cmd.length === 0) return err("ERR empty command");
	const name = cmd[0]!.toUpperCase();
	const spec = commands[name];
	if (!spec) {
		return err(`ERR unknown command '${cmd[0]}', with args beginning with: ${cmd.slice(1, 4).map((a) => `'${a}'`).join(" ")}`);
	}
	const args = cmd.slice(1);
	if (args.length < spec.min || (spec.max !== -1 && args.length > spec.max)) {
		return err(`ERR wrong number of arguments for '${name.toLowerCase()}' command`);
	}
	try {
		return spec.run(store, args);
	} catch (e) {
		if (e instanceof WrongTypeError) return err(e.message);
		if (e instanceof Error && e.message.startsWith("ERR ")) return err(e.message);
		throw e;
	}
}

export const COMMAND_NAMES = Object.keys(commands);
