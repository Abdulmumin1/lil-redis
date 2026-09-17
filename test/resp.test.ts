import { describe, expect, it } from "vitest";
import { OK, RespError, RespParseError, RespParser, SimpleString, encode, splitInline } from "../src/resp";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("RespParser", () => {
	it("parses a complete multibulk command", () => {
		const p = new RespParser();
		expect(p.feed("*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n")).toEqual([["SET", "foo", "bar"]]);
		expect(p.pending).toBe(0);
	});

	it("reassembles a command split across chunks", () => {
		const p = new RespParser();
		expect(p.feed("*2\r\n$3\r\nGE")).toEqual([]);
		expect(p.feed("T\r\n$3\r\n")).toEqual([]);
		expect(p.feed("foo\r\n")).toEqual([["GET", "foo"]]);
	});

	it("returns multiple pipelined commands from one chunk", () => {
		const p = new RespParser();
		const cmds = p.feed("*1\r\n$4\r\nPING\r\n*2\r\n$4\r\nECHO\r\n$2\r\nhi\r\n");
		expect(cmds).toEqual([["PING"], ["ECHO", "hi"]]);
	});

	it("counts bulk lengths in bytes, not code points", () => {
		const p = new RespParser();
		const payload = "héllo"; // 6 bytes in UTF-8
		expect(p.feed(`*2\r\n$3\r\nSET\r\n$6\r\n${payload}\r\n`)).toEqual([["SET", payload]]);
	});

	it("parses inline commands", () => {
		const p = new RespParser();
		expect(p.feed("SET foo bar\r\n")).toEqual([["SET", "foo", "bar"]]);
		expect(p.feed('SET greeting "hello world"\n')).toEqual([["SET", "greeting", "hello world"]]);
	});

	it("skips empty lines", () => {
		const p = new RespParser();
		expect(p.feed("\r\n\r\nPING\r\n")).toEqual([["PING"]]);
	});

	it("throws on protocol errors", () => {
		expect(() => new RespParser().feed("*1\r\n:5\r\n")).toThrow(RespParseError);
		expect(() => new RespParser().feed("*1\r\n$2\r\nabcd\r\n")).toThrow(RespParseError);
	});
});

describe("splitInline", () => {
	it("handles quotes and escapes", () => {
		expect(splitInline(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f\\", "g"]);
		expect(splitInline(`x "line\\nbreak"`)).toEqual(["x", "line\nbreak"]);
	});
});

describe("encode", () => {
	it("encodes every RESP2 type", () => {
		expect(text(encode(OK))).toBe("+OK\r\n");
		expect(text(encode(new SimpleString("PONG")))).toBe("+PONG\r\n");
		expect(text(encode(new RespError("ERR nope")))).toBe("-ERR nope\r\n");
		expect(text(encode(42))).toBe(":42\r\n");
		expect(text(encode(-1))).toBe(":-1\r\n");
		expect(text(encode(null))).toBe("$-1\r\n");
		expect(text(encode("bar"))).toBe("$3\r\nbar\r\n");
		expect(text(encode(""))).toBe("$0\r\n\r\n");
		expect(text(encode(["a", 1, null]))).toBe("*3\r\n$1\r\na\r\n:1\r\n$-1\r\n");
		expect(text(encode([]))).toBe("*0\r\n");
	});

	it("encodes bulk strings with byte lengths", () => {
		expect(text(encode("héllo"))).toBe("$6\r\nhéllo\r\n");
	});

	it("encodes non-integer numbers as bulk strings", () => {
		expect(text(encode(1.5))).toBe("$3\r\n1.5\r\n");
	});
});
