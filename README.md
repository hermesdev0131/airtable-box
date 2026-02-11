# Airtable → Box Webhook Automation

Serverless API (Node.js + Express on Vercel) that receives webhooks from Airtable Automations, downloads file attachments, uploads them to Box, and writes the Box metadata back to Airtable.

## Architecture

```
Airtable Form → Airtable Automation → POST /api/webhook → Vercel Function
                                                            ├── Fetch record from Airtable
                                                            ├── Check idempotency (skip if already done)
                                                            ├── Set status → "Processing"
                                                            ├── For each attachment:
                                                            │   ├── Download from Airtable CDN
                                                            │   ├── Upload to Box (subfolder: YYYY-MM)
                                                            │   ├── Create shared link
                                                            │   └── Write intermediate results
                                                            └── Set status → "Uploaded"
```

## Project Structure

```
src/
├── index.ts                 Express app entry point
├── routes/
│   └── webhook.ts           POST /api/webhook + GET /api/health
├── services/
│   ├── airtable.ts          Airtable REST API client
│   ├── box.ts               Box JWT auth + upload + shared links
│   └── idempotency.ts       Duplicate/retry guard using Airtable fields
└── utils/
    ├── logger.ts            Structured JSON logger
    └── validation.ts        Webhook payload validation
```

## Setup

### 1. Prerequisites

- Node.js ≥ 18
- Vercel CLI (`npm i -g vercel`)
- An Airtable base with a table containing these fields:
  - An attachments field (e.g. "Files")
  - A single-select or text field for status (e.g. "Status")
  - A long-text field for error messages (e.g. "ErrorMessage")
  - A long-text field for Box links (e.g. "BoxLinks")
  - A long-text field for Box file IDs (e.g. "BoxFileIds")
- A Box application configured for JWT (Server Authentication)

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

**Airtable:**
- `AIRTABLE_API_KEY` — Personal access token from https://airtable.com/create/tokens
- `AIRTABLE_BASE_ID` — Found in the URL: `https://airtable.com/appXXXXXXXXXXXXXX/...`
- `AIRTABLE_TABLE_NAME` — Table name (e.g. "Submissions")

**Box JWT:**
- Download the JSON config from your Box app's Configuration tab
- Extract `clientID`, `clientSecret`, `enterpriseID`, `appAuth.privateKey`, `appAuth.passphrase`, `appAuth.publicKeyID`
- `BOX_JWT_PRIVATE_KEY` — The full PEM key; use `\n` for newlines in env vars
- `BOX_JWT_PRIVATE_KEY_ID` — The key ID from Box app config (`appAuth.publicKeyID`)
- `BOX_PUBLIC_KEY_ID` — Same as `BOX_JWT_PRIVATE_KEY_ID` (used in JWT header kid)
- `BOX_TARGET_FOLDER_ID` — The Box folder ID to upload into (visible in Box URL)

**Webhook:**
- `WEBHOOK_SECRET` — A random secret string; configure the same value in your Airtable Automation

### 4. Airtable Automation Setup

1. Go to your Airtable base → Automations
2. Create a new automation with trigger: "When a record matches conditions" or "When a form is submitted"
3. Add action: "Run a script" or "Send webhook"
4. Configure the webhook:
   - URL: `https://your-project.vercel.app/api/webhook`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body:
     ```json
     {
       "recordId": "{recordId}",
       "secret": "your-webhook-secret"
     }
     ```
   - Or use header `x-webhook-secret` instead of the body `secret` field

### 5. Box App Authorization

1. In the Box Developer Console, go to your app → Authorization
2. Click "Review and Submit" to get admin approval
3. Your Box admin must authorize the app in Admin Console → Apps → Custom Apps

## Deployment

### Deploy to Vercel

```bash
# Login (first time)
vercel login

# Deploy
vercel

# Set environment variables
vercel env add AIRTABLE_API_KEY
vercel env add AIRTABLE_BASE_ID
# ... (repeat for all env vars)

# Deploy to production
vercel --prod
```

Or set all env vars in the Vercel Dashboard under Project Settings → Environment Variables.

## How to Test Locally

### 1. Start the dev server

```bash
npm run dev
```

### 2. Send a test webhook

```bash
curl -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "recordId": "recABCDEFGHIJKLMN",
    "secret": "your-webhook-secret"
  }'
```

Expected response:

```json
{
  "ok": true,
  "requestId": "uuid-here",
  "recordId": "recABCDEFGHIJKLMN",
  "message": "Processing started"
}
```

### 3. Using the header for authentication

```bash
curl -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your-webhook-secret" \
  -d '{"recordId": "recABCDEFGHIJKLMN"}'
```

### 4. Health check

```bash
curl http://localhost:3000/api/health
```

## Vercel Limits

| Plan       | Max Duration | Payload Limit |
|------------|-------------|---------------|
| Hobby      | 10 seconds  | ~4.5 MB       |
| Pro        | 60 seconds  | ~50 MB        |
| Enterprise | 300 seconds | ~50 MB        |

Files that exceed these limits will cause the function to be killed mid-flight. The idempotency layer preserves partial progress, so a retry will pick up where it left off.

For very large file workflows, consider:
- Vercel Pro or Enterprise plans for longer execution times
- An external queue (e.g. Upstash QStash) to trigger processing outside the webhook response cycle
- Box's chunked upload API for files > 50 MB

## Idempotency & Retry Safety

- The webhook is safe to retry: duplicate calls for the same `recordId` are detected via the Airtable status field
- If status is "Uploaded" → skip (already done)
- If status is "Processing" → skip (another invocation is active)
- Partial uploads are preserved: if 2 of 5 files uploaded before a timeout, the next invocation uploads only the remaining 3
- Each file upload writes intermediate results to Airtable so progress is never lost

## File Naming

Uploaded files follow the convention:

```
YYYY-MM-DD_recXXXXXXXXXXXXXX_original-filename.ext
```

Files are placed in a YYYY-MM subfolder under the configured `BOX_TARGET_FOLDER_ID`.

## Observability

All logs are structured JSON with `requestId` and `recordId` for tracing:

```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "level": "info",
  "requestId": "abc-123",
  "recordId": "recABCDEFGHIJKLMN",
  "message": "Processing attachment 1/3: document.pdf (1234567 bytes)"
}
```

Error details are also written to the Airtable `ErrorMessage` field for visibility without needing log access.
