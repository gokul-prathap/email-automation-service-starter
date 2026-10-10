import crypto from "node:crypto";
import {google} from "googleapis"; import {env} from "./config.js"; import {decrypt} from "./crypto.js";
export const SCOPES=["https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/gmail.readonly"];
export function oauth(){return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET,env.GOOGLE_REDIRECT_URI)}
export function authUrl(state:string){return oauth().generateAuthUrl({access_type:"offline",prompt:"consent",scope:SCOPES,state})}
export function gmailClient(token:string){const a=oauth();a.setCredentials({refresh_token:decrypt(token)});return google.gmail({version:"v1",auth:a})}
export async function profile(token:string){return (await gmailClient(token).users.getProfile({userId:"me"})).data}
export interface OutgoingMessage { from: string; to: string; subject: string; html: string; messageId?: string }
export async function prepareSend(token: string, x: OutgoingMessage) {
  // Refresh credentials before crossing the submission boundary. Disable hidden HTTP retries.
  const auth = oauth(); auth.setCredentials({refresh_token:decrypt(token)});
  const access = await auth.getAccessToken(); if(!access.token)throw Error("Access token unavailable");
  const submitAuth=oauth(); submitAuth.setCredentials({access_token:access.token,expiry_date:auth.credentials.expiry_date});
  const client=google.gmail({version:"v1",auth:submitAuth});
  const boundary = "bnd_" + crypto.randomUUID();
  const plain = x.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  for (const header of [x.from, x.to, x.subject, x.messageId ?? ""]) {
    if (/[\r\n]/.test(header)) throw new Error("Invalid mail header");
  }
  const subject = `=?UTF-8?B?${Buffer.from(x.subject).toString("base64")}?=`;
  const raw = [`From: ${x.from}`, `To: ${x.to}`, `Subject: ${subject}`,
    `Message-ID: ${x.messageId ?? `<${crypto.randomUUID()}@email-automation.local>`}`,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(plain).toString("base64"), "", `--${boundary}`, "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64", "", Buffer.from(x.html).toString("base64"), "", `--${boundary}--`].join("\r\n");
  return async () => (await client.users.messages.send({ userId: "me", requestBody: {
    raw: Buffer.from(raw).toString("base64url"),
  } }, { retry: false, timeout: env.GMAIL_SEND_TIMEOUT_MS })).data;
}
export async function send(token: string, x: OutgoingMessage) { return (await prepareSend(token, x))(); }
export async function watch(token:string){return (await gmailClient(token).users.watch({userId:"me",requestBody:{topicName:env.GOOGLE_PUBSUB_TOPIC,labelIds:["INBOX"]}})).data}
export async function history(token:string,start:string){const g=gmailClient(token),out:any[]=[];let pageToken:string|undefined;do{const r=await g.users.history.list({userId:"me",startHistoryId:start,historyTypes:["messageAdded"],pageToken});for(const h of r.data.history??[])for(const m of h.messagesAdded??[])if(m.message)out.push(m.message);pageToken=r.data.nextPageToken??undefined;}while(pageToken);return out;}
export async function message(token:string,id:string){return (await gmailClient(token).users.messages.get({userId:"me",id,format:"metadata",metadataHeaders:["From","In-Reply-To","References","Subject"]})).data}
