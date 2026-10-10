import { ObjectId } from "mongodb";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import { CampaignStore, initialDelivery } from "./campaigns.js";
import { enqueueRecipient, type SendSettings } from "./send-processor.js";

const objectId = z.string().refine(ObjectId.isValid, "Invalid ObjectId");
const schema = z.object({ tenantId: z.string().min(1), mailboxId: objectId,
  subject: z.string().min(1).max(1000), html: z.string().min(1).max(1000000),
  recipients: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).min(1).max(1000)
    .refine(rs => new Set(rs.map(r => r.email.toLowerCase())).size === rs.length, "Duplicate recipients"),
  scheduledAt: z.coerce.date().optional(),
});

export function registerCampaignRoutes(app: FastifyInstance, store: CampaignStore, queue: Queue, settings: SendSettings) {
  app.post("/campaigns", async (req, rep) => {
    const b = schema.parse(req.body);
    const scheduledAt = b.scheduledAt ?? new Date();
    const mailbox = await store.db.collection("mailboxes").findOne({ _id: new ObjectId(b.mailboxId),
      tenantId: b.tenantId, status: "CONNECTED" });
    if (!mailbox) return rep.code(404).send({ error: "Mailbox not found" });
    const id = new ObjectId();
    const recipients = b.recipients.map(r => ({ _id: new ObjectId(), campaignId: id.toString(), tenantId: b.tenantId,
      mailboxId: b.mailboxId, email: r.email.toLowerCase(), name: r.name, subject: b.subject, html: b.html,
      scheduledAt, status: "QUEUED", attempts: 0, createdAt: new Date() }));
    const delivery = Object.fromEntries(recipients.map(r => [r._id.toString(), initialDelivery(r._id.toString())]));
    // Publish the campaign only after every recipient exists; no worker can admit orphan rows.
    await store.db.collection("campaignRecipients").insertMany(recipients);
    await store.db.collection("campaigns").insertOne({ _id: id, tenantId: b.tenantId, mailboxId: b.mailboxId,
      subject: b.subject, html: b.html, scheduledAt, status: "SCHEDULED", delivery, revision: 0,
      counts: { total: recipients.length, queued: recipients.length, sending: 0, sent: 0, failed: 0, unknown: 0 }, createdAt: new Date() });
    try {
      for (const r of recipients) await enqueueRecipient(queue, r._id.toString(), delivery[r._id.toString()], scheduledAt, settings);
    } catch {
      // MongoDB remains the durable outbox. The recovery scan repairs queue publication.
      req.log.warn({ campaignId: id.toString() }, "Queue publication deferred to recovery");
    }
    return rep.code(202).send({ campaignId: id.toString(), queued: recipients.length });
  });

  app.get("/campaigns/:id", async (req, rep) => {
    const { id } = z.object({ id: objectId }).parse(req.params);
    const view = await store.view(id);
    return view ?? rep.code(404).send({ error: "Campaign not found" });
  });
  app.post("/campaigns/:id/pause", async (req, rep) => {
    const { id } = z.object({ id: objectId }).parse(req.params);
    if (!await store.ensure(id)) return rep.code(404).send({ error: "Campaign not found" });
    const result = await store.pause(id);
    if (!result) return rep.code(409).send({ error: "Campaign has already finished" });
    return { campaignId: id, status: result.status, counts: result.counts };
  });
  app.post("/campaigns/:id/resume", async (req, rep) => {
    const { id } = z.object({ id: objectId }).parse(req.params);
    if (!await store.ensure(id)) return rep.code(404).send({ error: "Campaign not found" });
    const result = await store.resume(id);
    if (!result) return rep.code(409).send({ error: "Campaign is not paused" });
    for (const [recipientId, state] of Object.entries(result.delivery)) {
      const s = state as ReturnType<typeof initialDelivery>;
      if (["QUEUED", "RETRY"].includes(s.status)) {
        try { await enqueueRecipient(queue, recipientId, s, result.scheduledAt, settings); }
        catch { req.log.warn({ campaignId: id }, "Resume queue publication deferred to recovery"); }
      }
    }
    return { campaignId: id, status: result.status, counts: result.counts };
  });
}
