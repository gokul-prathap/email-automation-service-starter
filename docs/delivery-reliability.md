# Delivery reliability and Windows verification

## Existing structure

The API and worker remain separate Node.js/TypeScript processes. MongoDB collections remain `mailboxes`, `campaigns`, `campaignRecipients`, and `oauthStates`. BullMQ queues remain `email-send`, `gmail-reply-sync`, and `gmail-watch`. Docker still runs standalone MongoDB and Redis; no replica set or new dependencies are required.

Existing endpoints remain `/health`, `/auth/google/start`, `/auth/google/callback`, `/mailboxes`, `/campaigns`, `/campaigns/:id`, `/test/send`, and `/webhooks/google/pubsub`. New endpoints are `POST /campaigns/:id/pause` and `POST /campaigns/:id/resume`.

## Lifecycle and pause semantics

A compact `campaigns.delivery` map is the authoritative recipient state. MongoDB update pipelines atomically change recipient state, recompute counts, and derive campaign status in ONE document. `campaignRecipients` retains message content, tenant/mailbox references and a versioned mirror of delivery state. GET overlays authoritative state onto these existing rows, so a crash between writes cannot produce stale API counts. The recovery scan repairs mirrors and missing queue jobs.

`counts.queued` includes QUEUED and RETRY. Other counts are `total`, `sending`, `sent`, `failed`, `unknown`. COMPLETED requires every recipient SENT; FAILED requires every recipient FAILED. PARTIALLY_FAILED means every recipient is terminal and at least one outcome is uncertain or a mixture of SENT and FAILED. An all-UNKNOWN campaign is PARTIALLY_FAILED. SENT means Gmail returned a successful submission ID, not a guarantee of final inbox delivery.

Pause and send admission race on the same campaign document. If pause commits first, the claim cannot succeed. If claim commits first, that admitted attempt may finish (including preparation and submission) after pause returns. Pause does not cancel an admitted request. Finalizations preserve PAUSED. Resume atomically recalculates status and publishes remaining jobs. SENT never becomes QUEUED, and UNKNOWN is never retried. Reply tracking adds `replied`/`repliedAt` without replacing SENT with REPLIED.

Existing campaigns are initialized lazily without deleting rows. Legacy REPLIED becomes authoritative SENT. Legacy SENDING becomes UNKNOWN because its submission boundary cannot be reconstructed. Legacy error strings are not used for new attempt history. Stop ALL old API/worker processes before upgrading; mixed old/new worker versions are unsafe.

New campaigns are capped at 1,000 distinct recipients. Per-recipient history is bounded to 20 entries. This makes atomic standalone-MongoDB updates practical locally but does not remove MongoDB's 16 MiB document limit. Very large legacy campaigns may require a deliberate transactional migration. Collection mirrors and job publication are eventually repaired, while campaign state/counts are atomic. A database failure during initial insertion can leave orphan recipient rows; they are never sent without a published campaign. No existing data is deleted.

## Mailbox coordination

Lua scripts atomically acquire/check/release a Redis owner token and cooldown per mailbox ID. Redis TIME provides the clock. Preparation has a bounded, configurable lease. An expired owner cannot enter submission or release another owner's lock. At the submission boundary the lock becomes persistent. Only its owner can release it after a definite result. The interval is enforced conservatively from COMPLETION to the next attempt, which also guarantees the minimum interval between starts even if a process pauses before its HTTP call. Different mailbox IDs can submit concurrently.

Contention, scheduled sends, retry deadlines and pauses use BullMQ `moveToDelayed` plus `DelayedError`; they do not consume Gmail attempts or occupy worker slots with long sleeps. The short defer interval is configurable. Persistent uncertain locks cause periodic delayed rechecks; operators should reconcile promptly rather than leave many blocked jobs indefinitely.

A persistent submission fence deliberately trades availability for safety: a crash, timeout, uncertain HTTP outcome, or failure to persist a Gmail success quarantines the mailbox. Remaining recipients wait. Expiring such a fence could overlap a new send with a request still running at Gmail. Redis cannot fence Gmail itself, and Message-ID is NOT a Gmail idempotency key. No system can guarantee remote exactly-once delivery from an ambiguous response using this API alone.

The guarantee assumes a single authoritative Redis instance, retained coordination keys, no eviction/manual key deletion, and workers all using this gate. Compose now configures AOF with `appendfsync always` and `noeviction`. These settings take effect on container recreation; volumes are retained. Redis failover, data loss, backup rollback, or clock jumps are outside the strict guarantee. Stop all senders after Redis data loss; startup restores known MongoDB quarantines, but cannot reconstruct an unrecorded direct send. Never use FLUSHDB/FLUSHALL on the application Redis. The key namespace is `email-mailbox:{MAILBOX_ID}:lock` and `email-mailbox:{MAILBOX_ID}:next`.

## Retry and restart behavior

Gmail credentials, MIME construction and header validation are prepared before submission. The actual Gmail POST uses a cached access token without a refresh token, disables transport retries, and has a request timeout. This prevents a hidden HTTP/auth resend.

- Definitely pre-submission failures use configured attempts and exponential backoff.
- Explicit Gmail 429 and quota-specific 403 rejections retry and impose a shared mailbox cooldown from Retry-After (seconds or HTTP date), if supplied.
- Explicit permanent 400/401/403/404/413/422 rejections become FAILED.
- Timeouts, connection loss, missing successful message IDs, 408 and 5xx after the submission boundary become UNKNOWN. No automatic retry is allowed.

Attempts and sanitized error kinds/codes/statuses are persisted. Raw OAuth/Gaxios errors and request configurations are never logged or stored by the send processor. Retry deadlines persist independently of BullMQ retries, so queue repair cannot bypass backoff. A MongoDB attempt budget caps resends even if a job is recreated. Infrastructure/job publication failures are repaired by a non-overlapping periodic recovery scan.

Stale SENDING recovery waits `MAILBOX_PREPARE_LEASE_MS + GMAIL_SEND_TIMEOUT_MS`. An expired preparation with no submission boundary can safely retry. A submitting record becomes UNKNOWN and keeps its fence. Startup restores known missing submission/UNKNOWN fences before starting the send worker. A slow live call that returns a definite success after recovery can reconcile its own UNKNOWN record.

## Reconcile UNKNOWN without resending

Inspect GET `/campaigns/:id` to find the recipient `_id` and stable `messageId`. New sends use `<recipient-RECIPIENT_ID@email-automation.local>`. The readonly search uses Gmail's `in:sent rfc822msgid:...`. Legacy messages may have a different RFC Message-ID; manually inspect their Gmail metadata instead of assuming the generated fallback identifies them.

Read-only preview (makes Gmail search calls, never sends):

```powershell
npm run reconcile -- "RECIPIENT_ID"
```

Before clearing a quarantine, stop ALL API and worker instances, ensure no old request can still execute, and establish that any outstanding Gmail request has settled. A timeout or process exit alone is not proof of remote settlement. Then explicitly confirm that condition:

```powershell
npm run reconcile -- "RECIPIENT_ID" --confirm-quiesced
```

Exactly one Gmail match changes UNKNOWN to SENT. No match keeps UNKNOWN and marks its mailbox quarantine explicitly cleared so other recipients can proceed. Absence in search may reflect indexing lag and NEVER authorizes resending. Multiple matches require manual investigation. Restart the service afterward. If Redis has an unrelated newer owner, owner-checked release does not clear it.

For a direct `/test/send` UNKNOWN there is no campaign recipient to reconcile. Inspect Gmail Sent and the Redis lock, stop all senders and establish remote quiescence before manually removing the specific lock. Do not repeat the direct request merely because it returned UNKNOWN.

## Exact PowerShell commands

From the repository root, preserving your existing `.env`:

```powershell
Set-Location 'D:\Realm of AI\Platform\email-automation-service-starter'
npm ci
docker compose up -d
npm run typecheck
npm run build
npm test
```

Do not copy `.env.example` over the current `.env`. New settings have defaults, so existing secrets/configuration remain valid. `npm test` uses the real local MongoDB/Redis services with randomly named `email_automation_test_*` databases, random Redis prefixes, and exclusively MOCKED Gmail submissions. It deletes only its isolated test resources. Optional test infrastructure overrides are `TEST_MONGODB_URI` and `TEST_REDIS_URL`; never point these at production infrastructure.

Run API and worker together:

```powershell
npm run dev
```

Or run compiled processes in two terminals:

```powershell
npm run start:api
```

```powershell
npm run start:worker
```

Another PowerShell terminal:

```powershell
Invoke-RestMethod 'http://localhost:3001/health'
$campaignId = 'EXISTING_CAMPAIGN_ID'
Invoke-RestMethod "http://localhost:3001/campaigns/$campaignId"
Invoke-RestMethod -Method Post "http://localhost:3001/campaigns/$campaignId/pause"
Invoke-RestMethod -Method Post "http://localhost:3001/campaigns/$campaignId/resume"
```

The health/pause/resume commands do not directly send mail, but resuming a real campaign enables real worker submissions. Automated tests never use real OAuth credentials or send real mail. Existing mailbox/campaign creation examples remain in `docs/local-setup.md`.

## Configuration defaults

| Variable | Default |
| --- | --- |
| MAILBOX_SEND_INTERVAL_MS | 5000 |
| MAILBOX_PREPARE_LEASE_MS | 30000 |
| GMAIL_SEND_TIMEOUT_MS | 20000 |
| SEND_MAX_ATTEMPTS | 5 |
| SEND_BACKOFF_MS | 1000 |
| SEND_WORKER_CONCURRENCY | 5 |
| SEND_RECOVERY_INTERVAL_MS | 15000 |
| SEND_DEFER_MS | 1000 |

All settings must be positive integers; attempts are capped at 20. Increase the preparation lease for slow OAuth refreshes; expiration fails safely without submission.

## Remaining production gaps

Tenant authentication/authorization is still absent: callers can supply tenantId, and GET/pause/resume/test-send do not enforce authenticated tenant ownership. Do not expose this API publicly as a production multi-tenant service. Pub/Sub push authentication, JWT issuer/audience verification, replay protection and tenant-safe mailbox routing are still absent. Public webhook payloads cannot currently be trusted.

Add authenticated tenant scoping, validate Google's Pub/Sub JWT, bind OAuth state to authenticated sessions, add API quotas/abuse protection, and secure MongoDB/Redis with private networking/authentication/TLS. The existing Compose ports are publicly bound locally; use a trusted development machine. Review Google OAuth verification/scopes, history-expiration reconciliation, global/project Gmail quotas, duplicate mailbox identities across tenants, observability, and operational dead-letter handling before production. The recovery scanner currently scans all campaigns and recipient mirrors periodically; large installations need an indexed work/outbox strategy and transactional storage rather than expanding the embedded map indefinitely.

## Primary references

- [BullMQ delayed jobs inside processors](https://docs.bullmq.io/patterns/process-step-jobs)
- [Gmail error and quota handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Redis distributed lock assumptions](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)

## Changed files

| Files | Purpose |
| --- | --- |
| `src/campaigns.ts`, `src/campaign-routes.ts` | Atomic delivery state/counts, legacy initialization, campaign creation, pause/resume and reads |
| `src/mailbox-gate.ts`, `src/send-processor.ts`, `src/send-errors.ts` | Redis ownership, delayed scheduling, safe retries, error classification and restart recovery |
| `src/reconciliation.ts`, `src/reconcile.ts` | Read-only Gmail lookup and explicit quiescence-confirmed reconciliation |
| `src/api.ts`, `src/worker.ts`, `src/gmail.ts`, `src/queues.ts`, `src/config.ts`, `src/db.ts` | Integrate the existing API/worker, submission boundary, queue options, configuration and shutdown |
| `tests/delivery.test.ts`, `tests/crash-worker.ts`, `package.json` | Mocked-Gmail integration tests and test/reconciliation scripts |
| `.env.example`, `docker-compose.yml` | New example defaults and durable, non-evicting Redis configuration |
| `docs/local-setup.md`, `docs/production-notes.md`, `docs/delivery-reliability.md` | Windows operation, verification, design limits and production gaps |
