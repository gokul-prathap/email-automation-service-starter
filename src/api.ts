import {restoreMailboxGates} from "./send-processor.js";
import {CampaignStore} from "./campaigns.js"; import {registerCampaignRoutes} from "./campaign-routes.js"; import {MailboxGate} from "./mailbox-gate.js"; import {classifyFailure} from "./send-errors.js";
import Fastify from "fastify"; import cors from "@fastify/cors"; import crypto from "node:crypto"; import {ObjectId} from "mongodb"; import {z} from "zod"; import {connectMongo,getDb} from "./db.js"; import {env,sendSettings} from "./config.js"; import {encrypt} from "./crypto.js"; import {oauth,authUrl,profile,prepareSend,watch,SCOPES} from "./gmail.js"; import {redis,sendQueue,replyQueue,watchQueue} from "./queues.js";
const app=Fastify({logger:true}); await app.register(cors,{origin:env.CORS_ORIGIN});
app.get("/health",async()=>({ok:true,service:"email-automation-service"}));
app.get("/auth/google/start",async(req,rep)=>{const q=z.object({tenantId:z.string().min(1)}).parse(req.query);const state=crypto.randomBytes(24).toString("hex");await getDb().collection("oauthStates").insertOne({state,tenantId:q.tenantId,expiresAt:new Date(Date.now()+600000)});return rep.redirect(authUrl(state));});
app.get("/auth/google/callback",async(req,rep)=>{const q=z.object({code:z.string(),state:z.string()}).parse(req.query);const s=await getDb().collection("oauthStates").findOneAndDelete({state:q.state});if(!s)return rep.code(400).send({error:"Invalid/expired OAuth state"});const {tokens}=await oauth().getToken(q.code);if(!tokens.refresh_token)return rep.code(400).send({error:"No refresh token; revoke app access and reconnect"});const encrypted=encrypt(tokens.refresh_token);const p=await profile(encrypted);if(!p.emailAddress)return rep.code(400).send({error:"No Gmail address"});const r=await getDb().collection("mailboxes").findOneAndUpdate({tenantId:s.tenantId,email:p.emailAddress},{$set:{tenantId:s.tenantId,email:p.emailAddress,encryptedRefreshToken:encrypted,status:"CONNECTED",connectedAt:new Date()}},{upsert:true,returnDocument:"after"});const id=r?._id?.toString();if(!id)return rep.code(500).send({error:"Mailbox save failed"});await watchQueue.add("watch",{mailboxId:id},{jobId:`watch-${id}`,removeOnComplete:true});return rep.type("text/html").send(`<h2>Connected</h2><p>${p.emailAddress}</p><p>Mailbox ID: ${id}</p>`);});
app.get("/mailboxes",async req=>{const q=z.object({tenantId:z.string()}).parse(req.query);return getDb().collection("mailboxes").find({tenantId:q.tenantId},{projection:{encryptedRefreshToken:0}}).toArray();});
await connectMongo();
const gate=new MailboxGate(redis,env.MAILBOX_SEND_INTERVAL_MS,env.MAILBOX_PREPARE_LEASE_MS);
await restoreMailboxGates(new CampaignStore(getDb()),gate);
registerCampaignRoutes(app,new CampaignStore(getDb()),sendQueue,sendSettings);
app.post("/test/send",async(req,rep)=>{
  const b=z.object({mailboxId:z.string(),to:z.string().email(),subject:z.string(),html:z.string()}).parse(req.body);
  if(!ObjectId.isValid(b.mailboxId))return rep.code(400).send({error:"Invalid mailboxId"});
  const m=await getDb().collection("mailboxes").findOne({_id:new ObjectId(b.mailboxId),status:"CONNECTED"});
  if(!m)return rep.code(404).send({error:"Mailbox not found"});
  const owner=crypto.randomUUID(),wait=await gate.acquire(b.mailboxId,owner);
  if(wait>0)return rep.header("Retry-After",Math.ceil(wait/1000)).code(429).send({error:"Mailbox busy or cooling down"});
  let submitted=false;
  try {
    const submit=await prepareSend(m.encryptedRefreshToken,{from:m.email,to:b.to,subject:b.subject,html:b.html});
    if(!await gate.begin(b.mailboxId,owner))throw Error("Preparation lease expired");
    submitted=true; const result=await submit();
    if(!result.id)throw Error("Missing Gmail message ID");
    await gate.release(b.mailboxId,owner); return result;
  } catch(error) {
    const failure=classifyFailure(error,submitted);
    if(failure.kind==="ambiguous")await gate.quarantine(b.mailboxId,owner);
    else await gate.release(b.mailboxId,owner,failure.retryAfterMs);
    return rep.code(failure.kind==="ambiguous"?409:failure.code==="GMAIL_RATE_LIMIT"?429:502)
      .send({error:failure.code,status:failure.kind==="ambiguous"?"UNKNOWN":"REJECTED"});
  }
});
app.post("/webhooks/google/pubsub",async(req,rep)=>{const b=req.body as any;const d=b?.message?.data;if(!d)return rep.code(204).send();const x=JSON.parse(Buffer.from(d,"base64").toString());const m=await getDb().collection("mailboxes").findOne({email:x.emailAddress,status:"CONNECTED"});if(m)await replyQueue.add("sync",{mailboxId:m._id.toString(),historyId:String(x.historyId)},{jobId:`sync-${m._id}-${x.historyId}`,removeOnComplete:1000});return rep.code(204).send();});
app.setErrorHandler((error,req,rep)=>{const validation=error instanceof z.ZodError; req.log.error({code:validation?"VALIDATION_ERROR":"REQUEST_FAILED"},"Request failed"); return rep.code(validation?400:500).send({error:validation?"Invalid request":"Request failed"});}); await app.listen({port:env.PORT,host:"0.0.0.0"});
