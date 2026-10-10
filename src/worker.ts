import { Worker } from "bullmq";
import { ObjectId } from "mongodb";
import { CampaignStore } from "./campaigns.js";
import { MailboxGate } from "./mailbox-gate.js";
import { createSendProcessor, recoverAndEnqueue, restoreMailboxGates } from "./send-processor.js";
import { connectMongo, getDb, closeMongo } from "./db.js";
import { redis, sendQueue, replyQueue, watchQueue } from "./queues.js";
import { prepareSend, history, message, watch } from "./gmail.js";
import { env, sendSettings } from "./config.js";

await connectMongo();
const store = new CampaignStore(getDb());
const gate = new MailboxGate(redis, env.MAILBOX_SEND_INTERVAL_MS, env.MAILBOX_PREPARE_LEASE_MS);
await restoreMailboxGates(store, gate);
const sendWorker = new Worker("email-send", createSendProcessor(store, gate,
  async (m, r, messageId) => prepareSend(m.encryptedRefreshToken,
    { from: m.email, to: r.email, subject: r.subject, html: r.html, messageId }), sendSettings),
{ connection: redis, concurrency: env.SEND_WORKER_CONCURRENCY, autorun: false });

let recovering = false;
async function recover() {
  if (recovering) return;
  recovering = true;
  try { await recoverAndEnqueue(store, gate, sendQueue, sendSettings); }
  catch { console.error("Send recovery failed; will retry next scan"); }
  finally { recovering = false; }
}
sendWorker.on("error", () => console.error("Send worker infrastructure error"));
await recover();
void sendWorker.run().catch(() => console.error("Send worker stopped unexpectedly"));
const recoveryTimer = setInterval(() => { void recover(); }, env.SEND_RECOVERY_INTERVAL_MS);

const replyWorker = new Worker("gmail-reply-sync", async job => {
  const db = getDb();
  const mailbox = await db.collection("mailboxes").findOne({ _id: new ObjectId(job.data.mailboxId), status: "CONNECTED" });
  if (!mailbox) return;
  for (const item of await history(mailbox.encryptedRefreshToken, String(job.data.historyId))) {
    if (!item.id) continue;
    const msg = await message(mailbox.encryptedRefreshToken, item.id);
    const headers = new Map((msg.payload?.headers ?? []).map(h => [String(h.name).toLowerCase(), String(h.value)]));
    const inReplyTo = headers.get("in-reply-to") ?? "";
    const refs = (headers.get("references") ?? "").split(/\s+/).filter(Boolean);
    const recipient = await db.collection("campaignRecipients").findOne({ mailboxId: mailbox._id.toString(),
      $or: [{ messageId: inReplyTo }, { messageId: { $in: refs } }] });
    const from = headers.get("from") ?? "";
    if (recipient && !from.toLowerCase().includes(mailbox.email.toLowerCase())) {
      // Reply tracking is independent of successful submission and campaign completion.
      await db.collection("campaignRecipients").updateOne({ _id: recipient._id, status: "SENT" },
        { $set: { replied: true, repliedAt: new Date(), replyMessageId: item.id } });
    }
  }
  await db.collection("mailboxes").updateOne({ _id: mailbox._id }, { $set: { lastHistoryId: String(job.data.historyId) } });
}, { connection: redis, concurrency: 2 });
const watchWorker = new Worker("gmail-watch", async job => {
  const mailbox = await getDb().collection("mailboxes").findOne({ _id: new ObjectId(job.data.mailboxId), status: "CONNECTED" });
  if (!mailbox) return;
  const result = await watch(mailbox.encryptedRefreshToken);
  await getDb().collection("mailboxes").updateOne({ _id: mailbox._id }, { $set: {
    watchExpiration: result.expiration ? new Date(Number(result.expiration)) : null, lastHistoryId: result.historyId,
  } });
}, { connection: redis, concurrency: 1 });
for (const worker of [replyWorker, watchWorker]) worker.on("error", () => console.error("Worker infrastructure error"));

const watchTimer = setInterval(() => {
  void (async () => {
    for await (const mailbox of getDb().collection("mailboxes").find({ status: "CONNECTED" })) {
      if (!mailbox.watchExpiration || mailbox.watchExpiration.getTime() - Date.now() < 86400000) {
        await watchQueue.add("watch", { mailboxId: mailbox._id.toString() },
          { jobId: `renew-${mailbox._id}-${Math.floor(Date.now() / 3600000)}`, removeOnComplete: true });
      }
    }
  })().catch(() => console.error("Watch renewal failed"));
}, 6 * 3600000);

console.log("Workers running");
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(recoveryTimer); clearInterval(watchTimer);
  await Promise.all([sendWorker.close(), replyWorker.close(), watchWorker.close()]);
  while (recovering) await new Promise(resolve => setTimeout(resolve, 50));
  await Promise.all([sendQueue.close(), replyQueue.close(), watchQueue.close()]);
  await redis.quit(); await closeMongo();
}
process.on("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
process.on("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
