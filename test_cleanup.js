// Run with: node --test test_cleanup.js (no real Telegram/KV access).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/worker.js", "utf8")
  .replace("export default", "module.__fetch_handler =");

function setup(entries = {}, respond = () => ({ ok: true, result: true })) {
  let now = 100000;
  class Clock extends Date { static now() { return now; } }
  const data = new Map(Object.entries(entries).map(([k, v]) =>
    [k, typeof v === "object" ? JSON.stringify(v) : v]));
  const calls = [], tasks = [], writes = [], pages = [];
  const env = {
    SUPERGROUP_ID: "-100123", BOT_TOKEN: "test", ADMIN_IDS: "7,8",
    TOPIC_MAP: {
      async get(key, options) {
        const value = data.get(key) ?? null;
        return options?.type === "json" && value !== null ? JSON.parse(value) : value;
      },
      async put(key, value, options) {
        writes.push({ key, options, now }); data.set(key, value);
      },
      async delete(key) { data.delete(key); },
      async list({ prefix, cursor, limit = 2 }) {
        // Lexical cursors remain valid while earlier keys are deleted.
        const keys = [...data.keys()].filter(k => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
        const page = keys.slice(0, Math.min(limit, 2));
        pages.push({ prefix, cursor });
        return { keys: page.map(name => ({ name })), list_complete: keys.length <= page.length,
          cursor: keys.length > page.length ? page.at(-1) : undefined };
      },
    },
  };
  const sandbox = {
    console: { log() {}, error() {}, warn() {} }, module: { exports: {} },
    Date: Clock, crypto: require("node:crypto").webcrypto,
    URL, AbortController, TextEncoder, URLSearchParams, FormData,
    setTimeout(callback, ms) { now += ms; callback(); return 1; }, clearTimeout() {},
    fetch: async () => { throw new Error("No real network allowed"); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + `
    tgCall = async (env, method, body) => __api(method, body);
    module.exports = { handleAdminReply, handleCleanupAllCommand, handleCleanupCommand,
      resetUserVerificationAndRequireReverify, threadHealthCache, getOrCreateUserTopicRec };
  `, sandbox);
  sandbox.__api = async (method, body) => {
    calls.push({ method, body });
    if (method === "getMe") return { ok: true, result: { username: "TestBot" } };
    if (method === "getChatMember") return { ok: true, result: { status: "member" } };
    return respond(method, body, data);
  };
  const api = sandbox.module.exports;
  const command = (text, sender = 7, thread = 22) => api.handleAdminReply({
    text, from: { id: sender }, message_thread_id: thread,
  }, env, { waitUntil(promise) { tasks.push(promise); } });
  const drain = async () => { while (tasks.length) await tasks.shift(); };
  const confirmation = () => JSON.parse(data.get("cleanup:confirm:7"));
  return { api, env, data, calls, writes, pages, command, drain, confirmation,
    advance(ms) { now += ms; },
    deletes() { return calls.filter(c => c.method === "deleteForumTopic").map(c => c.body.message_thread_id); },
  };
}

async function finish(s) {
  await s.drain();
  for (let i = 0; s.data.has("cleanupall:job"); i++) {
    assert.ok(i < 30, "cleanup must eventually finish");
    const job = JSON.parse(s.data.get("cleanupall:job"));
    await s.command(`/cleanupall continue ${job.token}`, job.owner);
    await s.drain();
  }
}

test("non-admin and commands addressed to another bot cannot request or execute cleanup", async () => {
  const s = setup();
  await s.command("/cleanupall", 99);
  assert.equal(s.data.has("cleanup:confirm:99"), false);
  await s.command("/cleanupall@OtherBot");
  assert.equal(s.data.has("cleanup:confirm:7"), false);
  await s.command("/cleanupall@TestBot");
  const { token } = s.confirmation();
  await s.command(`/cleanupall@OtherBot confirm ${token}`);
  await s.drain();
  assert.deepEqual(s.deletes(), []);
  assert.ok(s.data.has("cleanup:confirm:7"));
});

test("confirmation is required, bound to sender, expires, and is single-use", async () => {
  const s = setup();
  await s.command("/cleanupall confirm bogus");
  await s.command("/cleanupall");
  const { token } = s.confirmation();
  assert.equal(s.writes.find(w => w.key === "cleanup:confirm:7").options.expirationTtl, 60);
  await s.command(`/cleanupall confirm ${token}`, 8);
  await s.command("/cleanupall confirm wrong");
  assert.deepEqual(s.deletes(), []);
  s.advance(61000);
  await s.command(`/cleanupall confirm ${token}`);
  assert.equal(s.data.has("cleanupall:job"), false);
  await s.command("/cleanupall");
  await s.command(`/cleanupall confirm ${s.confirmation().token}`);
  await finish(s);
  assert.equal(s.data.has("cleanup:confirm:7"), false);
  const count = s.calls.length;
  await s.command(`/cleanupall confirm ${token}`);
  assert.match(s.calls.at(-1).body.text, /确认无效/);
  assert.equal(s.calls.length, count + 1);
});

test("deletes paginated user, orphan reverse-map and anomaly topics; preserves General and security state", async () => {
  const s = setup({
    "user:10": { thread_id: 22 }, "thread:22": "10", "verified:10": "trusted",
    "user:11": { thread_id: "23" }, "thread:23": "11", "verified:11": "1",
    "user:12": { thread_id: 1 }, "thread:1": "12", "banned:10": "1",
    "user:13": { thread_id: -5 }, "user:12345678": { title: "no topic" },
    "thread:25": "14", "anomaly_topic": { thread_id: 24 },
    "strikes:10": "2", "unrelated": "keep",
  });
  s.api.threadHealthCache.set(22, { ts: 1 });
  await s.command("/cleanupall");
  assert.deepEqual(s.deletes(), []);
  await s.command(`/cleanupall@TestBot confirm ${s.confirmation().token}`);
  await finish(s);
  assert.deepEqual([...new Set(s.deletes())].sort(), [22, 23, 24, 25]);
  for (const key of ["user:10", "user:11", "thread:22", "thread:23", "thread:25", "anomaly_topic", "cleanup:lock"])
    assert.equal(s.data.has(key), false, key);
  for (const key of ["user:12", "thread:1", "user:13", "user:12345678"])
    assert.ok(s.data.has(key), key);
  assert.equal(s.data.get("verified:10"), "trusted");
  assert.equal(s.data.get("verified:11"), "1");
  assert.equal(s.data.get("banned:10"), "1");
  assert.equal(s.data.get("strikes:10"), "2");
  assert.equal(s.data.get("unrelated"), "keep");
  assert.equal(s.api.threadHealthCache.has(22), false);
  assert.ok(s.pages.some(p => p.cursor));
  assert.ok(s.calls.filter(c => c.method === "sendMessage").every(c => c.body.message_thread_id === undefined));
  assert.match(s.calls.at(-1).body.text, /强制清理完成/);
  const saves = s.writes.filter(w => w.key === "cleanupall:job");
  for (let i = 1; i < saves.length; i++) assert.ok(saves[i].now - saves[i - 1].now >= 1000);
});

test("permission, rate-limit and timeout failures keep records; missing topics remove stale mappings", async () => {
  const responses = {
    22: { ok: false, description: "Bad Request: TOPIC_ID_INVALID" },
    23: { ok: false, description: "Bad Request: not enough rights" },
    24: { ok: false, description: "Too Many Requests: retry after 5" },
    25: { ok: false, description: "Request timeout" },
  };
  const s = setup(Object.fromEntries([22, 23, 24, 25].flatMap(id => [
    [`user:${id}`, { thread_id: id }], [`thread:${id}`, String(id)],
  ])), (method, body) => method === "deleteForumTopic" ? responses[body.message_thread_id] : { ok: true });
  await s.api.handleCleanupAllCommand(s.env, 7, "token");
  await finish(s);
  assert.equal(s.data.has("user:22"), false);
  assert.equal(s.data.has("thread:22"), false);
  for (const id of [23, 24, 25]) {
    assert.ok(s.data.has(`user:${id}`));
    assert.ok(s.data.has(`thread:${id}`));
  }
  assert.match(s.calls.at(-1).body.text, /部分失败/);
  assert.equal(s.data.has("cleanup:lock"), false);
});

test("large cleanups checkpoint, authenticate continuation, and finish across batches", async () => {
  const s = setup(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`user:${i}`, { thread_id: i + 30 }])));
  await s.command("/cleanupall");
  const { token } = s.confirmation();
  await s.command(`/cleanupall confirm ${token}`);
  await s.drain();
  assert.ok(s.data.has("cleanupall:job"));
  const count = s.deletes().length;
  assert.ok(count > 0 && count < 30);
  await s.command(`/cleanupall continue ${token}`, 8);
  await s.drain();
  assert.equal(s.deletes().length, count);
  await s.command("/cleanupall");
  assert.match(s.calls.at(-1).body.text, /continue/);
  await finish(s);
  assert.equal(new Set(s.deletes()).size, 30);
  assert.equal(s.data.has("cleanup:lock"), false);
});

test("shared cleanup lock prevents either cleanup command from starting", async () => {
  const s = setup({ "cleanup:lock": "1", "user:10": { thread_id: 22 } });
  await s.api.handleCleanupAllCommand(s.env, 7, "token");
  await s.api.handleCleanupCommand(1, s.env);
  assert.deepEqual(s.deletes(), []);
  assert.equal(s.data.get("cleanup:lock"), "1");
  assert.equal(s.data.has("cleanupall:job"), false);
});

test("checkpoint survives KV failure and cleanup can be resumed", async () => {
  const s = setup({ "user:10": { thread_id: 22 }, "thread:22": "10" });
  const originalPut = s.env.TOPIC_MAP.put;
  let saves = 0;
  s.env.TOPIC_MAP.put = async (key, ...args) => {
    if (key === "cleanupall:job" && ++saves === 3) throw new Error("KV unavailable");
    return originalPut(key, ...args);
  };
  await s.api.handleCleanupAllCommand(s.env, 7, "resume");
  assert.ok(s.data.has("cleanupall:job"));
  assert.equal(s.data.has("cleanup:lock"), false);
  await finish(s);
  assert.equal(s.data.has("user:10"), false);
  assert.equal(s.data.has("cleanup:lock"), false);
  assert.ok(s.deletes().includes(22));
});

test("deliberate cleanup does not invalidate trusted users through an in-flight health check", async () => {
  const s = setup({ "verified:10": "trusted", "cleanup:deleted:22": "1" });
  await s.api.resetUserVerificationAndRequireReverify(s.env, {
    userId: 10, userKey: "user:10", oldThreadId: 22, reason: "probe_missing",
  });
  assert.equal(s.data.get("verified:10"), "trusted");
  assert.equal(s.data.has("needs_verify:10"), false);
});
test("legacy /cleanup remains non-destructive and preserves trust for intentionally deleted topics", async () => {
  const s = setup({
    "user:10": { thread_id: 22 }, "thread:22": "10", "verified:10": "trusted",
    "cleanup:deleted:22": "1",
  }, (method) => method === "sendMessage"
    ? { ok: false, description: "Bad Request: message thread not found" } : { ok: true });
  await s.api.handleCleanupCommand(1, s.env);
  assert.deepEqual(s.deletes(), []);
  assert.equal(s.data.has("user:10"), false);
  assert.equal(s.data.get("verified:10"), "trusted");
  assert.equal(s.data.has("cleanup:lock"), false);
});


test("a cleaned user's next message can create a fresh topic without losing verification", async () => {
  const s = setup({ "verified:10": "trusted" }, (method) => method === "createForumTopic"
    ? { ok: true, result: { message_thread_id: 90 } } : { ok: true });
  const rec = await s.api.getOrCreateUserTopicRec({ first_name: "User" }, "user:10", s.env, 10);
  assert.equal(rec.thread_id, 90);
  assert.equal(s.data.get("thread:90"), "10");
  assert.equal(s.data.get("verified:10"), "trusted");
});
