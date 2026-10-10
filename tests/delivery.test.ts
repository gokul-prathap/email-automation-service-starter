import {reconcileRecipient} from "../src/reconciliation.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify from "fastify";
import { MongoClient, ObjectId, type Document } from "mongodb";
import { Redis } from "ioredis";
import { Queue, Worker } from "bullmq";
import { CampaignStore, initialDelivery } from "../src/campaigns.js";
import { registerCampaignRoutes } from "../src/campaign-routes.js";
import { MailboxGate } from "../src/mailbox-gate.js";
import { classifyFailure } from "../src/send-errors.js";
import { createSendProcessor, recoverAndEnqueue, restoreMailboxGates, enqueueRecipient, type PrepareSend } from "../src/send-processor.js";

const settings = { attempts: 3, backoff: 40, lease: 500, timeout: 200, poll: 80 };
const terminal = ["COMPLETED", "FAILED", "PARTIALLY_FAILED"];
async function until(check: () => Promise<boolean>, timeout = 12000) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for test condition");
    await sleep(20);
  }
}

async function fixture(prepare: PrepareSend, interval = 80) {
  const suffix = crypto.randomBytes(8).toString("hex");
  const dbName = `email_automation_test_${suffix}`;
  const client = await MongoClient.connect(process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017");
  const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  const db = client.db(dbName), store = new CampaignStore(db);
  const prefix = `test-${suffix}`, name = "email-send", gatePrefix = `test-gate-${suffix}`;
  const queue = new Queue(name, { connection: redis, prefix });
  const gate = new MailboxGate(redis, interval, settings.lease, gatePrefix, settings.poll);
  const workers: Worker[] = [];
  const app = Fastify();
  app.setErrorHandler((error, _req, rep) => rep.code(400).send({ error: "Invalid request" }));
  registerCampaignRoutes(app, store, queue, settings);
  async function mailbox() {
    const _id = new ObjectId();
    await db.collection("mailboxes").insertOne({ _id, tenantId: "test", email: `${_id}@example.com`,
      status: "CONNECTED", encryptedRefreshToken: "NEVER_USED_BY_MOCK" });
    return _id.toString();
  }
  async function campaign(mailboxId: string, count = 1) {
    const response = await app.inject({ method: "POST", url: "/campaigns", payload: { tenantId: "test", mailboxId,
      subject: "Mock only", html: "<p>Mock</p>", recipients: Array.from({ length: count }, (_, i) => ({ email: `user${i}@example.com` })) } });
    assert.equal(response.statusCode, 202, response.body);
    return response.json().campaignId as string;
  }
  function start(count = 2) {
    for (let i = 0; i < count; i++) {
      // Separate Redis connections exercise coordination across worker instances.
      const connection = new Redis(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
      const w = new Worker(name, createSendProcessor(store,
        new MailboxGate(connection, interval, settings.lease, gatePrefix, settings.poll), prepare, settings),
      { connection, prefix, concurrency: 4, stalledInterval: 500, lockDuration: 1000 });
      w.on("error", () => {});
      workers.push(w);
      connections.push(connection);
    }
  }
  const connections: Redis[] = [];
  async function done(id: string) { await until(async () => terminal.includes((await store.ensure(id))!.status)); return store.view(id); }
  async function close() {
    await Promise.all(workers.map(w => w.close()));
    await Promise.all(connections.map(c => c.quit()));
    await app.close(); await queue.obliterate({ force: true }); await queue.close();
    const keys = await redis.keys(`${gatePrefix}:*`);
    if (keys.length) await redis.del(...keys);
    // Only this test's random, explicitly prefixed database can be removed.
    assert.ok(dbName.startsWith("email_automation_test_"));
    await db.dropDatabase(); await redis.quit(); await client.close();
  }
  return { store, gate, queue, app, db, dbName, prefix, name, gatePrefix, mailbox, campaign, start, done, close };
}
const success: PrepareSend = async (_m, _r, id) => async () => ({ id, threadId: "mock-thread" });

test("one successful email and API counts", async () => {
  const f = await fixture(success);
  try {
    const id = await f.campaign(await f.mailbox()); f.start();
    const view = (await f.done(id))!;
    assert.equal(view.campaign.status, "COMPLETED");
    assert.deepEqual(view.counts, { total: 1, queued: 0, sending: 0, sent: 1, failed: 0, unknown: 0 });
    assert.equal(view.recipients[0].history.length, 1);
    const response = await f.app.inject(`/campaigns/${id}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().counts.sent, 1);
    assert.ok(!response.body.includes("NEVER_USED_BY_MOCK"));
  } finally { await f.close(); }
});

test("five recipients and two campaigns share a mailbox without overlapping or exceeding pacing", async () => {
  const starts: number[] = [];
  let active = 0, maxActive = 0;
  const f = await fixture(async () => async () => {
    starts.push(Date.now()); maxActive = Math.max(maxActive, ++active); await sleep(35); active--;
    return { id: crypto.randomUUID() };
  }, 100);
  try {
    const mailbox = await f.mailbox();
    const a = await f.campaign(mailbox, 5), b = await f.campaign(mailbox, 2); f.start();
    const views = await Promise.all([f.done(a), f.done(b)]);
    assert.equal(views[0]!.counts.sent, 5); assert.equal(views[1]!.counts.sent, 2);
    assert.equal(maxActive, 1); assert.equal(starts.length, 7);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 100, String(starts));
  } finally { await f.close(); }
});

test("different mailboxes send concurrently", async () => {
  let active = 0, maxActive = 0;
  const f = await fixture(async () => async () => {
    maxActive = Math.max(maxActive, ++active); await sleep(200); active--; return { id: crypto.randomUUID() };
  });
  try {
    const a = await f.campaign(await f.mailbox()), b = await f.campaign(await f.mailbox()); f.start();
    await Promise.all([f.done(a), f.done(b)]); assert.equal(maxActive, 2);
  } finally { await f.close(); }
});

test("pre-send failure retries with stable message ID and succeeds", async () => {
  let calls = 0, sends = 0; const ids: string[] = [];
  const f = await fixture(async (_m, _r, id) => {
    ids.push(id); if (++calls < 3) throw new Error("Mock preparation failure");
    return async () => { sends++; return { id: "accepted" }; };
  });
  try {
    const id = await f.campaign(await f.mailbox()); f.start(); const v = (await f.done(id))!;
    assert.equal(calls, 3); assert.equal(sends, 1); assert.equal(new Set(ids).size, 1);
    assert.equal(v.recipients[0].attempts, 3);
    assert.deepEqual(v.recipients[0].history.map((h: Document) => h.status), ["RETRY", "RETRY", "SENT"]);
  } finally { await f.close(); }
});

test("retry exhaustion is a terminal failure", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; throw new Error("Mock preparation failure"); });
  try {
    const id = await f.campaign(await f.mailbox()); f.start(); const v = (await f.done(id))!;
    assert.equal(calls, 3); assert.equal(v.campaign.status, "FAILED"); assert.equal(v.counts.failed, 1);
  } finally { await f.close(); }
});

test("explicit Gmail rate rejection honors Retry-After across workers", async () => {
  const starts: number[] = [];
  const f = await fixture(async () => async () => {
    starts.push(Date.now());
    if (starts.length === 1) throw { response: { status: 429, headers: { "retry-after": "1" } } };
    return { id: "accepted" };
  });
  try {
    const id = await f.campaign(await f.mailbox()); f.start(); await f.done(id);
    assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 1000);
  } finally { await f.close(); }
});

test("ambiguous Gmail response stays UNKNOWN and never automatically resends", async () => {
  let calls = 0;
  const f = await fixture(async () => async () => { calls++; throw new Error("Mock connection reset after acceptance"); });
  try {
    const mailbox = await f.mailbox(), id = await f.campaign(mailbox); f.start();
    const v = (await f.done(id))!; await sleep(300);
    assert.equal(v.counts.unknown, 1); assert.equal(v.counts.sent, 0); assert.equal(calls, 1);
    assert.equal(v.campaign.status, "PARTIALLY_FAILED");
    assert.equal((await f.gate.inspect(mailbox)).phase, "uncertain");
    await recoverAndEnqueue(f.store, f.gate, f.queue, settings); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("pause prevents admissions, resume processes remaining recipients", async () => {
  let sends = 0;
  const f = await fixture(async () => async () => { sends++; return { id: crypto.randomUUID() }; });
  try {
    const id = await f.campaign(await f.mailbox(), 5);
    assert.equal((await f.app.inject({ method: "POST", url: `/campaigns/${id}/pause` })).statusCode, 200);
    f.start(); await sleep(300); assert.equal(sends, 0);
    assert.equal((await f.store.view(id))!.counts.queued, 5);
    assert.equal((await f.app.inject({ method: "POST", url: `/campaigns/${id}/resume` })).statusCode, 200);
    const v = (await f.done(id))!; assert.equal(sends, 5); assert.equal(v.campaign.status, "COMPLETED");
  } finally { await f.close(); }
});

test("pause racing an admitted send permits that send and preserves SENT", async () => {
  let release!: () => void, sends = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => async () => { sends++; await blocked; return { id: "accepted" }; });
  try {
    const id = await f.campaign(await f.mailbox(), 2); f.start();
    await until(async () => sends === 1);
    await f.store.pause(id); release();
    await until(async () => (await f.store.view(id))!.counts.sent === 1);
    await sleep(200); assert.equal(sends, 1);
    const v = (await f.store.view(id))!; assert.equal(v.campaign.status, "PAUSED"); assert.equal(v.counts.queued, 1);
    await f.store.resume(id); await f.done(id); assert.equal(sends, 2);
  } finally { release(); await f.close(); }
});

test("mixed success and explicit permanent rejection is PARTIALLY_FAILED", async () => {
  const f = await fixture(async (_m, r) => async () => {
    if (r.email === "user1@example.com") throw { response: { status: 400 } };
    return { id: "accepted" };
  });
  try {
    const id = await f.campaign(await f.mailbox(), 2); f.start(); const v = (await f.done(id))!;
    assert.equal(v.campaign.status, "PARTIALLY_FAILED"); assert.equal(v.counts.sent, 1); assert.equal(v.counts.failed, 1);
  } finally { await f.close(); }
});

test("expired preparation lease cannot submit or release a new owner's lock", async () => {
  const f = await fixture(success);
  try {
    const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379");
    try {
      const gate = new MailboxGate(redis, 10, 80, f.gatePrefix);
      const id = await f.mailbox(); assert.equal(await gate.acquire(id, "old"), 0);
      await sleep(100); assert.equal(await gate.acquire(id, "new"), 0);
      assert.equal(await gate.begin(id, "old"), false); assert.equal(await gate.release(id, "old"), false);
      assert.equal((await gate.inspect(id)).owner, "new");
      assert.equal(await gate.begin(id, "new"), true); await sleep(100);
      assert.ok(await gate.acquire(id, "third") > 0); // Submission never expires.
      assert.equal(await gate.release(id, "new"), true);
    } finally { await redis.quit(); }
  } finally { await f.close(); }
});

test("restart recovers stale preparation safely", async () => {
  const f = await fixture(success);
  try {
    const id = await f.campaign(await f.mailbox());
    const r = (await f.store.view(id))!.recipients[0];
    await f.store.claim(id, r._id.toString(), "dead-worker", settings.attempts);
    await f.store.change(id, r._id.toString(), { attemptId: "dead-worker" }, { startedAt: new Date(0) });
    await recoverAndEnqueue(new CampaignStore(f.db), f.gate, f.queue, settings);
    assert.equal((await f.store.view(id))!.recipients[0].status, "RETRY");
    f.start(); const v = (await f.done(id))!; assert.equal(v.counts.sent, 1); assert.equal(v.recipients[0].attempts, 2);
  } finally { await f.close(); }
});

test("actual worker process death during submission becomes UNKNOWN on restart", async () => {
  const f = await fixture(success);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const mailbox = await f.mailbox(), id = await f.campaign(mailbox);
    child = spawn(process.execPath, ["--import", "tsx", "tests/crash-worker.ts"], { cwd: process.cwd(),
      env: { ...process.env, TEST_DB: f.dbName, TEST_QUEUE: f.name, TEST_PREFIX: f.prefix, TEST_GATE: f.gatePrefix },
      stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout!.on("data", chunk => { output += chunk; });
    child.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => output.includes("SUBMISSION_STARTED"));
    child.kill("SIGKILL"); await new Promise<void>(resolve => child!.once("exit", () => resolve()));
    await sleep(250);
    await recoverAndEnqueue(new CampaignStore(f.db), f.gate, f.queue, { ...settings, lease: 100, timeout: 100 });
    const v = (await f.store.view(id))!;
    assert.equal(v.recipients[0].status, "UNKNOWN"); assert.equal(v.campaign.status, "PARTIALLY_FAILED");
    assert.equal((await f.gate.inspect(mailbox)).phase, "uncertain");
  } finally { child?.kill("SIGKILL"); await f.close(); }
});

test("legacy REPLIED stays successfully delivered; legacy SENDING is uncertain", async () => {
  const f = await fixture(success);
  try {
    const _id = new ObjectId(), recipientId = new ObjectId();
    await f.db.collection("campaigns").insertOne({ _id, status: "SCHEDULED" });
    await f.db.collection("campaignRecipients").insertOne({ _id: recipientId, campaignId: _id.toString(), status: "REPLIED", attempts: 1 });
    assert.equal((await f.store.view(_id.toString()))!.campaign.status, "COMPLETED");
    const other = new ObjectId();
    await f.db.collection("campaigns").insertOne({ _id: other, status: "SCHEDULED" });
    await f.db.collection("campaignRecipients").insertOne({ campaignId: other.toString(), status: "SENDING", attempts: 1 });
    assert.equal((await f.store.view(other.toString()))!.counts.unknown, 1);
  } finally { await f.close(); }
});

test("error details are sanitized and Retry-After supports dates", () => {
  const e = { message: "secret", config: { headers: { authorization: "secret" } }, response: {
    status: 429, headers: { "retry-after": new Date(3000).toUTCString() }, data: { error: { errors: [] } } } };
  const error = classifyFailure(e, true, 1000);
  assert.equal(error.retryAfterMs, 2000); assert.equal(error.retryable, true);
  assert.ok(!JSON.stringify(error).includes("secret"));
  assert.equal(classifyFailure({ response: { status: 503 } }, true).kind, "ambiguous");
});


test("startup restores legacy uncertainty quarantine and reconciliation never resends", async () => {
  const f = await fixture(success);
  try {
    const mailbox = await f.mailbox(), id = await f.campaign(mailbox);
    const recipient = (await f.store.view(id))!.recipients[0];
    const rid = recipient._id.toString();
    await f.store.change(id, rid, { status: "QUEUED" }, { status: "UNKNOWN", attempts: 1, attemptId: "dead-owner" });
    await restoreMailboxGates(f.store, f.gate);
    assert.equal((await f.gate.inspect(mailbox)).phase, "uncertain");
    const lookup = async () => [{ id: "gmail-match", threadId: "thread" }];
    const preview = await reconcileRecipient(f.store, f.gate, lookup, rid);
    assert.equal(preview.changed, false); assert.equal((await f.store.view(id))!.counts.unknown, 1);
    const result = await reconcileRecipient(f.store, f.gate, lookup, rid, true);
    assert.equal(result.status, "SENT"); assert.equal((await f.store.view(id))!.campaign.status, "COMPLETED");
    assert.deepEqual(await f.gate.inspect(mailbox), {});
  } finally { await f.close(); }
});

test("empty reconciliation result remains UNKNOWN after explicitly clearing quarantine", async () => {
  const f = await fixture(success);
  try {
    const mailbox = await f.mailbox(), id = await f.campaign(mailbox);
    const rid = (await f.store.view(id))!.recipients[0]._id.toString();
    await f.store.change(id, rid, { status: "QUEUED" }, { status: "UNKNOWN", attempts: 1, attemptId: "dead-owner" });
    await restoreMailboxGates(f.store, f.gate);
    const result = await reconcileRecipient(f.store, f.gate, async () => [], rid, true);
    assert.equal(result.status, "UNKNOWN");
    await restoreMailboxGates(f.store, f.gate); assert.deepEqual(await f.gate.inspect(mailbox), {});
    await recoverAndEnqueue(f.store, f.gate, f.queue, settings);
    assert.equal((await f.store.view(id))!.counts.unknown, 1);
  } finally { await f.close(); }
});

test("concurrent state transitions keep counts atomic and reject duplicate claims", async () => {
  const f = await fixture(success);
  try {
    const id = await f.campaign(await f.mailbox(), 5);
    const recipients = (await f.store.view(id))!.recipients;
    const rid = recipients[0]._id.toString();
    const duplicate = await Promise.all([f.store.claim(id, rid, "one", 3), f.store.claim(id, rid, "two", 3)]);
    assert.equal(duplicate.filter(Boolean).length, 1);
    const winner = duplicate.find(Boolean)!;
    await Promise.all(recipients.slice(1).map((r, i) => f.store.claim(id, r._id.toString(), `owner-${i}`, 3)));
    assert.equal((await f.store.view(id))!.counts.sending, 5);
    await Promise.all([
      f.store.finish(id, rid, winner.attemptId, { status: "SENT", gmailMessageId: "first" }),
      ...recipients.slice(1).map((r, i) => f.store.finish(id, r._id.toString(), `owner-${i}`, { status: "SENT", gmailMessageId: `id-${i}` })),
    ]);
    const view = (await f.store.view(id))!;
    assert.equal(view.campaign.status, "COMPLETED"); assert.equal(view.counts.sent, 5); assert.equal(view.counts.sending, 0);
  } finally { await f.close(); }
});

test("a crash between authoritative state and mirror writes does not corrupt API counts", async () => {
  const f = await fixture(success);
  try {
    const id = await f.campaign(await f.mailbox());
    const rid = (await f.store.view(id))!.recipients[0]._id.toString();
    const interrupted = new CampaignStore(f.db);
    interrupted.mirror = async () => { throw new Error("Simulated mirror write interruption"); };
    await assert.rejects(interrupted.change(id, rid, { status: "QUEUED" }, { status: "SENT", attempts: 1, gmailMessageId: "accepted" }));
    assert.equal((await f.store.view(id))!.counts.sent, 1);
    assert.equal((await f.store.view(id))!.recipients[0].status, "SENT");
    assert.equal((await f.db.collection("campaignRecipients").findOne({ _id: new ObjectId(rid) }))!.status, "QUEUED");
    await recoverAndEnqueue(f.store, f.gate, f.queue, settings);
    assert.equal((await f.db.collection("campaignRecipients").findOne({ _id: new ObjectId(rid) }))!.status, "SENT");
  } finally { await f.close(); }
});
