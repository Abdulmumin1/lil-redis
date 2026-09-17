/**
 * RESP2 (REdis Serialization Protocol) parser + encoder.
 *
 * Parser is streaming: feed it byte chunks, it hands back complete commands.
 * It also accepts "inline" commands (`SET foo bar\r\n`) so you can poke at
 * the server with any plain WebSocket client.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const CR = 0x0d;
const LF = 0x0a;
const STAR = 0x2a; // *
const DOLLAR = 0x24; // $

export type Command = string[];

export class RespParseError extends Error {}

export class RespParser {
	private buf: Uint8Array = new Uint8Array(0);

	/** Bytes currently buffered (useful for tests + backpressure checks). */
	get pending(): number {
		return this.buf.length;
	}

	feed(chunk: Uint8Array | string): Command[] {
		const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
		this.buf = this.buf.length === 0 ? bytes : concat([this.buf, bytes]);

		const out: Command[] = [];
		for (;;) {
			const res = this.parseOne(this.buf);
			if (res === undefined) break; // need more data
			out.push(res.cmd);
			this.buf = this.buf.subarray(res.consumed);
			if (this.buf.length === 0) break;
		}
		return out;
	}

	/** Returns a command + bytes consumed, or undefined if more data is needed. */
	private parseOne(b: Uint8Array): { cmd: Command; consumed: number } | undefined {
		if (b.length === 0) return undefined;

		// Skip stray leading newlines (e.g. a client sending an empty line).
		let start = 0;
		while (start < b.length && (b[start] === CR || b[start] === LF)) start++;
		if (start === b.length) return { cmd: [], consumed: start };
		if (start > 0) {
			const r = this.parseOne(b.subarray(start));
			return r ? { cmd: r.cmd, consumed: r.consumed + start } : undefined;
		}

		if (b[0] !== STAR) return parseInline(b);

		let pos = 0;
		const header = readLine(b, pos);
		if (!header) return undefined;
		pos = header.next;
		const count = parseInt(header.line, 10);
		if (Number.isNaN(count) || count < -1) {
			throw new RespParseError(`Protocol error: invalid multibulk length`);
		}
		if (count <= 0) return { cmd: [], consumed: pos };

		const cmd: Command = [];
		for (let i = 0; i < count; i++) {
			if (pos >= b.length) return undefined;
			if (b[pos] !== DOLLAR) {
				throw new RespParseError(
					`Protocol error: expected '$', got '${String.fromCharCode(b[pos]!)}'`,
				);
			}
			const lenLine = readLine(b, pos);
			if (!lenLine) return undefined;
			const len = parseInt(lenLine.line, 10);
			if (Number.isNaN(len) || len < 0) {
				throw new RespParseError(`Protocol error: invalid bulk length`);
			}
			const dataStart = lenLine.next;
			const dataEnd = dataStart + len;
			if (b.length < dataEnd + 2) return undefined;
			if (b[dataEnd] !== CR || b[dataEnd + 1] !== LF) {
				throw new RespParseError(`Protocol error: bulk string not terminated by CRLF`);
			}
			cmd.push(dec.decode(b.subarray(dataStart, dataEnd)));
			pos = dataEnd + 2;
		}
		return { cmd, consumed: pos };
	}
}

/** Reads the line starting *after* the type byte at `pos`. */
function readLine(b: Uint8Array, pos: number): { line: string; next: number } | undefined {
	for (let i = pos + 1; i < b.length - 1; i++) {
		if (b[i] === CR && b[i + 1] === LF) {
			return { line: dec.decode(b.subarray(pos + 1, i)), next: i + 2 };
		}
	}
	return undefined;
}

/** Inline command: whitespace-separated tokens, supports "double" and 'single' quotes. */
function parseInline(b: Uint8Array): { cmd: Command; consumed: number } | undefined {
	let end = -1;
	for (let i = 0; i < b.length; i++) {
		if (b[i] === LF) {
			end = i;
			break;
		}
	}
	if (end === -1) return undefined;
	const raw = dec.decode(b.subarray(0, end)).replace(/\r$/, "");
	return { cmd: splitInline(raw), consumed: end + 1 };
}

export function splitInline(line: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < line.length) {
		while (i < line.length && /\s/.test(line[i]!)) i++;
		if (i >= line.length) break;
		const q = line[i];
		if (q === '"' || q === "'") {
			let s = "";
			i++;
			while (i < line.length && line[i] !== q) {
				if (line[i] === "\\" && i + 1 < line.length) {
					i++;
					const c = line[i]!;
					s += c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c;
				} else {
					s += line[i];
				}
				i++;
			}
			if (i >= line.length) throw new RespParseError("Protocol error: unbalanced quotes in request");
			i++; // closing quote
			out.push(s);
		} else {
			let s = "";
			while (i < line.length && !/\s/.test(line[i]!)) s += line[i++];
			out.push(s);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/** A RESP simple string, e.g. `+OK`. Plain JS strings encode as bulk strings. */
export class SimpleString {
	constructor(public readonly value: string) {}
}

/** A RESP error, e.g. `-ERR unknown command`. */
export class RespError {
	constructor(public readonly message: string) {}
}

export type Reply = string | number | null | SimpleString | RespError | Reply[];

export const OK = new SimpleString("OK");
export const PONG = new SimpleString("PONG");

export function encode(reply: Reply): Uint8Array {
	const parts: Uint8Array[] = [];
	write(reply, parts);
	return concat(parts);
}

function write(r: Reply, parts: Uint8Array[]): void {
	if (r === null) {
		parts.push(enc.encode("$-1\r\n"));
	} else if (typeof r === "string") {
		const body = enc.encode(r);
		parts.push(enc.encode(`$${body.length}\r\n`), body, enc.encode("\r\n"));
	} else if (typeof r === "number") {
		if (!Number.isInteger(r)) {
			// RESP2 has no double type; Redis returns floats as bulk strings.
			write(String(r), parts);
		} else {
			parts.push(enc.encode(`:${r}\r\n`));
		}
	} else if (r instanceof SimpleString) {
		parts.push(enc.encode(`+${r.value}\r\n`));
	} else if (r instanceof RespError) {
		parts.push(enc.encode(`-${r.message}\r\n`));
	} else {
		parts.push(enc.encode(`*${r.length}\r\n`));
		for (const item of r) write(item, parts);
	}
}

function concat(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}
