import IORedis from "ioredis"; import {Queue} from "bullmq"; import {env} from "./config.js";
export const redis=new IORedis(env.REDIS_URL,{maxRetriesPerRequest:null});
export const sendQueue=new Queue("email-send",{connection:redis}); export const replyQueue=new Queue("gmail-reply-sync",{connection:redis}); export const watchQueue=new Queue("gmail-watch",{connection:redis});
