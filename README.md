# Instantly MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes the [Instantly.ai](https://instantly.ai) V2 API as tools, so you can create and manage cold email campaigns from an MCP client like Claude. It runs as a Next.js App Router route and deploys to Vercel.

## What it does

The server holds your Instantly V2 API key on the server side and exposes a small, safe set of tools over the MCP Streamable HTTP transport. The endpoint is unauthenticated, so keep your Vercel URL private; anyone who knows it can act on your Instantly account. Each tool is a plain stateless request to Instantly, so there is no database or session store.

## Tools

| Tool | What it does | Required inputs |
| --- | --- | --- |
| `list_campaigns` | Lists your campaigns with id, name, and status label. | none (optional `limit`, `search`) |
| `get_campaign_analytics` | Returns sent, opens, replies, and bounces for one campaign. | `campaign_id` |
| `create_campaign` | Creates a campaign with a sending schedule and email sequence steps. | `consent_confirmed`, `name`, `sequence_steps` |
| `add_sequence_step` | Appends one email step to an existing campaign's sequence. | `campaign_id`, `subject`, `body` |
| `add_leads_to_campaign` | Adds one or more leads to a campaign. | `consent_confirmed`, `campaign_id`, `leads` |
| `update_lead_status` | Updates a lead's interest status (by email). | `lead_email`, `interest_status` |

### Compliance guardrail

`create_campaign` and `add_leads_to_campaign` can cause real cold email to be sent. Both require a `consent_confirmed` boolean that must be `true`. Setting it to `true` asserts that every lead has given consent and has been checked against your suppression and unsubscribe lists, in line with CASL and PIPEDA. If `consent_confirmed` is `false`, the tool refuses and returns a clear message before any API call is made.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `INSTANTLY_API_KEY` | Your Instantly V2 API key. Create one in Instantly under Settings, Integrations, API. It must be a V2 key (V1 keys do not work). |

Copy `.env.example` to `.env.local` and fill in real values. Never commit `.env.local`.

## Run locally

```bash
npm install
cp .env.example .env.local   # then edit .env.local with real values
npm run build
npm run start                # serves on http://localhost:3000
```

Health check (no auth, reports only whether env vars are present):

```bash
curl http://localhost:3000/api/health
```

Smoke test the MCP endpoint (lists tools and calls `list_campaigns`):

```bash
node scripts/smoke-test.mjs
```

You can also point the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:3000/api/mcp` using Streamable HTTP. No auth header is required.

## Deploy to Vercel

1. Push this repo to GitHub (account `Yeti567`).
2. In Vercel, click New Project and import the repo.
3. Under Settings, Functions, turn on Fluid compute (recommended for this workload).
4. Under Settings, Environment Variables, add the variable for Production (and Preview if you want):
   - `INSTANTLY_API_KEY`
5. Deploy. Your MCP endpoint will be:

   ```
   https://PROJECT.vercel.app/api/mcp
   ```

   Replace `PROJECT` with your Vercel project name. Confirm the deploy with `https://PROJECT.vercel.app/api/health`.

Whenever you change the env vars, redeploy so the new values take effect.

## Add it to Claude as a custom connector

1. In Claude, go to Settings, Connectors, then Add custom connector.
2. Name it (for example `Instantly`).
3. For the URL, enter your Streamable HTTP endpoint:

   ```
   https://PROJECT.vercel.app/api/mcp
   ```

4. For authentication, choose "No authentication" (the endpoint is open). Claude.ai custom connectors do not support static header tokens, only OAuth 2.1.
5. Save and connect. Claude will list the six tools above. Ask it to, for example, "list my Instantly campaigns" to confirm it works.

## Notes on the V2 API

- Base URL: `https://api.instantly.ai/api/v2`. Auth header: `Authorization: Bearer <INSTANTLY_API_KEY>`.
- `add_sequence_step` reads the campaign, appends a step, and saves it back with `PATCH /campaigns/{id}`, because the V2 API has no dedicated append-step endpoint.
- `update_lead_status` maps friendly names (Interested, Meeting Booked, Won, and so on) to the Instantly `lt_interest_status` values.

## Security

- The Instantly key lives only in the server environment. It is never logged, never returned in a response, and never sent to the client.
- The MCP endpoint is unauthenticated. Keep your Vercel URL private; anyone who knows it can act on your Instantly account through these tools.
- API errors (auth failure, rate limit, not found) are turned into short, actionable messages, never raw stack traces.
