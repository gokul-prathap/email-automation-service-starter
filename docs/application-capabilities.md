# What this email application can do

A beginner-friendly guide to the features currently implemented in this repository.

## 1. What is this application?

This application lets you connect a Gmail account, send emails to a list of people, schedule those emails, and check their progress.

It is currently a **backend service**. That means it runs behind the scenes and receives instructions through an API. There is no visual dashboard, campaign editor, or customer login screen yet. You can use PowerShell, Postman, or a future website to communicate with it.

**Example:** A training centre wants to send the same workshop reminder to 50 registered students. It connects its Gmail account, creates one campaign containing those 50 email addresses, and lets the background worker send each email separately.

The recipient list, email content, schedule, and progress are stored so the application can continue working after a restart, subject to the recovery rules explained below.

## 2. A few words you will see

| Word | Simple meaning | Example |
| --- | --- | --- |
| Mailbox | A Gmail account connected to the application | The Gmail account used by your training centre |
| Recipient | A person who will receive an email | A student with an email address |
| Campaign | One subject and email message sent individually to a list of recipients | Workshop reminder for 50 students |
| Tenant | A label used to group one customer's data | `training-centre` or `book-shop` |
| API | A way to give the application instructions and get information back | Ask it to create or pause a campaign |
| Worker | The background process that carries out queued work | Sends campaign emails when their scheduled time arrives |
| Queue | A waiting list of work | Emails waiting for their turn to send |
| Reconciliation | Checking Gmail to find out what happened to an uncertain send | Look for a message in Gmail Sent before making a decision |

A tenant label is currently a way to organize records. It is **not a secure customer account or access boundary** yet.

## 3. Connect a Gmail account

You can connect a Gmail account through Google's sign-in and permission screen. The application asks for permission to send emails and read mailbox activity for reply tracking.

After connection, the application stores the mailbox details and an encrypted credential that lets it request access later. Your Gmail password is not entered into this application. Mailbox-list responses exclude the stored refresh credential.

**Use case:** A small business connects the Gmail account it uses for customer communication. Future campaigns can use that connected account as the sender.

You can connect multiple Gmail accounts and choose one account for each campaign. Two campaigns using the same connected mailbox share its sending pace.

**Current boundary:** Gmail is the implemented provider. There is no Outlook, Yahoo, or general SMTP connection flow.

## 4. Send one test email

The direct test endpoint sends one email from a connected Gmail account. You provide the destination address, subject, and message content.

**Use case:** Before creating a workshop campaign, send the reminder to your own email address to check how it looks.

A test send uses the same mailbox coordination as campaign sending. If the mailbox is already busy, cooling down, or blocked by an uncertain send, the request may be refused until that condition is resolved.

A direct test email is **not a campaign**: it does not create a campaign progress record or receive the campaign worker's automatic retries. If its outcome is uncertain, do not simply repeat the request.

## 5. Send a campaign to a list of people

You supply:

- A tenant label and a connected mailbox ID.
- One subject and one email body.
- A list of recipient email addresses, with optional names.
- An optional scheduled time.

The application creates one campaign and one tracking record for each recipient. The worker sends a separate email to each person. Each message addresses that individual recipient; it is not a single message containing everyone's address.

**Use case:** A book shop wants to send a notice about a reading event to 30 people who registered. It creates one campaign with the event details and their 30 email addresses.

**Current limits:** A new campaign accepts between 1 and 1,000 distinct recipient email addresses. Duplicate addresses in a campaign are rejected, ignoring differences in letter case. The same address can appear in a different campaign.

**Content support:** You can provide HTML for simple formatted messages such as headings, paragraphs, and links. The application also generates a plain-text alternative. Everyone in the campaign receives the same subject and content. Optional recipient names are stored, but the application does not automatically replace text such as `Hello {{name}}`.

There is no attachment input, template builder, CSV upload endpoint, or automatic contact-list management.

## 6. Send now or schedule for later

If you leave out the schedule, the campaign becomes eligible to send immediately. You can also specify a future date and time.

**Use case:** Create a workshop reminder in advance and schedule it for 9:00 AM on the workshop day. You should supply an ISO date/time with an explicit timezone or UTC offset so the intended time is clear.

The scheduled time means **the campaign may start sending at that time**. It does not mean every recipient will receive a message at exactly that second. The worker must be running, the mailbox must be available, and pacing or retries can spread the work over time.

The application does not currently offer recurring schedules or an endpoint for editing a campaign's schedule after creation.

## 7. Space out emails from each mailbox

The application prevents overlapping send attempts from the same mailbox when all senders use the shared coordination mechanism and Redis retains its state.

By default, it waits at least five seconds after one attempt finishes before another attempt from that mailbox can begin. This interval is configurable. Actual spacing may be longer because of request time, pauses, retries, or mailbox blocking.

**Use case:** Two staff members create different campaigns that both use the same connected Gmail mailbox. Their campaigns share that mailbox's sending pace rather than each sending independently.

Different mailbox IDs can send concurrently.

**Use case:** A training centre and a book shop use separate connected mailboxes. The training centre's messages do not have to wait for the book shop's normal sending turns.

This pacing does not remove Gmail account or service quotas and does not guarantee that messages avoid spam filtering. Coordination is by connected mailbox ID; connecting the same physical Gmail account under different tenant labels needs additional safeguards before production use.

## 8. Check progress

You can retrieve a campaign by its ID and inspect both an overall summary and individual recipient records.

| Count | What it means |
| --- | --- |
| Total | Number of recipients in this campaign |
| Queued | Waiting to send, including recipients waiting for a safe retry |
| Sending | Currently admitted for preparation or submission |
| Sent | Gmail returned a successful submission ID, or a later reconciliation confirmed the message |
| Failed | Processing ended with a definite failure |
| Unknown | The application cannot safely determine whether Gmail accepted the message |

**Example:** A five-person campaign might show:

```text
Total:    5
Queued:   2
Sending:  1
Sent:     2
Failed:   0
Unknown:  0
```

This means two emails were accepted by Gmail, one is being processed, and two remain waiting.

**Important:** SENT means Gmail accepted the message for sending. It does not prove final inbox delivery, that the recipient opened it, or that a link was clicked. Those tracking features are not implemented.

## 9. Understand the campaign's overall status

| Status | Meaning | Example |
| --- | --- | --- |
| SCHEDULED | Waiting for sending work to begin | A future campaign, or a newly created campaign waiting for its first attempt |
| RUNNING | Processing has begun and some work remains | Two recipients are SENT and three are still waiting |
| COMPLETED | Every recipient is SENT | All five messages were accepted by Gmail |
| FAILED | Every recipient ended in a definite failure | All five recipients exhausted safe retries or received permanent rejections |
| PARTIALLY_FAILED | Every recipient has a final recorded outcome, with failures, uncertainty, or a mixture | Four SENT and one FAILED; four SENT and one UNKNOWN; or all UNKNOWN |
| PAUSED | New campaign attempts are stopped until resume | You temporarily stop a reminder campaign |

A campaign with UNKNOWN recipients and other recipients still waiting can remain RUNNING because the uncertain outcome blocks that mailbox. It is not finished while queued work remains.

If the last admitted email finishes while the campaign is PAUSED, its overall status stays PAUSED. Resuming recalculates the final status; it does not resend completed emails.

## 10. Pause and resume a campaign

You can pause a campaign that is scheduled or running. Pause prevents the worker from admitting additional attempts for that campaign.

**Use case:** You realize you need to review a recipient list while a campaign is running. Pause it, inspect the records, and resume if it should continue.

An attempt admitted before the pause may still finish. Already-sent emails cannot be recalled. Pausing does not mark waiting recipients as failed and does not cancel work from other campaigns using the same mailbox.

Resume lets the remaining eligible recipients continue. It does not resend SENT recipients or automatically retry UNKNOWN recipients.

**Current boundary:** Pause is not an editing feature. The application has no endpoint for changing an existing campaign's content or recipient list. There is also no cancellation or email-recall endpoint.

## 11. Retry temporary failures safely

Some failures can be retried without risking a duplicate email.

The campaign worker retries failures that definitely occurred before submission, and explicit retryable Gmail quota rejections. It waits progressively longer between safe retries and respects a Retry-After value when Gmail provides one.

By default, the campaign attempt budget is five attempts in total, including the first attempt. An attempt can fail during preparation before a message is submitted. Permanent rejections can stop processing earlier.

**Use case:** A temporary credential-refresh problem prevents the worker from reaching the Gmail send request. It records the failure and schedules a safe retry. If a later attempt succeeds, the recipient becomes SENT.

If the safe attempt budget is exhausted, that recipient becomes FAILED. The application retains a bounded history of attempts with useful error codes and timestamps.

This does not mean every error will be retried: uncertainty after submission has a different treatment.

## 12. Handle an uncertain send without blindly repeating it

Sometimes the application sends a request to Gmail but loses the response. Gmail might already have accepted the message.

**Use case:** A message is submitted just before the network connection drops. The application cannot tell whether the customer will receive that message. Sending it again immediately could create a duplicate.

The application marks the recipient UNKNOWN and blocks further attempts from that mailbox. This block also affects other campaigns and test sends using that mailbox. It does not expire automatically.

A reconciliation command can search Gmail Sent using the message's stable identifier. Its default mode only reports what it finds; it never sends mail.

An operator can apply reconciliation only after stopping all senders and establishing that outstanding requests have settled. With that explicitly confirmed:

- Exactly one matching Gmail message can change UNKNOWN to SENT.
- No match leaves the recipient UNKNOWN. It can allow other recipients to proceed after the mailbox block is explicitly cleared, but it never authorizes resending that uncertain message.
- Multiple matches require manual investigation.

An absent search result is not proof that Gmail never accepted the email. See [the reconciliation procedure](delivery-reliability.md#reconcile-unknown-without-resending) for the operational commands and conditions. Direct test sends have a separate manual investigation procedure because they have no campaign recipient record.

The application reduces duplicate-send risk; it cannot promise exactly one remote delivery under every failure condition.

## 13. Recover after a worker restart

The application checks stored campaign state to repair missing jobs and stale recipient mirrors. It also checks recipients that were marked SENDING when a worker stopped.

**Use case:** Your computer restarts halfway through a campaign. After you restart the infrastructure and application, recipients already recorded as SENT stay SENT. Eligible waiting recipients can continue.

If the interrupted attempt was definitely still preparing, it may safely retry after recovery. If submission might have begun, it becomes UNKNOWN and requires the checks described above.

Recovery is periodic and may take time; it is not an immediate guarantee. Safe continuation depends on retaining MongoDB and Redis data and using the updated API and worker together. Redis data loss requires operator intervention.

## 14. Record replies when Google notifications are configured

The application includes a Google Pub/Sub webhook and a worker that reads Gmail changes and attempts to match replies to campaign messages.

When it finds a matching reply for a SENT recipient, it records reply information such as a reply flag and timestamp. The recipient stays SENT because reply tracking is separate from submission progress.

**Use case:** A student replies to a workshop invitation. If Google Pub/Sub and Gmail mailbox watching are correctly configured and the reply contains matching message-reference headers, the application can mark that recipient as having replied.

This requires a reachable public HTTPS webhook, the relevant Google configuration, and running workers. Normal localhost alone cannot receive Google's remote push requests. A developer can use a tunnel for local testing.

**Current boundaries:** This is basic reply detection, not a full inbox interface. The application does not summarize replies, automatically respond, or start follow-up campaigns. It does not currently provide robust recovery for expired Gmail history. Public webhook authentication still needs implementation before production use.

## 15. Organize data for different customers

Mailbox and campaign records include tenant identifiers. Campaign creation checks that the chosen connected mailbox belongs to the supplied tenant label.

**Use case:** Use `training-centre` to organize one organization's records and `book-shop` for another organization's records.

However, the application does not authenticate who supplied those labels or enforce secure ownership on every endpoint. Someone who can reach the API may be able to access or control records they should not be allowed to use.

Treat this as a development foundation for multiple customers, not a finished secure multi-tenant product.

## 16. A complete example: workshop reminders

**Goal:** Send a reminder to five students who have registered for a workshop.

1. Start MongoDB, Redis, the API, and the background worker.
2. Connect the training centre's Gmail account through Google sign-in.
3. Retrieve the connected mailbox ID.
4. Optionally send one test email to your own address and inspect it.
5. Create a campaign with the five students' email addresses, one subject, and the reminder content.
6. Choose immediate sending or supply a future time.
7. Check the campaign ID to see progress.
8. Pause if you need to stop new attempts; resume when appropriate.
9. Investigate FAILED or UNKNOWN recipients if they appear.
10. If reply notifications are configured, inspect recipient records for detected replies.

An example email:

```text
Subject: Reminder: your workshop starts tomorrow

Hello,

Thank you for registering for our workshop.
Please arrive by 9:45 AM and bring your laptop.

Regards,
The training team
```

Every student receives the same message, addressed separately. Their stored names do not automatically personalize the greeting.

If all five recipients become SENT, the campaign becomes COMPLETED. If four become SENT and one receives a permanent rejection, it becomes PARTIALLY_FAILED. If an uncertain send blocks the mailbox before the remaining emails are processed, investigate it before expecting the campaign to finish.

## 17. Other suitable use cases

| Use case | How to use the existing features | Current boundary |
| --- | --- | --- |
| Event reminders | Send one campaign to people registered for an event | No built-in event registration system |
| Customer announcements | Send the same announcement to a supplied list | No contact import or unsubscribe management |
| Small team notices | Use a connected Gmail account to send individual notices | No role-based access or team dashboard |
| A manually prepared follow-up | Create a new campaign containing the people you choose | No automatic follow-up sequence or automatic exclusion of people who replied |
| Scheduled internal reminders | Supply a future time for a one-off campaign | No recurring schedule |
| Test an email integration | Connect Gmail and use the direct test endpoint | Direct sends are real emails, not simulated tests |

These are examples of what you can build with the current API. They do not imply that the application has separate screens or dedicated workflows for each use case.

## 18. Beginner walkthrough using PowerShell

The application must already have its Google and local environment configuration completed. Follow [local setup](local-setup.md) first and preserve your existing `.env` file.

### Start the service

From the repository root:

```powershell
docker compose up -d
npm run dev
```

Keep this terminal running. Use another PowerShell terminal for the requests below.

### Check that the API responds

```powershell
Invoke-RestMethod 'http://localhost:3001/health'
```

This confirms that the API responds; it does not verify that Gmail sending or reply notifications are configured correctly.

### Connect Gmail

Open this address in your browser and complete Google's sign-in and permission process:

```text
http://localhost:3001/auth/google/start?tenantId=training-centre
```

List the connected mailboxes:

```powershell
Invoke-RestMethod 'http://localhost:3001/mailboxes?tenantId=training-centre'
```

Copy the `_id` of the mailbox you want to use.

### Create a small campaign

The following request schedules REAL email sending when the worker is running. Replace both example addresses with addresses you intend to contact, and replace the mailbox ID. The example.com addresses below are placeholders.

```powershell
$mailboxId = 'PASTE_CONNECTED_MAILBOX_ID'
$body = @{
    tenantId = 'training-centre'
    mailboxId = $mailboxId
    subject = 'Workshop reminder'
    html = '<p>Hello,</p><p>Please arrive by 9:45 AM and bring your laptop.</p>'
    recipients = @(
        @{ email = 'student1@example.com'; name = 'Student One' }
        @{ email = 'student2@example.com'; name = 'Student Two' }
    )
} | ConvertTo-Json -Depth 5

$result = Invoke-RestMethod -Method Post `
    -Uri 'http://localhost:3001/campaigns' `
    -ContentType 'application/json' `
    -Body $body

$campaignId = $result.campaignId
$result
```

The result supplies the campaign ID and number queued. Queued means accepted for processing, not already sent.

To schedule for later, add `scheduledAt` to the body before converting it to JSON. For example, this schedules eligibility for 30 minutes from now:

```powershell
scheduledAt = (Get-Date).AddMinutes(30).ToUniversalTime().ToString('o')
```

### Inspect, pause, and resume

```powershell
$progress = Invoke-RestMethod "http://localhost:3001/campaigns/$campaignId"
$progress.campaign.status
$progress.counts
$progress.recipients | Select-Object email, status, attempts, replied

Invoke-RestMethod -Method Post "http://localhost:3001/campaigns/$campaignId/pause"
Invoke-RestMethod -Method Post "http://localhost:3001/campaigns/$campaignId/resume"
```

A small immediate campaign may finish before you pause it. Pausing an already-finished campaign returns a conflict response. For a pause demonstration, create a future-scheduled campaign and pause it before its start time. Resuming that campaign preserves its original scheduled time.

### Run automated verification without sending real mail

With MongoDB and Redis running:

```powershell
npm run typecheck
npm run build
npm test
```

Automated tests use mocked Gmail calls and isolated test data. Campaign API requests and `/test/send` requests use real Gmail when configured; they are different from `npm test`.

## 19. Features that are not currently implemented

| Feature | Current state |
| --- | --- |
| Visual dashboard | No campaign or mailbox management interface |
| Secure customer login and tenant permissions | Not implemented |
| Verified public Google webhook requests | Not implemented |
| Personalization with recipient variables | Names can be stored, but templates are not expanded |
| Attachments | No attachment input |
| CSV uploads and contact management | No dedicated import or contact-list endpoints |
| Automatic follow-up sequences | Not implemented |
| Open, click, bounce, and inbox-delivery tracking | Not implemented |
| Unsubscribe management | Not implemented |
| Editing or cancelling an existing campaign | No endpoints for these operations |
| Recurring campaigns | Not implemented |
| Other email providers | Gmail only |
| Campaign listing/search and aggregate reporting | Individual campaign reads exist; no dedicated listing/reporting endpoints |
| Full inbox or conversation management | Basic reply detection only |
| Guaranteed exactly-once remote delivery | Cannot be guaranteed for uncertain Gmail outcomes |

## 20. What it is ready for today

The application is suitable for local development, integration experiments, and testing controlled Gmail campaign workflows. Its implemented strengths are individual campaign sends, scheduling, progress tracking, pause/resume, coordinated mailbox pacing, safe retries, and conservative handling of uncertain outcomes.

It needs authenticated tenant access, verified public webhooks, secured infrastructure, and further operational safeguards before use as a publicly accessible customer-facing service.

For technical details, configuration, recovery commands, and production limits, read [delivery reliability](delivery-reliability.md). For initial installation and Google connection setup, read [local setup](local-setup.md).
