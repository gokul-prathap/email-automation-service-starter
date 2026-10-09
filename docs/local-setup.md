# Local setup

## 1. Requirements
Node.js 22+, Docker Desktop, Google Cloud project.

## 2. Create env
Copy `.env.example` to `.env`.

PowerShell:
`Copy-Item .env.example .env`

Generate encryption key:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Put it in TOKEN_ENCRYPTION_KEY.

## 3. Start infrastructure
`docker compose up -d`

## 4. Install
`npm install`

## 5. Google OAuth
Enable Gmail API and Cloud Pub/Sub API. Create Google Auth Platform/OAuth consent configuration and an OAuth Web Application client. Add redirect URI:
`http://localhost:3001/auth/google/callback`

Put client ID and secret into `.env`.

## 6. Run
`npm run dev`

API: http://localhost:3001/health

Connect mailbox:
`http://localhost:3001/auth/google/start?tenantId=demo-tenant`

List mailbox:
`http://localhost:3001/mailboxes?tenantId=demo-tenant`

## 7. Test send
PowerShell:
`$b=@{mailboxId="PASTE_ID";to="YOUR_TEST_EMAIL";subject="Test";html="<h1>Hello</h1><p>Gmail API test.</p>"}|ConvertTo-Json`
`Invoke-RestMethod -Method Post -Uri http://localhost:3001/test/send -ContentType "application/json" -Body $b`

## 8. Test campaign
`$b=@{tenantId="demo-tenant";mailboxId="PASTE_ID";subject="Campaign test";html="<p>Hello from worker.</p>";recipients=@(@{email="YOUR_TEST_EMAIL"});scheduledAt=(Get-Date).ToUniversalTime().ToString("o")}|ConvertTo-Json -Depth 5`
`Invoke-RestMethod -Method Post -Uri http://localhost:3001/campaigns -ContentType "application/json" -Body $b`

Pub/Sub push requires a public HTTPS endpoint; localhost cannot receive Google's push directly. Use a tunnel for local reply testing, then point a Pub/Sub push subscription to `/webhooks/google/pubsub`.
