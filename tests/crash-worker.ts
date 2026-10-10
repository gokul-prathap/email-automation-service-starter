import { MongoClient } from "mongodb";
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { CampaignStore } from "../src/campaigns.js";
import { MailboxGate } from "../src/mailbox-gate.js";
import { createSendProcessor } from "../src/send-processor.js";
const client = await MongoClient.connect(process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017");
const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
const store = new CampaignStore(client.db(process.env.TEST_DB));
const gate = new MailboxGate(redis, 100, 100, process.env.TEST_GATE);
new Worker(process.env.TEST_QUEUE!, createSendProcessor(store, gate, async () => async () => {
  console.log("SUBMISSION_STARTED");
  return new Promise(() => {}); // A killed process never records a Gmail response.
}, { attempts: 3, backoff: 50, lease: 100, timeout: 100, poll: 100 }),
{ connection: redis, prefix: process.env.TEST_PREFIX, lockDuration: 500, stalledInterval: 500 });
