import { ObjectId, type Document } from "mongodb";
import { CampaignStore, type Delivery } from "./campaigns.js";
import { MailboxGate } from "./mailbox-gate.js";

export type LookupSent = (mailbox: Document, messageId: string) => Promise<{ id: string; threadId?: string | null }[]>;
export async function reconcileRecipient(store: CampaignStore, gate: MailboxGate, lookup: LookupSent,
  recipientId: string, confirmQuiesced = false) {
  if (!ObjectId.isValid(recipientId)) throw new Error("Invalid recipient ID");
  const recipient = await store.db.collection("campaignRecipients").findOne({ _id: new ObjectId(recipientId) });
  if (!recipient) throw new Error("Recipient not found");
  const campaign = await store.ensure(recipient.campaignId);
  const state = campaign?.delivery[recipientId] as Delivery | undefined;
  if (state?.status !== "UNKNOWN") throw new Error("Recipient is not UNKNOWN");
  const mailbox = await store.db.collection("mailboxes").findOne({ _id: new ObjectId(recipient.mailboxId) });
  if (!mailbox) throw new Error("Mailbox not found");
  const matches = await lookup(mailbox, state.messageId);
  if (!confirmQuiesced) return { recipientId, matches: matches.length, changed: false };
  if (matches.length > 1) throw new Error("Multiple Gmail matches; manual investigation required");
  const patch: Document = { quarantineClearedAt: new Date() };
  if (matches.length === 1) Object.assign(patch, { status: "SENT", gmailMessageId: matches[0].id,
    gmailThreadId: matches[0].threadId, reconciledAt: new Date(), error: null,
    history: [...state.history, { status: "SENT", reconciledAt: new Date(), code: "GMAIL_MATCH" }].slice(-20) });
  const updated = await store.change(recipient.campaignId, recipientId,
    { status: "UNKNOWN", version: state.version }, patch);
  if (!updated) throw new Error("Recipient changed concurrently; inspect before retrying reconciliation");
  await gate.release(recipient.mailboxId, state.attemptId ?? `legacy-${recipientId}`);
  // Absence from Gmail search never authorizes retrying this recipient.
  return { recipientId, matches: matches.length, changed: true, status: updated.status };
}
