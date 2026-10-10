import crypto from "node:crypto";
import { DelayedError, type Job, type Queue } from "bullmq";
import { ObjectId, type Document } from "mongodb";
import { CampaignStore, type Delivery } from "./campaigns.js";
import { MailboxGate } from "./mailbox-gate.js";
import { classifyFailure } from "./send-errors.js";

export interface SendSettings { attempts: number; backoff: number; lease: number; timeout: number; poll: number }
export interface SubmissionResult { id?: string | null; threadId?: string | null }
export type PrepareSend = (mailbox: Document, recipient: Document, messageId: string) => Promise<() => Promise<SubmissionResult>>;

export async function enqueueRecipient(queue: Queue, recipientId: string, state: Delivery,
  scheduledAt: Date, settings: SendSettings) {
  const jobId = `send-${recipientId}-${state.attempts}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const status = await existing.getState();
    if (status !== "completed" && status !== "failed") return;
    await existing.remove();
  }
  await queue.add("send", { recipientId }, { jobId, attempts: settings.attempts,
    backoff: { type: "exponential", delay: settings.backoff },
    delay: Math.max(0, scheduledAt.getTime() - Date.now(), new Date(state.nextAttemptAt ?? 0).getTime() - Date.now()),
    removeOnComplete: 1000, removeOnFail: 1000 });
}

export function createSendProcessor(store: CampaignStore, gate: MailboxGate,
  prepare: PrepareSend, settings: SendSettings) {
  return async (job: Job, token?: string) => {
    const delay = async (ms: number): Promise<never> => {
      await job.moveToDelayed(Date.now() + Math.max(ms, 50), token);
      throw new DelayedError();
    };
    const recipient = await store.db.collection("campaignRecipients").findOne({ _id: new ObjectId(job.data.recipientId) });
    if (!recipient) return;
    const campaign = await store.ensure(recipient.campaignId);
    const state = campaign?.delivery[recipient._id.toString()] as Delivery | undefined;
    if (!state || !["QUEUED", "RETRY"].includes(state.status)) return;
    if (campaign?.status === "PAUSED") return delay(settings.poll);
    const due = Math.max(new Date(recipient.scheduledAt ?? 0).getTime(), new Date(state.nextAttemptAt ?? 0).getTime());
    if (due > Date.now()) return delay(due - Date.now());
    if (state.attempts >= settings.attempts) {
      await store.change(recipient.campaignId, recipient._id.toString(), { status: state.status, version: state.version },
        { status: "FAILED", error: { kind: "pre-send", code: "ATTEMPTS_EXHAUSTED" } });
      return;
    }
    const owner = crypto.randomUUID();
    const wait = await gate.acquire(recipient.mailboxId, owner);
    if (wait > 0) return delay(wait);
    let submitted = false;
    let claimed: Delivery | undefined;
    try {
      claimed = await store.claim(recipient.campaignId, recipient._id.toString(), owner, settings.attempts);
      if (!claimed) {
        await gate.release(recipient.mailboxId, owner);
        return delay(settings.poll);
      }
      const mailbox = await store.db.collection("mailboxes").findOne({ _id: new ObjectId(recipient.mailboxId),
        tenantId: recipient.tenantId, status: "CONNECTED" });
      if (!mailbox) throw new Error("Mailbox unavailable");
      const submit = await prepare(mailbox, recipient, claimed.messageId);
      const fenced = await store.change(recipient.campaignId, recipient._id.toString(),
        { status: "SENDING", attemptId: owner, phase: "preparing" }, { phase: "submitting" });
      if (!fenced) { await gate.release(recipient.mailboxId, owner); return; }
      if (!await gate.begin(recipient.mailboxId, owner)) throw new Error("Preparation lease expired");
      submitted = true;
      const result = await submit();
      if (!result.id) throw new Error("Submission returned no message ID");
      const sent = await store.finish(recipient.campaignId, recipient._id.toString(), owner,
        { status: "SENT", gmailMessageId: result.id, gmailThreadId: result.threadId, sentAt: new Date(), error: null });
      // A recovery scan may have marked a slow request UNKNOWN. A real success can reconcile it.
      if (!sent) await store.change(recipient.campaignId, recipient._id.toString(), { status: "UNKNOWN", attemptId: owner },
        { status: "SENT", gmailMessageId: result.id, gmailThreadId: result.threadId, sentAt: new Date(), error: null });
      await gate.release(recipient.mailboxId, owner);
    } catch (error) {
      if (!claimed) { await gate.release(recipient.mailboxId, owner); throw new Error("Send admission unavailable"); }
      const failure = classifyFailure(error, submitted);
      const retry = failure.retryable && claimed.attempts < settings.attempts;
      const backoff = Math.max(settings.backoff * 2 ** (claimed.attempts - 1), failure.retryAfterMs);
      await store.finish(recipient.campaignId, recipient._id.toString(), owner, {
        status: failure.kind === "ambiguous" ? "UNKNOWN" : retry ? "RETRY" : "FAILED",
        error: failure, nextAttemptAt: retry ? new Date(Date.now() + backoff) : null,
      });
      if (failure.kind === "ambiguous") await gate.quarantine(recipient.mailboxId, owner);
      else await gate.release(recipient.mailboxId, owner, failure.retryAfterMs);
      if (retry) throw new Error(`${failure.code}: safe retry scheduled`);
    }
  };
}

export async function restoreMailboxGates(store: CampaignStore, gate: MailboxGate) {
  for await (const c of store.db.collection("campaigns").find({})) {
    const campaign = await store.ensure(c._id.toString());
    if (!campaign) continue;
    for (const [id, raw] of Object.entries(campaign.delivery)) {
      const state = raw as Delivery;
      if ((state.status === "UNKNOWN" && !state.quarantineClearedAt) ||
          (state.status === "SENDING" && state.phase === "submitting")) {
        const recipient = await store.db.collection("campaignRecipients").findOne({ _id: new ObjectId(id) });
        if (recipient?.mailboxId) await gate.restoreQuarantine(recipient.mailboxId, state.attemptId ?? `legacy-${id}`);
      }
    }
  }
}

export async function recoverAndEnqueue(store: CampaignStore, gate: MailboxGate,
  queue: Queue, settings: SendSettings) {
  for await (const document of store.db.collection("campaigns").find({})) {
    const campaign = await store.ensure(document._id.toString());
    if (!campaign) continue;
    for (const [id, raw] of Object.entries(campaign.delivery)) {
      let state = raw as Delivery;
      const recipient = await store.db.collection("campaignRecipients").findOne({ _id: new ObjectId(id) });
      if (!recipient) continue;
      if (state.status === "SENDING" && Date.now() - new Date(state.startedAt).getTime() > settings.lease + settings.timeout) {
        const lock = await gate.inspect(recipient.mailboxId);
        if (state.phase === "preparing" && lock.owner === state.attemptId) continue;
        const ambiguous = state.phase === "submitting" || (lock.owner === state.attemptId && lock.phase !== "preparing");
        const recovered = await store.finish(recipient.campaignId, id, state.attemptId, {
          status: ambiguous ? "UNKNOWN" : state.attempts < settings.attempts ? "RETRY" : "FAILED",
          error: { kind: ambiguous ? "ambiguous" : "pre-send", code: "WORKER_INTERRUPTED" },
          nextAttemptAt: new Date(Date.now() + settings.backoff),
        });
        if (ambiguous) await gate.quarantine(recipient.mailboxId, state.attemptId);
        if (recovered) state = recovered;
      }
      // Repairs partial creation, lost jobs and stale collection mirrors after a crash.
      const latest = await store.ensure(recipient.campaignId);
      if (latest) await store.mirror(latest, id);
      if (["QUEUED", "RETRY"].includes(state.status) && campaign.status !== "PAUSED") {
        await enqueueRecipient(queue, id, state, new Date(recipient.scheduledAt ?? Date.now()), settings);
      }
    }
  }
}
