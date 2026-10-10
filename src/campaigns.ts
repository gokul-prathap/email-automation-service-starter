import { ObjectId, type Db, type Document } from "mongodb";

export type RecipientStatus = "QUEUED" | "SENDING" | "SENT" | "RETRY" | "FAILED" | "UNKNOWN";
export interface Delivery extends Document {
  status: RecipientStatus;
  attempts: number;
  messageId: string;
  version: number;
  history: Document[];
}

// One MongoDB document is the authority for admission, delivery states and counts.
// This works on standalone MongoDB without multi-document transactions.
const recalculate: Document[] = [
  { $set: { _states: { $map: { input: { $objectToArray: "$delivery" }, as: "entry", in: "$$entry.v" } } } },
  { $set: { counts: {
    total: { $size: "$_states" },
    queued: { $size: { $filter: { input: "$_states", as: "s", cond: { $in: ["$$s.status", ["QUEUED", "RETRY"]] } } } },
    ...Object.fromEntries(["SENDING", "SENT", "FAILED", "UNKNOWN"].map(status => [status.toLowerCase(),
      { $size: { $filter: { input: "$_states", as: "s", cond: { $eq: ["$$s.status", status] } } } }])),
  } } },
  { $set: { status: { $switch: { branches: [
    { case: { $eq: ["$status", "PAUSED"] }, then: "PAUSED" },
    { case: { $and: [{ $gt: ["$counts.total", 0] }, { $eq: ["$counts.sent", "$counts.total"] }] }, then: "COMPLETED" },
    { case: { $and: [{ $gt: ["$counts.total", 0] }, { $eq: ["$counts.failed", "$counts.total"] }] }, then: "FAILED" },
    { case: { $and: [{ $gt: ["$counts.total", 0] }, { $eq: [{ $add: ["$counts.sent", "$counts.failed", "$counts.unknown"] }, "$counts.total"] }] }, then: "PARTIALLY_FAILED" },
    { case: { $anyElementTrue: [{ $map: { input: "$_states", as: "s", in: { $gt: ["$$s.attempts", 0] } } }] }, then: "RUNNING" },
  ], default: "SCHEDULED" } }, updatedAt: "$$NOW" } },
  { $unset: "_states" },
];

export function initialDelivery(id: string, status: RecipientStatus = "QUEUED"): Delivery {
  return { status, attempts: 0, messageId: `<recipient-${id}@email-automation.local>`, version: 0, history: [] };
}

export class CampaignStore {
  constructor(public readonly db: Db) {}

  async ensure(id: string) {
    let campaign = await this.db.collection("campaigns").findOne({ _id: new ObjectId(id) });
    if (!campaign || campaign.delivery) return campaign;
    const recipients = await this.db.collection("campaignRecipients").find({ campaignId: id }).toArray();
    const delivery = Object.fromEntries(recipients.map(r => {
      const status = r.status === "REPLIED" ? "SENT" : r.status === "SENDING" ? "UNKNOWN" : r.status;
      return [r._id.toString(), { ...initialDelivery(r._id.toString()), status, attempts: r.attempts ?? 0,
        ...(r.gmailMessageId ? { gmailMessageId: r.gmailMessageId } : {}),
        ...(r.status === "SENDING" ? { error: { kind: "ambiguous", code: "LEGACY_SENDING" } } : {}) }];
    }));
    await this.db.collection("campaigns").updateOne({ _id: campaign._id, delivery: { $exists: false } }, [
      { $set: { delivery: { $literal: delivery }, revision: 0 } }, ...recalculate,
    ]);
    return this.db.collection("campaigns").findOne({ _id: campaign._id });
  }

  async change(id: string, recipientId: string, expected: Document, patch: Document) {
    const path = `delivery.${recipientId}`;
    const filter: Document = { _id: new ObjectId(id) };
    for (const [key, value] of Object.entries(expected)) {
      filter[key.startsWith("campaign:") ? key.slice(9) : `${path}.${key}`] = value;
    }
    const result = await this.db.collection("campaigns").findOneAndUpdate(filter, [
      { $set: { [path]: { $mergeObjects: [`$${path}`, { $literal: patch },
        { version: { $add: [{ $ifNull: [`$${path}.version`, 0] }, 1] } }] },
        revision: { $add: [{ $ifNull: ["$revision", 0] }, 1] } } }, ...recalculate,
    ], { returnDocument: "after" });
    if (result) await this.mirror(result, recipientId);
    return result?.delivery[recipientId] as Delivery | undefined;
  }

  async claim(id: string, recipientId: string, attemptId: string, maxAttempts: number) {
    const c = await this.ensure(id);
    const state = c?.delivery[recipientId] as Delivery | undefined;
    if (!state || !["QUEUED", "RETRY"].includes(state.status) || state.attempts >= maxAttempts) return;
    return this.change(id, recipientId, {
      "campaign:status": { $in: ["SCHEDULED", "RUNNING"] }, status: state.status, version: state.version,
    }, { status: "SENDING", phase: "preparing", attemptId, startedAt: new Date(),
      attempts: state.attempts + 1, nextAttemptAt: null });
  }

  async finish(id: string, recipientId: string, attemptId: string, patch: Document) {
    const c = await this.ensure(id);
    const state = c?.delivery[recipientId] as Delivery | undefined;
    if (!state || state.attemptId !== attemptId || state.status !== "SENDING") return;
    const history = [...state.history, { attempt: state.attempts, startedAt: state.startedAt,
      finishedAt: new Date(), status: patch.status, ...(patch.error ? { error: patch.error } : {}) }].slice(-20);
    return this.change(id, recipientId, { status: "SENDING", attemptId, version: state.version },
      { ...patch, history, phase: null, finishedAt: new Date() });
  }

  async mirror(campaign: Document, recipientId: string) {
    const state = campaign.delivery[recipientId];
    await this.db.collection("campaignRecipients").updateOne({ _id: new ObjectId(recipientId),
      $or: [{ stateVersion: { $exists: false } }, { stateVersion: { $lte: state.version } }] },
    { $set: { ...state, stateVersion: state.version, updatedAt: new Date() } });
  }

  async pause(id: string) {
    await this.ensure(id);
    return this.db.collection("campaigns").findOneAndUpdate({ _id: new ObjectId(id),
      status: { $in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
    { $set: { status: "PAUSED", updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: "after" });
  }

  async resume(id: string) {
    await this.ensure(id);
    return this.db.collection("campaigns").findOneAndUpdate({ _id: new ObjectId(id), status: "PAUSED" }, [
      { $set: { status: "SCHEDULED", revision: { $add: ["$revision", 1] } } }, ...recalculate,
    ], { returnDocument: "after" });
  }

  async view(id: string) {
    const c = await this.ensure(id);
    if (!c) return;
    const recipients = await this.db.collection("campaignRecipients").find({ campaignId: id }).toArray();
    return { campaign: { ...c, delivery: undefined }, counts: c.counts,
      recipients: recipients.map(r => ({ ...r, lastError: undefined, ...c.delivery[r._id.toString()] })) };
  }
}
