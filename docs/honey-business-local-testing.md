# Local testing guide: Golden Hive Honey

A practical workbook for a honey-business owner and a developer. Each scenario includes a business reason, local steps and expected results.

## 1. Start with the business use case

You own **Golden Hive Honey**, a small business selling jars of honey. Five customers have asked for product updates. A new batch is ready, and you want to send this announcement:

> Subject: Golden Hive Honey: our fresh batch is ready
>
> Hello,
>
> Our fresh wildflower honey is ready. Reply if you would like us to reserve a jar.
>
> Thank you,
> Golden Hive Honey

You want to send from the correct Gmail account, check the message first, email each customer separately, schedule the campaign, see progress, pause when needed, and handle problems without blindly sending duplicates.

For this exercise, the customers are **five distinct inbox addresses controlled by you and the developer**. Use dedicated test senders, not actual customer lists. A second Gmail sender is needed for the separate-mailbox scenario.

The application sends and tracks emails. It does not manage honey inventory, payments or orders. A reply asking for two jars must currently be handled by a person or another system.

## 2. Work together

| Business owner | Developer |
| --- | --- |
| Approves content and intended recipients | Prepares local services and Google configuration |
| Checks emails on phone and computer | Runs requests and explains the records |
| Judges whether behavior suits the business | Runs failure simulations and investigates problems |
| Records PASS, FAIL or BLOCKED | Retains campaign IDs and test output |

There are two test types:

- **Real-email scenarios:** The application runs locally but uses real Gmail and sends to controlled inboxes.
- **Simulated reliability scenarios:** Automated tests use local databases and mocked Gmail. They create no real emails.

Use simulations for quota failures, ambiguous responses and abrupt crashes. Do not flood Gmail or disconnect a real send to manufacture failures.

## 3. Prepare the local environment

### Developer checklist

Have Node.js 22+, Docker Desktop, PowerShell, the existing configured `.env`, five controlled recipient addresses, and dedicated Gmail sender accounts. Google OAuth must allow those senders to connect. Refer to [local setup](local-setup.md).

Preserve your current `.env` and encryption key. Stop old application instances before testing.

### Separate the manual test database AND queues

Use a dedicated MongoDB database and Redis instance. Changing only the database while sharing the usual Redis queues can consume another environment's jobs because queue names are fixed.

In a setup terminal:

```powershell
Set-Location 'D:\Realm of AI\Platform\email-automation-service-starter'
npm ci
docker compose up -d
npm run typecheck
npm run build
```

FIRST setup of a dedicated demo Redis container:

```powershell
docker run --detach --name honey-demo-redis `
    --publish 127.0.0.1:6381:6379 `
    --mount type=volume,source=honey-demo-redis-data,target=/data `
    redis:8-alpine `
    redis-server --appendonly yes --appendfsync always --maxmemory-policy noeviction
```

On later sessions, if the container already exists:

```powershell
docker start honey-demo-redis
```

If port 6381 is occupied, choose another unused port and update every REDIS_URL consistently. Keep the named volume. These steps do not delete existing application records.

### Terminal A: API

```powershell
Set-Location 'D:\Realm of AI\Platform\email-automation-service-starter'
$env:MONGODB_DB = 'honey_demo'
$env:REDIS_URL = 'redis://127.0.0.1:6381'
$env:MAILBOX_SEND_INTERVAL_MS = '5000'
npm run start:api
```

### Terminal B: background worker

```powershell
Set-Location 'D:\Realm of AI\Platform\email-automation-service-starter'
$env:MONGODB_DB = 'honey_demo'
$env:REDIS_URL = 'redis://127.0.0.1:6381'
$env:MAILBOX_SEND_INTERVAL_MS = '5000'
npm run start:worker
```

Keep both terminals running. Terminal B should show `Workers running`. Separate processes let you stop the worker without stopping the API.

Environment overrides affect only their terminal and child processes; they do not change `.env`. Repeat the settings when using a new terminal. The separate database will not contain mailboxes connected in your original database, so connect the dedicated senders again.

### Terminal C: requests

Paste these helpers once. Replace recipient placeholders before creating campaigns:

```powershell
$baseUrl = 'http://localhost:3001'
$tenantId = 'golden-hive-honey'
$mailboxId = 'REPLACE_AFTER_CONNECTING_FIRST_SENDER'
$secondMailboxId = 'REPLACE_AFTER_CONNECTING_SECOND_SENDER'
$customers = @(
    'REPLACE_CUSTOMER_1_EMAIL'
    'REPLACE_CUSTOMER_2_EMAIL'
    'REPLACE_CUSTOMER_3_EMAIL'
    'REPLACE_CUSTOMER_4_EMAIL'
    'REPLACE_CUSTOMER_5_EMAIL'
)

function New-HoneyCampaign {
    param(
        [string]$Label,
        [string]$SenderId = $mailboxId,
        [string[]]$Recipients = $customers,
        [int]$DelayMinutes = 0
    )
    $payload = @{
        tenantId = $tenantId
        mailboxId = $SenderId
        subject = "[LOCAL TEST: $Label] Golden Hive Honey: our fresh batch is ready"
        html = '<h2>Fresh wildflower honey</h2><p>Hello,</p><p>Our new batch is ready. Reply if you would like us to reserve a jar.</p><p>Thank you,<br>Golden Hive Honey</p>'
        recipients = @($Recipients | ForEach-Object { @{ email = $_ } })
    }
    if ($DelayMinutes -gt 0) {
        $payload.scheduledAt = (Get-Date).AddMinutes($DelayMinutes).ToUniversalTime().ToString('o')
    }
    Invoke-RestMethod -Method Post -Uri "$baseUrl/campaigns" `
        -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 5)
}

function Show-HoneyCampaign {
    param([string]$Id)
    $view = Invoke-RestMethod "$baseUrl/campaigns/$Id"
    $view.campaign | Select-Object _id, status, scheduledAt
    $view.counts | Format-List
    $view.recipients | Select-Object email, status, attempts, sentAt, replied, repliedAt | Format-Table -AutoSize
}

function Wait-HoneyCampaign {
    param([string]$Id, [int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $view = Invoke-RestMethod "$baseUrl/campaigns/$Id"
        Write-Host "Status=$($view.campaign.status) Sent=$($view.counts.sent) Queued=$($view.counts.queued) Unknown=$($view.counts.unknown)"
        if ($view.campaign.status -in @('COMPLETED','FAILED','PARTIALLY_FAILED')) { return $view }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'Observation timed out. Inspect the campaign and worker; do not automatically resend.'
}
```

The helper's short sleep is for observing progress, not worker pacing. Each creation command creates a NEW campaign and intentionally sends new messages. Save its ID and label; rerunning creation does not reuse an earlier campaign.

## 4. Real-email scenarios

### Scenario 1: confirm the service responds

**Use case:** Before announcing the batch, check that the API is available.

```powershell
Invoke-RestMethod "$baseUrl/health"
```

**Verify:** `ok` is true and the service name is returned. Check Terminal B separately for the running worker. Health alone does not prove Gmail permissions, sending or reply notifications work.

### Scenario 2: connect the honey business sender

**Use case:** Send from the correct honey-business account.

**Steps:** Open this address in a browser, sign in with the dedicated test sender, and approve permissions:

```text
http://localhost:3001/auth/google/start?tenantId=golden-hive-honey
```

List mailboxes and copy the intended sender's ID:

```powershell
$mailboxes = Invoke-RestMethod "$baseUrl/mailboxes?tenantId=$tenantId"
$mailboxes | Select-Object _id, email, status
$mailboxId = 'PASTE_FIRST_SENDER_MAILBOX_ID'
```

**Verify:** Correct email address, CONNECTED status, and no `encryptedRefreshToken` in the response. The owner checks the actual address rather than assuming which Google account the browser selected.

### Scenario 3: preview the honey message

**Use case:** Check the email before contacting the other test recipients.

```powershell
$preview = @{
    mailboxId = $mailboxId
    to = $customers[0]
    subject = '[LOCAL TEST: preview] Golden Hive Honey'
    html = '<h2>Fresh wildflower honey</h2><p>Our new batch is ready.</p><p>Reply to reserve a jar.</p>'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$baseUrl/test/send" `
    -ContentType 'application/json' -Body $preview
```

**Verify:** A successful response has a Gmail message ID. Check Inbox and Spam, sender, subject and appearance on phone/computer.

This direct preview has no campaign record or campaign-worker retries. If busy/429, wait for availability. If UNKNOWN, investigate rather than repeating it.

### Scenario 4: one customer campaign

**Use case:** Check the campaign path separately from direct sending.

```powershell
$one = New-HoneyCampaign -Label 'one-customer' -Recipients @($customers[0])
$oneResult = Wait-HoneyCampaign -Id $one.campaignId
Show-HoneyCampaign -Id $one.campaignId
```

**Verify:** COMPLETED; total 1, sent 1; queued/sending/failed/unknown zero. One message with this label appears in the recipient inbox. The previous preview was a different intentional message.

### Scenario 5: five customer announcements

**Use case:** Each customer should receive the announcement privately.

```powershell
$five = New-HoneyCampaign -Label 'five-customers'
Show-HoneyCampaign -Id $five.campaignId
$fiveResult = Wait-HoneyCampaign -Id $five.campaignId
Show-HoneyCampaign -Id $five.campaignId
```

**Verify:** Total 5, sent 5, COMPLETED. Each controlled address receives one message with this label; its To field contains that individual recipient, not the whole list. Everyone gets the same subject/content; names are not automatically personalized.

### Scenario 6: schedule for later

**Use case:** Prepare a honey announcement ahead of its release time.

```powershell
$scheduled = New-HoneyCampaign -Label 'scheduled' -DelayMinutes 2
Show-HoneyCampaign -Id $scheduled.campaignId
$scheduledResult = Wait-HoneyCampaign -Id $scheduled.campaignId -TimeoutSeconds 240
```

**Verify:** Before scheduledAt, all five are queued and no matching messages arrive. After it, processing starts and can complete. The developer explains UTC versus local time. The schedule is the earliest eligible start, not simultaneous receipt for everyone.

### Scenario 7: pause before sending and resume

**Use case:** Temporarily hold the announcement.

```powershell
$paused = New-HoneyCampaign -Label 'pause-before-start' -DelayMinutes 2
Invoke-RestMethod -Method Post "$baseUrl/campaigns/$($paused.campaignId)/pause"
Show-HoneyCampaign -Id $paused.campaignId
```

Wait past its two-minute schedule, inspect, then resume:

```powershell
Show-HoneyCampaign -Id $paused.campaignId
Invoke-RestMethod -Method Post "$baseUrl/campaigns/$($paused.campaignId)/resume"
$pausedResult = Wait-HoneyCampaign -Id $paused.campaignId
```

**Verify:** While paused: PAUSED, sent 0, queued 5, no matching messages even after scheduled time. After resume, work continues. Resuming before scheduled time preserves the original schedule.

### Scenario 8: pause during sending

**Use case:** Stop further attempts after some customers have been contacted.

**Steps:** Stop Terminal B with Ctrl+C. Set a longer interval and restart there:

```powershell
$env:MAILBOX_SEND_INTERVAL_MS = '15000'
npm run start:worker
```

With no other active campaign, in Terminal C:

```powershell
$midPause = New-HoneyCampaign -Label 'pause-midway'
Show-HoneyCampaign -Id $midPause.campaignId
```

Check frequently. Once at least one is SENT and others are queued:

```powershell
Invoke-RestMethod -Method Post "$baseUrl/campaigns/$($midPause.campaignId)/pause"
Show-HoneyCampaign -Id $midPause.campaignId
```

Wait about 30 seconds, inspect and resume:

```powershell
Show-HoneyCampaign -Id $midPause.campaignId
Invoke-RestMethod -Method Post "$baseUrl/campaigns/$($midPause.campaignId)/resume"
$midPauseResult = Wait-HoneyCampaign -Id $midPause.campaignId -TimeoutSeconds 180
```

**Verify:** No new attempts are admitted after pause. An already-admitted attempt may still finish, so sent can increase before settling. SENT remains SENT; waiting recipients do not become FAILED. Resume sends remaining eligible work.

After completion, stop Terminal B, restore interval to `5000`, and restart. Use the simulated pause-race test for an exact concurrency check; human timing cannot prove the boundary.

### Scenario 9: two campaigns share the honey sender

**Use case:** A batch announcement and a shop update share one account's sending pace.

```powershell
$batchA = New-HoneyCampaign -Label 'shared-A' -Recipients @($customers[0],$customers[1])
$batchB = New-HoneyCampaign -Label 'shared-B' -Recipients @($customers[2],$customers[3])
$aResult = Wait-HoneyCampaign -Id $batchA.campaignId
$bResult = Wait-HoneyCampaign -Id $batchB.campaignId
Show-HoneyCampaign -Id $batchA.campaignId
Show-HoneyCampaign -Id $batchB.campaignId
```

**Verify:** Both complete with two SENT each. Do not require A to finish before B starts; that order is not promised. Receipt times provide a rough observation, not exact proof of attempt spacing/non-overlap. Use the automated shared-mailbox test below for precise verification.

### Scenario 10: retail and wholesale send independently

**Use case:** Separate honey departments use different Gmail accounts.

Connect a SECOND dedicated Gmail account using scenario 2, then set its distinct mailbox ID:

```powershell
$secondMailboxId = 'PASTE_SECOND_SENDER_MAILBOX_ID'
$retail = New-HoneyCampaign -Label 'retail' -SenderId $mailboxId -Recipients @($customers[0],$customers[1])
$wholesale = New-HoneyCampaign -Label 'wholesale' -SenderId $secondMailboxId -Recipients @($customers[2],$customers[3])
$retailResult = Wait-HoneyCampaign -Id $retail.campaignId
$wholesaleResult = Wait-HoneyCampaign -Id $wholesale.campaignId
```

**Verify:** Correct sender per campaign and both complete. They can work independently, but Gmail receipt times may not visibly demonstrate overlap. The automated concurrency test proves simultaneous submissions are possible. Use genuinely different Gmail accounts; duplicate connections to one physical account are a production limitation.

### Scenario 11: worker offline when work is created

**Use case:** Your announcement waits until the background process returns.

Stop only Terminal B with Ctrl+C; leave API running. In Terminal C:

```powershell
$offline = New-HoneyCampaign -Label 'worker-offline' -Recipients @($customers[0])
Show-HoneyCampaign -Id $offline.campaignId
```

Wait briefly, check there is no matching email, then restart Terminal B with `npm run start:worker`. In Terminal C:

```powershell
$offlineResult = Wait-HoneyCampaign -Id $offline.campaignId
```

**Verify:** Work is accepted and remains queued while the worker is stopped, then can complete after restart. This proves waiting-work persistence, not recovery from an abrupt crash during submission.

### Scenario 12: graceful worker restart during progress

**Use case:** Restart the sender without losing the remaining announcement work.

Use the longer 15-second interval from scenario 8. In Terminal C:

```powershell
$restart = New-HoneyCampaign -Label 'graceful-restart'
Show-HoneyCampaign -Id $restart.campaignId
```

After one recipient is SENT, stop Terminal B with Ctrl+C and let shutdown finish. Record counts, restart with the SAME honey-demo database/Redis, then:

```powershell
$restartResult = Wait-HoneyCampaign -Id $restart.campaignId -TimeoutSeconds 180
Show-HoneyCampaign -Id $restart.campaignId
```

**Verify:** Recorded SENT recipients stay SENT, remaining eligible work continues, and inboxes do not receive repeat messages for completed recipients. Restore five-second pacing afterward. Ctrl+C is graceful; the simulated process-death test covers an abrupt crash.

### Scenario 13: customer reply recorded

**Use case:** A customer replies, "Please reserve two jars."

**Prerequisite:** Google Pub/Sub, Gmail watching and a public HTTPS tunnel to the local API must be configured. Localhost alone cannot receive Google's remote push.

Developer steps:

1. Prepare the Pub/Sub topic named by GOOGLE_PUBSUB_TOPIC with permission for Gmail's publishing service.
2. Configure a push subscription to the tunnel's HTTPS URL plus `/webhooks/google/pubsub`.
3. Confirm a Gmail watch exists for the connected sender: inspect the watch job/mailbox watchExpiration. Resolve configuration failures before testing.
4. Keep API, worker and tunnel running. See [local setup](local-setup.md).

Owner steps:

1. Use the successful email from scenario 4 or send a fresh one-customer campaign.
2. From the recipient inbox, click Reply on that exact email, and send your response. Do not compose an unrelated email with the same subject.
3. After notification processing, inspect:

```powershell
$replyView = Invoke-RestMethod "$baseUrl/campaigns/$($one.campaignId)"
$replyView.recipients | Select-Object email, status, replied, repliedAt, replyMessageId
```

**Verify:** Matching recipient has replied=true, reply timestamp/ID, and remains SENT. A reply does not create a honey order or automatic response.

If Google/tunnel setup is unavailable, record BLOCKED, not PASS. Public webhook authentication is currently missing; this is a controlled developer test, not a production deployment.

## 5. Simulated local reliability scenarios

In a separate Terminal D:

```powershell
Set-Location 'D:\Realm of AI\Platform\email-automation-service-starter'
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:27017'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6381'
```

These tests use random databases and Redis prefixes and mocked Gmail. They do not use honey-demo customer records or send mail. A name-filter command runs the selected tests; other tests may show skipped. Selected tests must pass. No real Google failure is being induced.

### Scenario 14: failure before submission can retry

**Use case:** Credentials cannot be prepared initially; Gmail has received no send request.

```powershell
npx --no-install tsx --test --test-name-pattern="^pre-send failure retries" tests/delivery.test.ts
```

**Verify:** Two preparation failures followed by one successful submission; stable message ID reused; history RETRY, RETRY, SENT. The selected test passes.

### Scenario 15: safe retry budget exhausted

**Use case:** The announcement cannot prepare after all allowed attempts.

```powershell
npx --no-install tsx --test --test-name-pattern="^retry exhaustion" tests/delivery.test.ts
```

**Verify:** Recipient/campaign becomes FAILED and attempts stop. The suite uses three attempts for speed; normal application default is five TOTAL attempts, including the first.

### Scenario 16: Gmail asks the sender to wait

**Use case:** An explicit quota rejection includes Retry-After.

```powershell
npx --no-install tsx --test --test-name-pattern="^explicit Gmail rate rejection" tests/delivery.test.ts
```

**Verify:** Mock 429 response requests one second of waiting, next attempt begins no earlier, and the retry succeeds. Do not provoke this by flooding real Gmail.

### Scenario 17: outcome uncertain after submission

**Use case:** Avoid repeating an announcement Gmail may already have accepted.

```powershell
npx --no-install tsx --test --test-name-pattern="^ambiguous Gmail response" tests/delivery.test.ts
```

**Verify:** One mock submission, recipient UNKNOWN, sent zero, mailbox persistently blocked; recovery does not resend. The all-UNKNOWN single-recipient campaign is PARTIALLY_FAILED.

### Scenario 18: restart after interrupted preparation

**Use case:** Worker stopped before Gmail submission was possible.

```powershell
npx --no-install tsx --test --test-name-pattern="^restart recovers stale preparation" tests/delivery.test.ts
```

**Verify:** Stale preparation is recovered as RETRY, then SENT. This test constructs an interrupted preparation record; it does not kill a real request.

### Scenario 19: actual test process death during submission

**Use case:** Worker disappears where the customer might already have been contacted.

```powershell
npx --no-install tsx --test --test-name-pattern="^actual worker process death" tests/delivery.test.ts
```

**Verify:** A separate test worker process is started and killed; Gmail is mocked. Recovery produces UNKNOWN and a blocked mailbox rather than automatic resend.

### Scenario 20: partial campaign failure

**Use case:** One honey announcement succeeds while another is definitely rejected.

```powershell
npx --no-install tsx --test --test-name-pattern="^mixed success" tests/delivery.test.ts
```

**Verify:** PARTIALLY_FAILED, one SENT and one FAILED. A permanent mocked rejection does not keep retrying. A nonexistent address is not a reliable substitute: Gmail can accept it and later bounce it, and this application does not track bounces.

### Scenario 21: exact mailbox pacing and concurrent mailboxes

**Use case:** Two campaigns share one sender's pace, while different senders can work simultaneously.

```powershell
npx --no-install tsx --test --test-name-pattern="^five recipients and two campaigns|^different mailboxes" tests/delivery.test.ts
```

**Verify:** Both selected tests pass. The first processes seven recipients across two campaigns with two worker instances, checking no overlap and minimum spacing. The second proves simultaneous submissions for separate mailboxes.

### Scenario 22: exact pause boundary

**Use case:** Waiting customers stay queued while an admitted attempt may finish.

```powershell
npx --no-install tsx --test --test-name-pattern="^pause prevents admissions|^pause racing" tests/delivery.test.ts
```

**Verify:** Pause prevents admissions, resume processes remaining work, and an already-admitted attempt can finish while paused without changing waiting recipients to failures.

### Scenario 23: reconcile without resending

**Use case:** Check Gmail evidence before resolving an uncertain honey announcement.

```powershell
npx --no-install tsx --test --test-name-pattern="^startup restores legacy uncertainty|^empty reconciliation" tests/delivery.test.ts
```

**Verify:** Read-only lookup does not change state. One mocked match can become SENT after quiescence confirmation. No match stays UNKNOWN; explicit mailbox clearance lets other work proceed but never authorizes resending the uncertain recipient. Startup respects explicit clearance.

For an actual UNKNOWN record, the developer sets the honey-demo environment and previews a read-only search:

```powershell
$env:MONGODB_DB = 'honey_demo'
$env:REDIS_URL = 'redis://127.0.0.1:6381'
npm run reconcile -- 'PASTE_UNKNOWN_RECIPIENT_ID'
```

Do not deliberately create a real uncertain send. Applying reconciliation requires stopping all senders and establishing remote request settlement. Process exit or timeout alone is not proof. Follow [the complete procedure](delivery-reliability.md#reconcile-unknown-without-resending) before using its confirmation option.

### Scenario 24: internal consistency and ownership protection

**Use case:** Accurate progress and duplicate-claim protection despite concurrency and interrupted writes.

```powershell
npx --no-install tsx --test --test-name-pattern="^expired preparation lease|^concurrent state transitions|^a crash between authoritative|^error details|^legacy REPLIED" tests/delivery.test.ts
```

**Verify:** All five selected tests pass: owner fencing, atomic counts/duplicate claims, mirror-write repair, safe error details, and conservative old-record handling. The old records are synthetic isolated test data, not your existing business data.

## 6. Bad requests and current feature boundaries

Run these in Terminal C. Expected HTTP errors may appear as PowerShell error messages. They are successful validation checks if they match the expected status and create no sendable campaign.

### Scenario 25: duplicate recipient rejected

**Use case:** Avoid two copies caused by one duplicated list entry.

```powershell
New-HoneyCampaign -Label 'duplicate-rejected' -Recipients @($customers[0],$customers[0])
```

**Verify:** HTTP 400, no campaign ID, no matching emails. Addresses are compared ignoring letter case.

### Scenario 26: malformed address rejected

**Use case:** Catch clearly invalid customer data.

```powershell
New-HoneyCampaign -Label 'invalid-address' -Recipients @('not-an-email')
```

**Verify:** HTTP 400, no sendable campaign. Syntax validation does not prove a real person owns a valid-looking address.

### Scenario 27: empty list and over-limit list rejected

**Use case:** Campaigns need between 1 and 1,000 distinct addresses.

```powershell
New-HoneyCampaign -Label 'empty-list' -Recipients @()
$tooMany = @(1..1001 | ForEach-Object { "local-test-$($_)@example.com" })
New-HoneyCampaign -Label 'over-limit' -Recipients $tooMany
```

**Verify:** Both HTTP 400, no campaign IDs. The over-limit placeholder list is rejected before sending.

### Scenario 28: missing sender rejected

**Use case:** A wrong mailbox ID must not choose some other sender.

```powershell
New-HoneyCampaign -Label 'missing-mailbox' -SenderId '000000000000000000000000'
```

**Verify:** HTTP 404 if this ID is absent; no campaign ID. A malformed ID such as `bad-id` produces HTTP 400.

### Scenario 29: completed campaign cannot be paused

**Use case:** Understand that pause cannot recall delivered submissions.

```powershell
Invoke-RestMethod -Method Post "$baseUrl/campaigns/$($one.campaignId)/pause"
```

**Verify:** After scenario 4 completes, HTTP 409, recipient remains SENT, no recalled email.

### Scenario 30: non-paused campaign cannot be resumed

**Use case:** A mistaken resume must not create extra sending.

```powershell
Invoke-RestMethod -Method Post "$baseUrl/campaigns/$($one.campaignId)/resume"
```

**Verify:** HTTP 409 after scenario 4; completed record unchanged and no additional email.

### Scenario 31: names are stored, not automatically inserted

**Use case:** Find out whether the app generates "Hello Priya" from a saved name.

```powershell
$nameBody = @{
    tenantId = $tenantId
    mailboxId = $mailboxId
    subject = '[LOCAL TEST: name-boundary] Golden Hive Honey'
    html = '<p>Hello {{name}},</p><p>Our honey batch is ready.</p>'
    recipients = @(@{ email = $customers[0]; name = 'Priya' })
} | ConvertTo-Json -Depth 5
$nameTest = Invoke-RestMethod -Method Post "$baseUrl/campaigns" `
    -ContentType 'application/json' -Body $nameBody
$nameResult = Wait-HoneyCampaign -Id $nameTest.campaignId
```

**Verify:** Record stores Priya, but received email contains literal `{{name}}`. Confirm this current limitation and put personalization on the development backlog if required.

## 7. Complete automated verification

In Terminal D with the TEST infrastructure settings from section 5:

```powershell
npm run typecheck
npm run build
npm test
```

**Verify:** Type checking and compilation succeed. This version has 19 automated tests: expect 19 passed and zero failed. Future versions may add tests. All test Gmail calls are mocked.

These checks complement, rather than replace, inspecting real sender identity, layout, receipt, Google permissions and the conditional reply-notification workflow.

## 8. Business acceptance record

| Scenario | Expected | Actual evidence | Decision |
| --- | --- | --- | --- |
| Five-customer announcement | Five separate accepted messages | Campaign ID, counts, inbox checks | PASS / FAIL / BLOCKED |
| Pause/resume | Waiting work held; SENT preserved | Before/after counts | PASS / FAIL / BLOCKED |
| Uncertainty simulation | UNKNOWN, no automatic resend | Selected test output | PASS / FAIL / BLOCKED |
| Reply recorded | Matching reply flag, status still SENT | Reply and API record | PASS / FAIL / BLOCKED |

Keep labels and campaign IDs. PASS means expected behavior was observed, not just that a command ran. Missing Pub/Sub setup or a second sender is BLOCKED. Wrong results are FAIL and need investigation.

SENT means Gmail accepted the email or reconciliation found it; it is not proof of inbox delivery, opening, clicking or a honey order. Check the controlled inboxes separately.

## 9. End the session

1. Finish or pause unfinished demo campaigns. An already-admitted attempt may still finish.
2. Stop worker Terminal B with Ctrl+C and wait for shutdown.
3. Stop API Terminal A with Ctrl+C.
4. Optionally stop the dedicated Redis container:

```powershell
docker stop honey-demo-redis
```

Keep MongoDB records and the named Redis volume for inspection. Do not delete volumes or run FLUSHDB/FLUSHALL. At the next session, inspect old campaigns: restarting can continue queued work you left eligible.

## 10. Production boundary

Passing this workbook confirms local behavior, not production readiness. Authenticated tenant access, validated public Google webhooks, secured infrastructure, unsubscribe handling for business campaigns, and further operations still require assessment and implementation.

See [application capabilities](application-capabilities.md) for current features and [delivery reliability](delivery-reliability.md) for guarantees, recovery conditions and risks.
