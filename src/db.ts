import {MongoClient,Db} from "mongodb"; import {env} from "./config.js";
let db:Db; let client:MongoClient;
export async function connectMongo(){if(db)return db; client=new MongoClient(env.MONGODB_URI); await client.connect(); db=client.db(env.MONGODB_DB); await Promise.all([db.collection("mailboxes").createIndex({tenantId:1,email:1},{unique:true}),db.collection("campaignRecipients").createIndex({campaignId:1,email:1},{unique:true}),db.collection("campaignRecipients").createIndex({status:1,scheduledAt:1}),db.collection("oauthStates").createIndex({expiresAt:1},{expireAfterSeconds:0})]); return db;}
export function getDb(){if(!db)throw Error("MongoDB not connected");return db;}
export async function closeMongo(){await client?.close();}
