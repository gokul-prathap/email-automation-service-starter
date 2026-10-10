import { connectMongo, closeMongo } from "./db.js";
import { env } from "./config.js";
import { Redis } from "ioredis";
import { gmailClient } from "./gmail.js";
import { CampaignStore } from "./campaigns.js";
import { MailboxGate } from "./mailbox-gate.js";
import { reconcileRecipient } from "./reconciliation.js";
const recipientId = process.argv[2];
if (!recipientId) throw new Error("Usage: npm run reconcile -- RECIPIENT_ID [--confirm-quiesced]");
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
try {
  const store = new CampaignStore(await connectMongo());
  const gate = new MailboxGate(redis, env.MAILBOX_SEND_INTERVAL_MS, env.MAILBOX_PREPARE_LEASE_MS);
  const result = await reconcileRecipient(store, gate, async (mailbox, messageId) => {
    const client = gmailClient(mailbox.encryptedRefreshToken);
    const found = await client.users.messages.list({ userId: "me", q: `in:sent rfc822msgid:${messageId.replace(/[<>]/g, "")}`, maxResults: 2 });
    return (found.data.messages ?? []).filter(m => m.id).map(m => ({ id: m.id!, threadId: m.threadId }));
  }, recipientId, process.argv.includes("--confirm-quiesced"));
  console.log(JSON.stringify(result));
} catch {
  console.error("Reconciliation failed; inspect recipient state and mailbox access. No automatic resend was requested.");
  process.exitCode = 1;
} finally { await redis.quit(); await closeMongo(); }
