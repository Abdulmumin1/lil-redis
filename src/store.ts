/**
 * SQLite-backed storage for lil-redis.
 *
 * Schema:
 *   keys   – one row per key: type, optional string value, optional expiry
 *   hashes – (key, field) -> value
 *   sets   – (key, member)
 *   lists  – (key, pos) -> value; pos is a signed integer, LPUSH decrements
 *            the head, RPUSH increments the tail, so order = ORDER BY pos.
 *
 * Expiry is handled lazily on access (`touch`) and eagerly by the Durable
 * Object alarm (`sweepExpired`).
 */

export type KeyType = "string" | "hash" | "list" | "set";

export class WrongTypeError extends Error {
	constructor() {
		super("WRONGTYPE Operation against a key holding the wrong kind of value");
	}
}

type KeyRow = {
	key: string;
	type: KeyType;
	value: string | null;
	expires_at: number | null;
};

export class Store {
	constructor(private readonly sql: SqlStorage) {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS keys (
				key        TEXT PRIMARY KEY,
				type       TEXT NOT NULL,
				value      TEXT,
				expires_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS keys_expires_at
				ON keys(expires_at) WHERE expires_at IS NOT NULL;

			CREATE TABLE IF NOT EXISTS hashes (
				key   TEXT NOT NULL,
				field TEXT NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (key, field)
			);

			CREATE TABLE IF NOT EXISTS sets (
				key    TEXT NOT NULL,
				member TEXT NOT NULL,
				PRIMARY KEY (key, member)
			);

			CREATE TABLE IF NOT EXISTS lists (
				key   TEXT NOT NULL,
				pos   INTEGER NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (key, pos)
			);
		`);
	}

	// -------------------------------------------------------------------------
	// Keyspace
	// -------------------------------------------------------------------------

	/**
	 * Runs a write statement and returns the number of *table* rows it changed.
	 * (`cursor.rowsWritten` also counts index rows, so it can't be used for this.)
	 */
	private write(query: string, ...bindings: SqlStorageValue[]): number {
		this.sql.exec(query, ...bindings);
		return this.sql.exec<{ n: number }>("SELECT changes() AS n").one().n;
	}

	/**
	 * Returns the key's metadata row, deleting it first if it has expired.
	 * Every other method goes through this, which is what gives us lazy expiry.
	 */
	private meta(key: string): KeyRow | null {
		const row = this.sql
			.exec<KeyRow>("SELECT key, type, value, expires_at FROM keys WHERE key = ?", key)
			.toArray()[0];
		if (!row) return null;
		if (row.expires_at !== null && row.expires_at <= Date.now()) {
			this.del(key);
			return null;
		}
		return row;
	}

	/** Like `meta`, but throws WRONGTYPE unless the key is absent or of `type`. */
	private metaOfType(key: string, type: KeyType): KeyRow | null {
		const row = this.meta(key);
		if (row && row.type !== type) throw new WrongTypeError();
		return row;
	}

	/** Ensures a container key (hash/list/set) exists. Returns its row. */
	private ensure(key: string, type: KeyType): KeyRow {
		const row = this.metaOfType(key, type);
		if (row) return row;
		this.sql.exec("INSERT INTO keys (key, type) VALUES (?, ?)", key, type);
		return { key, type, value: null, expires_at: null };
	}

	/** Drop the key row if the container it points at became empty. */
	private pruneIfEmpty(key: string, type: KeyType): void {
		const table = type === "hash" ? "hashes" : type === "set" ? "sets" : "lists";
		const n = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE key = ?`, key)
			.one().n;
		if (n === 0) this.sql.exec("DELETE FROM keys WHERE key = ?", key);
	}

	exists(key: string): boolean {
		return this.meta(key) !== null;
	}

	type(key: string): KeyType | "none" {
		return this.meta(key)?.type ?? "none";
	}

	/** Deletes a key of any type. Returns true if it existed. */
	del(key: string): boolean {
		const n = this.write("DELETE FROM keys WHERE key = ?", key);
		this.sql.exec("DELETE FROM hashes WHERE key = ?", key);
		this.sql.exec("DELETE FROM sets WHERE key = ?", key);
		this.sql.exec("DELETE FROM lists WHERE key = ?", key);
		return n > 0;
	}

	/** Glob-style pattern match (Redis and SQLite GLOB share syntax: * ? [..]). */
	keys(pattern: string): string[] {
		const now = Date.now();
		return this.sql
			.exec<{ key: string }>(
				"SELECT key FROM keys WHERE key GLOB ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key",
				pattern,
				now,
			)
			.toArray()
			.map((r) => r.key);
	}

	dbsize(): number {
		return this.sql
			.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM keys WHERE expires_at IS NULL OR expires_at > ?",
				Date.now(),
			)
			.one().n;
	}

	flush(): void {
		this.sql.exec("DELETE FROM keys; DELETE FROM hashes; DELETE FROM sets; DELETE FROM lists;");
	}

	rename(src: string, dst: string): boolean {
		const row = this.meta(src);
		if (!row) return false;
		if (src === dst) return true;
		this.del(dst);
		this.sql.exec("UPDATE keys SET key = ? WHERE key = ?", dst, src);
		this.sql.exec("UPDATE hashes SET key = ? WHERE key = ?", dst, src);
		this.sql.exec("UPDATE sets SET key = ? WHERE key = ?", dst, src);
		this.sql.exec("UPDATE lists SET key = ? WHERE key = ?", dst, src);
		return true;
	}

	// -------------------------------------------------------------------------
	// Expiry
	// -------------------------------------------------------------------------

	/** Sets an absolute expiry (ms epoch). Returns false if key doesn't exist. */
	expireAt(key: string, at: number): boolean {
		if (!this.meta(key)) return false;
		if (at <= Date.now()) {
			this.del(key);
			return true;
		}
		this.sql.exec("UPDATE keys SET expires_at = ? WHERE key = ?", at, key);
		return true;
	}

	persist(key: string): boolean {
		const row = this.meta(key);
		if (!row || row.expires_at === null) return false;
		this.sql.exec("UPDATE keys SET expires_at = NULL WHERE key = ?", key);
		return true;
	}

	/** Remaining TTL in ms, -1 if no expiry, -2 if key is missing. */
	pttl(key: string): number {
		const row = this.meta(key);
		if (!row) return -2;
		if (row.expires_at === null) return -1;
		return Math.max(0, row.expires_at - Date.now());
	}

	/** Earliest pending expiry, or null. Used to schedule the DO alarm. */
	nextExpiry(): number | null {
		const row = this.sql
			.exec<{ t: number | null }>("SELECT MIN(expires_at) AS t FROM keys")
			.one();
		return row.t ?? null;
	}

	/** Deletes every expired key. Returns how many were removed. */
	sweepExpired(): number {
		const now = Date.now();
		const expired = this.sql
			.exec<{ key: string }>("SELECT key FROM keys WHERE expires_at IS NOT NULL AND expires_at <= ?", now)
			.toArray();
		for (const { key } of expired) this.del(key);
		return expired.length;
	}

	// -------------------------------------------------------------------------
	// Strings
	// -------------------------------------------------------------------------

	get(key: string): string | null {
		const row = this.metaOfType(key, "string");
		return row ? row.value : null;
	}

	/**
	 * Sets a string. `expiresAt`: number = absolute ms, null = no expiry,
	 * "keep" = preserve existing TTL (Redis KEEPTTL).
	 */
	set(key: string, value: string, expiresAt: number | null | "keep" = null): void {
		const row = this.meta(key);
		const exp = expiresAt === "keep" ? (row?.type === "string" ? row.expires_at : null) : expiresAt;
		if (row && row.type !== "string") this.del(key); // overwrite container
		this.sql.exec(
			`INSERT INTO keys (key, type, value, expires_at) VALUES (?, 'string', ?, ?)
			 ON CONFLICT(key) DO UPDATE SET type = 'string', value = excluded.value, expires_at = excluded.expires_at`,
			key,
			value,
			exp,
		);
	}

	/** Adds `by` to an integer string. Throws on non-integer values. */
	incrBy(key: string, by: number): number {
		const cur = this.get(key);
		let n = 0;
		if (cur !== null) {
			if (!/^-?\d+$/.test(cur)) throw new Error("ERR value is not an integer or out of range");
			n = Number(cur);
		}
		const next = n + by;
		if (!Number.isSafeInteger(next)) throw new Error("ERR increment or decrement would overflow");
		this.set(key, String(next), "keep");
		return next;
	}

	incrByFloat(key: string, by: number): string {
		const cur = this.get(key);
		let n = 0;
		if (cur !== null) {
			n = Number(cur);
			if (Number.isNaN(n)) throw new Error("ERR value is not a valid float");
		}
		const next = n + by;
		if (!Number.isFinite(next)) throw new Error("ERR increment would produce NaN or Infinity");
		const s = String(next);
		this.set(key, s, "keep");
		return s;
	}

	append(key: string, suffix: string): number {
		const cur = this.get(key) ?? "";
		const next = cur + suffix;
		this.set(key, next, "keep");
		return next.length;
	}

	// -------------------------------------------------------------------------
	// Hashes
	// -------------------------------------------------------------------------

	hset(key: string, pairs: [string, string][]): number {
		this.ensure(key, "hash");
		let added = 0;
		for (const [field, value] of pairs) {
			const existed = this.sql
				.exec("SELECT 1 FROM hashes WHERE key = ? AND field = ?", key, field)
				.toArray().length;
			this.sql.exec(
				`INSERT INTO hashes (key, field, value) VALUES (?, ?, ?)
				 ON CONFLICT(key, field) DO UPDATE SET value = excluded.value`,
				key,
				field,
				value,
			);
			if (!existed) added++;
		}
		return added;
	}

	hsetnx(key: string, field: string, value: string): boolean {
		this.ensure(key, "hash");
		const n = this.write(
			"INSERT OR IGNORE INTO hashes (key, field, value) VALUES (?, ?, ?)",
			key,
			field,
			value,
		);
		return n > 0;
	}

	hget(key: string, field: string): string | null {
		if (!this.metaOfType(key, "hash")) return null;
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM hashes WHERE key = ? AND field = ?", key, field)
			.toArray()[0];
		return row ? row.value : null;
	}

	hgetall(key: string): [string, string][] {
		if (!this.metaOfType(key, "hash")) return [];
		return this.sql
			.exec<{ field: string; value: string }>(
				"SELECT field, value FROM hashes WHERE key = ? ORDER BY rowid",
				key,
			)
			.toArray()
			.map((r) => [r.field, r.value]);
	}

	hdel(key: string, fields: string[]): number {
		if (!this.metaOfType(key, "hash")) return 0;
		let n = 0;
		for (const f of fields) {
			n += this.write("DELETE FROM hashes WHERE key = ? AND field = ?", key, f);
		}
		if (n > 0) this.pruneIfEmpty(key, "hash");
		return n;
	}

	hlen(key: string): number {
		if (!this.metaOfType(key, "hash")) return 0;
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hashes WHERE key = ?", key).one().n;
	}

	hincrBy(key: string, field: string, by: number): number {
		const cur = this.hget(key, field);
		let n = 0;
		if (cur !== null) {
			if (!/^-?\d+$/.test(cur)) throw new Error("ERR hash value is not an integer");
			n = Number(cur);
		}
		const next = n + by;
		if (!Number.isSafeInteger(next)) throw new Error("ERR increment or decrement would overflow");
		this.hset(key, [[field, String(next)]]);
		return next;
	}

	// -------------------------------------------------------------------------
	// Sets
	// -------------------------------------------------------------------------

	sadd(key: string, members: string[]): number {
		this.ensure(key, "set");
		let n = 0;
		for (const m of members) {
			n += this.write("INSERT OR IGNORE INTO sets (key, member) VALUES (?, ?)", key, m);
		}
		return n;
	}

	srem(key: string, members: string[]): number {
		if (!this.metaOfType(key, "set")) return 0;
		let n = 0;
		for (const m of members) {
			n += this.write("DELETE FROM sets WHERE key = ? AND member = ?", key, m);
		}
		if (n > 0) this.pruneIfEmpty(key, "set");
		return n;
	}

	smembers(key: string): string[] {
		if (!this.metaOfType(key, "set")) return [];
		return this.sql
			.exec<{ member: string }>("SELECT member FROM sets WHERE key = ? ORDER BY member", key)
			.toArray()
			.map((r) => r.member);
	}

	sismember(key: string, member: string): boolean {
		if (!this.metaOfType(key, "set")) return false;
		return this.sql.exec("SELECT 1 FROM sets WHERE key = ? AND member = ?", key, member).toArray().length > 0;
	}

	scard(key: string): number {
		if (!this.metaOfType(key, "set")) return 0;
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sets WHERE key = ?", key).one().n;
	}

	/** Set algebra over any number of keys. Missing keys are treated as empty. */
	setOp(op: "inter" | "union" | "diff", keys: string[]): string[] {
		const sets = keys.map((k) => new Set(this.smembers(k)));
		const first = sets[0];
		if (!first) return [];
		let result: Set<string>;
		if (op === "union") {
			result = new Set<string>();
			for (const s of sets) for (const m of s) result.add(m);
		} else if (op === "inter") {
			result = new Set([...first].filter((m) => sets.every((s) => s.has(m))));
		} else {
			result = new Set([...first].filter((m) => sets.slice(1).every((s) => !s.has(m))));
		}
		return [...result].sort();
	}

	// -------------------------------------------------------------------------
	// Lists
	// -------------------------------------------------------------------------

	private bounds(key: string): { lo: number; hi: number; len: number } {
		const r = this.sql
			.exec<{ lo: number | null; hi: number | null; len: number }>(
				"SELECT MIN(pos) AS lo, MAX(pos) AS hi, COUNT(*) AS len FROM lists WHERE key = ?",
				key,
			)
			.one();
		return { lo: r.lo ?? 0, hi: r.hi ?? -1, len: r.len };
	}

	push(key: string, values: string[], side: "left" | "right"): number {
		this.ensure(key, "list");
		let { lo, hi, len } = this.bounds(key);
		for (const v of values) {
			const pos = side === "left" ? --lo : ++hi;
			this.sql.exec("INSERT INTO lists (key, pos, value) VALUES (?, ?, ?)", key, pos, v);
			len++;
		}
		return len;
	}

	pop(key: string, side: "left" | "right", count = 1): string[] {
		if (!this.metaOfType(key, "list")) return [];
		const order = side === "left" ? "ASC" : "DESC";
		const rows = this.sql
			.exec<{ pos: number; value: string }>(
				`SELECT pos, value FROM lists WHERE key = ? ORDER BY pos ${order} LIMIT ?`,
				key,
				count,
			)
			.toArray();
		for (const r of rows) this.sql.exec("DELETE FROM lists WHERE key = ? AND pos = ?", key, r.pos);
		if (rows.length > 0) this.pruneIfEmpty(key, "list");
		return rows.map((r) => r.value);
	}

	llen(key: string): number {
		if (!this.metaOfType(key, "list")) return 0;
		return this.bounds(key).len;
	}

	/** Redis-style inclusive range with negative indexes. */
	lrange(key: string, start: number, stop: number): string[] {
		if (!this.metaOfType(key, "list")) return [];
		const { len } = this.bounds(key);
		const [s, e] = normalizeRange(start, stop, len);
		if (s > e) return [];
		return this.sql
			.exec<{ value: string }>(
				"SELECT value FROM lists WHERE key = ? ORDER BY pos LIMIT ? OFFSET ?",
				key,
				e - s + 1,
				s,
			)
			.toArray()
			.map((r) => r.value);
	}

	lindex(key: string, index: number): string | null {
		if (!this.metaOfType(key, "list")) return null;
		const { len } = this.bounds(key);
		const i = index < 0 ? len + index : index;
		if (i < 0 || i >= len) return null;
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM lists WHERE key = ? ORDER BY pos LIMIT 1 OFFSET ?", key, i)
			.toArray()[0];
		return row ? row.value : null;
	}

	lset(key: string, index: number, value: string): boolean {
		if (!this.metaOfType(key, "list")) throw new Error("ERR no such key");
		const { len } = this.bounds(key);
		const i = index < 0 ? len + index : index;
		if (i < 0 || i >= len) return false;
		const row = this.sql
			.exec<{ pos: number }>("SELECT pos FROM lists WHERE key = ? ORDER BY pos LIMIT 1 OFFSET ?", key, i)
			.one();
		this.sql.exec("UPDATE lists SET value = ? WHERE key = ? AND pos = ?", value, key, row.pos);
		return true;
	}

	ltrim(key: string, start: number, stop: number): void {
		if (!this.metaOfType(key, "list")) return;
		const { len } = this.bounds(key);
		const [s, e] = normalizeRange(start, stop, len);
		if (s > e) {
			this.del(key);
			return;
		}
		const keep = this.sql
			.exec<{ pos: number }>("SELECT pos FROM lists WHERE key = ? ORDER BY pos LIMIT ? OFFSET ?", key, e - s + 1, s)
			.toArray();
		const lo = keep[0]!.pos;
		const hi = keep[keep.length - 1]!.pos;
		this.sql.exec("DELETE FROM lists WHERE key = ? AND (pos < ? OR pos > ?)", key, lo, hi);
		this.pruneIfEmpty(key, "list");
	}
}

/** Clamp a Redis [start, stop] pair (negatives count from the end) into [s, e]. */
function normalizeRange(start: number, stop: number, len: number): [number, number] {
	let s = start < 0 ? len + start : start;
	let e = stop < 0 ? len + stop : stop;
	if (s < 0) s = 0;
	if (e >= len) e = len - 1;
	return [s, e];
}
