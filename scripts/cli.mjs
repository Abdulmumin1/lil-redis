#!/usr/bin/env node
/**
 * Tiny redis-cli lookalike for lil-redis. Speaks RESP over WebSocket.
 *
 *   node scripts/cli.mjs [ws://localhost:8787/db/default]
 *   node scripts/cli.mjs ws://localhost:8787/db/myapp SET foo bar   # one-shot
 *
 * Requires Node 22+ (global WebSocket).
 */
import readline from "node:readline";

const [, , urlArg, ...oneShot] = process.argv;
const url = urlArg ?? "ws://localhost:8787/db/default";
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- RESP encode (commands) / decode (replies) ------------------------------

function encodeCommand(args) {
	let s = `*${args.length}\r\n`;
	for (const a of args) s += `$${enc.encode(a).length}\r\n${a}\r\n`;
	return s;
}

/** Decodes as many replies as are complete in `buf`. Returns [replies, rest]. */
function decodeReplies(buf) {
	const out = [];
	for (;;) {
		const r = decodeOne(buf, 0);
		if (!r) return [out, buf];
		out.push(r.value);
		buf = buf.subarray(r.next);
	}
}

function decodeOne(b, pos) {
	if (pos >= b.length) return null;
	const type = String.fromCharCode(b[pos]);
	const eol = findCRLF(b, pos + 1);
	if (eol === -1) return null;
	const line = dec.decode(b.subarray(pos + 1, eol));
	const next = eol + 2;
	switch (type) {
		case "+":
			return { value: { simple: line }, next };
		case "-":
			return { value: { error: line }, next };
		case ":":
			return { value: Number(line), next };
		case "$": {
			const len = Number(line);
			if (len === -1) return { value: null, next };
			if (b.length < next + len + 2) return null;
			return { value: dec.decode(b.subarray(next, next + len)), next: next + len + 2 };
		}
		case "*": {
			const n = Number(line);
			if (n === -1) return { value: null, next };
			const items = [];
			let p = next;
			for (let i = 0; i < n; i++) {
				const r = decodeOne(b, p);
				if (!r) return null;
				items.push(r.value);
				p = r.next;
			}
			return { value: items, next: p };
		}
		default:
			throw new Error(`bad reply type byte: ${JSON.stringify(type)}`);
	}
}

function findCRLF(b, from) {
	for (let i = from; i < b.length - 1; i++) if (b[i] === 13 && b[i + 1] === 10) return i;
	return -1;
}

function format(v, indent = "") {
	if (v === null) return `${indent}(nil)`;
	if (typeof v === "number") return `${indent}(integer) ${v}`;
	if (typeof v === "string") return `${indent}${JSON.stringify(v)}`;
	if (Array.isArray(v)) {
		if (v.length === 0) return `${indent}(empty array)`;
		return v.map((x, i) => `${indent}${i + 1}) ${format(x).trimStart()}`).join("\n");
	}
	if ("simple" in v) return `${indent}${v.simple}`;
	if ("error" in v) return `${indent}(error) ${v.error}`;
	return String(v);
}

function splitArgs(line) {
	const out = [];
	const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
	let m;
	while ((m = re.exec(line))) out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? m[3]));
	return out;
}

// ---- Connection ------------------------------------------------------------

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
let buf = new Uint8Array(0);
const pending = [];

ws.addEventListener("message", (ev) => {
	const chunk = typeof ev.data === "string" ? enc.encode(ev.data) : new Uint8Array(ev.data);
	const merged = new Uint8Array(buf.length + chunk.length);
	merged.set(buf);
	merged.set(chunk, buf.length);
	const [replies, rest] = decodeReplies(merged);
	buf = rest;
	for (const r of replies) pending.shift()?.(r);
});
ws.addEventListener("error", (e) => {
	console.error("connection error:", e.message ?? e);
	process.exit(1);
});
ws.addEventListener("close", (e) => {
	if (e.code !== 1000) console.error(`connection closed (${e.code}) ${e.reason}`);
	process.exit(e.code === 1000 ? 0 : 1);
});

function send(args) {
	return new Promise((resolve) => {
		pending.push(resolve);
		ws.send(encodeCommand(args));
	});
}

ws.addEventListener("open", async () => {
	if (oneShot.length) {
		console.log(format(await send(oneShot)));
		ws.close(1000);
		return;
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${new URL(url).pathname}> ` });
	rl.prompt();
	rl.on("line", async (line) => {
		const args = splitArgs(line.trim());
		if (args.length) {
			console.log(format(await send(args)));
			if (args[0].toUpperCase() === "QUIT") return;
		}
		rl.prompt();
	});
	rl.on("close", () => ws.close(1000));
});
