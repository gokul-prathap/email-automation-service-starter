import "dotenv/config";
import { z } from "zod";
const positive = z.coerce.number().int().positive();
export const env = z.object({
  NODE_ENV: z.string().default("development"), PORT: positive.default(3001),
  PUBLIC_BASE_URL: z.string().url(), MONGODB_URI: z.string(), MONGODB_DB: z.string(), REDIS_URL: z.string(),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  GOOGLE_CLIENT_ID: z.string(), GOOGLE_CLIENT_SECRET: z.string(), GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_PUBSUB_TOPIC: z.string(), CORS_ORIGIN: z.string().default("http://localhost:3000"),
  MAILBOX_SEND_INTERVAL_MS: positive.default(5000), MAILBOX_PREPARE_LEASE_MS: positive.default(30000),
  GMAIL_SEND_TIMEOUT_MS: positive.default(20000), SEND_MAX_ATTEMPTS: positive.max(20).default(5),
  SEND_BACKOFF_MS: positive.default(1000), SEND_WORKER_CONCURRENCY: positive.default(5),
  SEND_RECOVERY_INTERVAL_MS: positive.default(15000), SEND_DEFER_MS: positive.default(1000),
}).parse(process.env);
export const sendSettings = { attempts: env.SEND_MAX_ATTEMPTS, backoff: env.SEND_BACKOFF_MS,
  lease: env.MAILBOX_PREPARE_LEASE_MS, timeout: env.GMAIL_SEND_TIMEOUT_MS, poll: env.SEND_DEFER_MS };
