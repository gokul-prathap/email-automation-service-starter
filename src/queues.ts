import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { env } from "./config.js";
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const sendQueue = new Queue("email-send", { connection: redis, defaultJobOptions: {
  attempts: env.SEND_MAX_ATTEMPTS, backoff: { type: "exponential", delay: env.SEND_BACKOFF_MS },
  removeOnComplete: 1000, removeOnFail: 1000,
} });
export const replyQueue = new Queue("gmail-reply-sync", { connection: redis });
export const watchQueue = new Queue("gmail-watch", { connection: redis });
