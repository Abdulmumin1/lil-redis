# lil-redis

A small Redis that runs on a Cloudflare Durable Object.

- Speaks real **RESP2** over WebSocket (plus a JSON-over-HTTP fallback and a Worker RPC method)
- **One Durable Object per namespace** — every key in `/db/myapp` lives in one SQLite file, so multi-key commands are atomic
- Strings, keyspace, TTLs, hashes, lists, sets (~75 commands)
- Expiry is lazy on access *and* eager via a single self-rescheduling DO alarm
- WebSocket Hibernation: idle connections cost nothing

Live at `redis.yaqeen.me`.

> **No auth yet.** Anyone can read/write any namespace. Treat the public instance as a scratchpad. See [docs/V2.md](docs/V2.md).

## Try it

```sh
# REPL (Node 22+, no deps)
node scripts/cli.mjs wss://redis.yaqeen.me/db/scratch

# one-shot
node scripts/cli.mjs wss://redis.yaqeen.me/db/scratch SET greeting hello EX 60
node scripts/cli.mjs wss://redis.yaqeen.me/db/scratch GET greeting

# plain HTTP
curl -X POST https://redis.yaqeen.me/db/scratch -d '["HSET","user:1","name","yaqeen"]'
curl -X POST https://redis.yaqeen.me/db/scratch -d '["HGETALL","user:1"]'
```

Any WebSocket client works. Send RESP frames, or just plain text:

```
SET foo "hello world"
GET foo
RPUSH q a b c
LRANGE q 0 -1
```

## Interfaces

| | How | Notes |
|---|---|---|
| WebSocket | `wss://host/db/<ns>` | RESP2 or inline commands. Pipelining supported. Protocol errors close the socket with 1002. |
| HTTP | `POST /db/<ns>` body `["GET","k"]` | Returns `{"result": ...}` or `{"error": "..."}` (400). |
| RPC | `env.LIL_REDIS.getByName(ns).exec(["GET","k"])` | From another Worker. Throws on Redis errors. |

Namespace: `[A-Za-z0-9_.:-]{1,128}`.

## Commands

**Connection** `PING ECHO QUIT SELECT CLIENT COMMAND INFO`
**Keyspace** `DEL UNLINK EXISTS TYPE KEYS DBSIZE FLUSHDB FLUSHALL RENAME RENAMENX`
**Expiry** `EXPIRE PEXPIRE EXPIREAT PEXPIREAT PERSIST TTL PTTL`
**Strings** `GET SET (EX PX EXAT PXAT KEEPTTL NX XX GET) SETNX SETEX PSETEX GETSET GETDEL MGET MSET MSETNX INCR DECR INCRBY DECRBY INCRBYFLOAT APPEND STRLEN`
**Hashes** `HSET HMSET HSETNX HGET HMGET HGETALL HKEYS HVALS HDEL HEXISTS HLEN HINCRBY`
**Lists** `LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP (count) LLEN LRANGE LINDEX LSET LTRIM`
**Sets** `SADD SREM SMEMBERS SISMEMBER SMISMEMBER SCARD SINTER SUNION SDIFF`

## How it works

```
src/
  resp.ts        streaming RESP2 parser + encoder
  store.ts       SQLite schema + all data-structure ops
  commands.ts    command table: arity checks, arg parsing, dispatch
  lil-redis.ts   the Durable Object: WS hibernation, HTTP, RPC, alarm
  index.ts       Worker entry: /db/:ns -> DO stub
```

Storage is four tables: `keys` (type, string value, expiry), `hashes`, `sets`, `lists`. Lists use a signed integer `pos` column — `LPUSH` decrements the head, `RPUSH` increments the tail, so order is just `ORDER BY pos`.

Every command runs inside `ctx.storage.transactionSync()`. After any command that can touch a TTL, the DO recomputes `MIN(expires_at)` and sets its one alarm to that instant; the alarm handler sweeps expired rows and reschedules itself.

## Develop

```sh
pnpm install
pnpm dev          # http://localhost:8787
pnpm cli          # REPL against localhost /db/default
pnpm test         # vitest + workerd, 34 tests
pnpm typecheck
pnpm deploy
```

## License

MIT
