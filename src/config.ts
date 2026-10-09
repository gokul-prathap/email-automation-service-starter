import "dotenv/config";
import { z } from "zod";
export const env=z.object({NODE_ENV:z.string().default("development"),PORT:z.coerce.number().default(3001),PUBLIC_BASE_URL:z.string().url(),MONGODB_URI:z.string(),MONGODB_DB:z.string(),REDIS_URL:z.string(),TOKEN_ENCRYPTION_KEY:z.string().regex(/^[0-9a-fA-F]{64}$/),GOOGLE_CLIENT_ID:z.string(),GOOGLE_CLIENT_SECRET:z.string(),GOOGLE_REDIRECT_URI:z.string().url(),GOOGLE_PUBSUB_TOPIC:z.string(),CORS_ORIGIN:z.string().default("http://localhost:3000"),MAILBOX_SEND_INTERVAL_MS:z.coerce.number().default(5000)}).parse(process.env);
