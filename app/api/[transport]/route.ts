import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  instantlyRequest,
  InstantlyError,
  INTEREST_STATUS,
  campaignStatusLabel,
  resolveTimezone,
} from "@/lib/instantly";

// Each Instantly call is a plain request/response, so the server is stateless.
// Allow up to 60s on Vercel (Fluid compute) for the read-modify-write tools.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Wraps a tool body so any thrown InstantlyError (or other error) becomes a
// clean, actionable message instead of a raw stack trace.
async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InstantlyError) {
      return fail(e.message);
    }
    return fail("Unexpected error while calling Instantly. Please try again.");
  }
}

const CONSENT_REFUSAL =
  "Refused: consent_confirmed must be true. Only proceed once every lead has given consent and has been checked against your suppression and unsubscribe lists, per CASL and PIPEDA. Set consent_confirmed to true to continue.";

// Coerce an unknown analytics value to a finite number, defaulting to 0.
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// A rate as a 0..1 ratio rounded to 4 decimals, guarding divide-by-zero.
function rate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

// The daily and step analytics endpoints require a date range. When the caller
// omits it, default to the last 90 days so the tool is still usable.
function dateRangeDefaults(
  start?: string,
  end?: string,
): { start: string; end: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: start ?? fmt(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
    end: end ?? fmt(new Date()),
  };
}

// Reverse of INTEREST_STATUS: turn a lead's numeric lt_interest_status back
// into a human label. null/undefined means the lead has no status yet ("Lead").
function interestLabel(v: unknown): string | null {
  if (v === null || v === undefined) return "Lead";
  for (const [label, val] of Object.entries(INTEREST_STATUS)) {
    if (val === v) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP handler and tools
// ---------------------------------------------------------------------------

const handler = createMcpHandler(
  (server) => {
    // ----- list_campaigns ---------------------------------------------------
    server.tool(
      "list_campaigns",
      "List the cold email campaigns in your Instantly workspace. Returns each campaign's id, name, and status (with a human readable status label). Use this to find a campaign id before getting analytics, adding a sequence step, or adding leads. Results are paginated, use the limit and search inputs to narrow them.",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max campaigns to return, 1 to 100. Defaults to 100."),
        search: z
          .string()
          .optional()
          .describe("Optional case insensitive filter on campaign name."),
      },
      async ({ limit, search }) =>
        run(async () => {
          const data = await instantlyRequest<{
            items?: Array<{ id: string; name: string; status: number }>;
            next_starting_after?: string;
          }>("GET", "/campaigns", {
            query: { limit: limit ?? 100, search },
          });
          const items = (data.items ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            status_label: campaignStatusLabel(c.status),
          }));
          return ok({
            count: items.length,
            campaigns: items,
            next_starting_after: data.next_starting_after ?? null,
          });
        }),
    );

    // ----- get_campaign_analytics ------------------------------------------
    server.tool(
      "get_campaign_analytics",
      "Get performance stats for campaigns: emails sent, opens, open rate, replies, reply rate, bounces, bounce rate, and opportunities. Provide a campaign_id for one campaign, or omit it to get analytics for every campaign in the workspace. Optionally restrict to a date range.",
      {
        campaign_id: z
          .string()
          .optional()
          .describe(
            "Optional. A campaign id from list_campaigns. Omit to return analytics for all campaigns.",
          ),
        start_date: z
          .string()
          .optional()
          .describe("Optional start date, format YYYY-MM-DD."),
        end_date: z
          .string()
          .optional()
          .describe("Optional end date, format YYYY-MM-DD."),
      },
      async ({ campaign_id, start_date, end_date }) =>
        run(async () => {
          const data = await instantlyRequest<
            Array<Record<string, unknown>> | Record<string, unknown>
          >("GET", "/campaigns/analytics/overview", {
            query: { id: campaign_id, start_date, end_date },
          });
          const rawRows = Array.isArray(data) ? data : data ? [data] : [];
          // Fail closed on scope: when a single campaign is requested, drop any
          // row that belongs to a different campaign. If the `id` query param is
          // ever ignored and the API returns every workspace campaign, this
          // keeps only the requested one rather than reporting all of them.
          // Rows that omit campaign_id are kept, since the single-campaign
          // response does not always echo the id back.
          const rows = campaign_id
            ? rawRows.filter(
                (r) => r.campaign_id == null || r.campaign_id === campaign_id,
              )
            : rawRows;
          if (campaign_id && rows.length === 0) {
            return fail(
              "No analytics found for that campaign_id. Confirm it is correct with list_campaigns.",
            );
          }
          const campaigns = rows.map((row) => {
            const sent = num(row.emails_sent_count);
            const opens = num(row.open_count);
            const replies = num(row.reply_count);
            const bounces = num(row.bounced_count);
            return {
              campaign_id: row.campaign_id ?? campaign_id ?? null,
              campaign_name: row.campaign_name ?? null,
              emails_sent: sent,
              opens,
              open_rate: rate(opens, sent),
              replies,
              reply_rate: rate(replies, sent),
              bounces,
              bounce_rate: rate(bounces, sent),
              opportunities: num(row.total_opportunities),
            };
          });
          return ok({ count: campaigns.length, campaigns });
        }),
    );

    // ----- create_campaign --------------------------------------------------
    server.tool(
      "create_campaign",
      "Create a new cold email campaign with a sending schedule and one or more email sequence steps (each step has a subject and body). COMPLIANCE: this can send real cold email. You must set consent_confirmed to true, which asserts that every lead you will contact has given consent and has been checked against your suppression and unsubscribe lists, per CASL and PIPEDA. If consent_confirmed is false the call is refused. The campaign is created in a non sending state until you attach sending accounts and activate it in Instantly.",
      {
        consent_confirmed: z
          .boolean()
          .describe(
            "Required. Must be true. Asserts all leads are consented and suppression checked (CASL, PIPEDA). The call is refused if false.",
          ),
        name: z.string().min(1).describe("Required. The campaign name."),
        sequence_steps: z
          .array(
            z.object({
              subject: z
                .string()
                .min(1)
                .describe(
                  "Email subject line. Supports variables like {{firstName}}.",
                ),
              body: z
                .string()
                .min(1)
                .describe(
                  "Email body. Supports variables like {{firstName}}. Use \\n for new lines.",
                ),
              delay_days: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                  "Days to wait before this step. Use 0 for the first email, then a gap for follow ups. Defaults to 0 for step 1 and 2 thereafter.",
                ),
            }),
          )
          .min(1)
          .describe("Required. At least one email step, in send order."),
        timezone: z
          .string()
          .optional()
          .describe(
            "IANA timezone for the schedule. Instantly accepts a curated list, so common Canadian zones are auto-mapped to an accepted equivalent (America/Edmonton to America/Denver, America/Toronto to America/New_York, etc.). Any Etc/GMT+N offset is always accepted. Defaults to America/Denver (Mountain).",
          ),
        send_from: z
          .string()
          .optional()
          .describe("Daily send window start, 24h HH:MM. Defaults to 09:00."),
        send_to: z
          .string()
          .optional()
          .describe("Daily send window end, 24h HH:MM. Defaults to 17:00."),
        active_days: z
          .array(z.number().int().min(0).max(6))
          .optional()
          .describe(
            "Weekdays to send on, 0 is Sunday through 6 is Saturday. Defaults to Monday to Friday [1,2,3,4,5].",
          ),
        start_date: z
          .string()
          .optional()
          .describe("Optional campaign start date, YYYY-MM-DD."),
        end_date: z
          .string()
          .optional()
          .describe("Optional campaign end date, YYYY-MM-DD."),
        sender_emails: z
          .array(z.string())
          .optional()
          .describe(
            "Optional sending email accounts (must already be connected in Instantly).",
          ),
        daily_limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Optional max emails to send per day for this campaign."),
      },
      async (input) =>
        run(async () => {
          if (!input.consent_confirmed) return fail(CONSENT_REFUSAL);

          const tz = resolveTimezone(input.timezone ?? "America/Boise");
          if ("error" in tz) return fail(tz.error);
          const timezone = tz.timezone;

          const activeDays = input.active_days ?? [1, 2, 3, 4, 5];
          const days: Record<string, boolean> = {
            "0": false,
            "1": false,
            "2": false,
            "3": false,
            "4": false,
            "5": false,
            "6": false,
          };
          for (const d of activeDays) days[String(d)] = true;

          // V2 step shape is exactly { type, delay, variants }. `delay` is
          // already in days; there is no delay_unit field in the schema, and
          // sending it is the cause of the create-time HTTP 400.
          const steps = input.sequence_steps.map((s, i) => ({
            type: "email",
            delay: s.delay_days ?? (i === 0 ? 0 : 2),
            variants: [{ subject: s.subject, body: s.body }],
          }));

          const body: Record<string, unknown> = {
            name: input.name,
            campaign_schedule: {
              ...(input.start_date ? { start_date: input.start_date } : {}),
              ...(input.end_date ? { end_date: input.end_date } : {}),
              schedules: [
                {
                  name: "Default Schedule",
                  timing: {
                    from: input.send_from ?? "09:00",
                    to: input.send_to ?? "17:00",
                  },
                  days,
                  timezone,
                },
              ],
            },
            sequences: [{ steps }],
          };
          if (input.sender_emails?.length) body.email_list = input.sender_emails;
          if (input.daily_limit != null) body.daily_limit = input.daily_limit;

          const created = await instantlyRequest<{ id?: string; name?: string }>(
            "POST",
            "/campaigns",
            { body },
          );
          return ok({
            message: "Campaign created.",
            id: created.id ?? null,
            name: created.name ?? input.name,
            steps: steps.length,
            timezone,
          });
        }),
    );

    // ----- add_sequence_step ------------------------------------------------
    server.tool(
      "add_sequence_step",
      "Add one email step to the end of an existing campaign's sequence. The V2 API has no append endpoint, so this reads the campaign's current steps, appends the new one, and saves them back. Provide the campaign_id, a subject, and a body.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id to add a step to."),
        subject: z
          .string()
          .min(1)
          .describe("Required. Subject line for the new email step."),
        body: z
          .string()
          .min(1)
          .describe("Required. Body for the new email step. Use \\n for new lines."),
        delay_days: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Days to wait after the previous step before sending. Defaults to 2."),
      },
      async ({ campaign_id, subject, body, delay_days }) =>
        run(async () => {
          const campaign = await instantlyRequest<{
            sequences?: Array<{ steps?: unknown[] }>;
          }>("GET", `/campaigns/${encodeURIComponent(campaign_id)}`);

          const firstSequence = campaign.sequences?.[0] ?? { steps: [] };
          const existingSteps = Array.isArray(firstSequence.steps)
            ? firstSequence.steps
            : [];

          const newStep = {
            type: "email",
            delay: delay_days ?? 2,
            delay_unit: "days",
            variants: [{ subject, body }],
          };

          await instantlyRequest(
            "PATCH",
            `/campaigns/${encodeURIComponent(campaign_id)}`,
            { body: { sequences: [{ steps: [...existingSteps, newStep] }] } },
          );

          return ok({
            message: "Sequence step added.",
            campaign_id,
            total_steps: existingSteps.length + 1,
          });
        }),
    );

    // ----- add_leads_to_campaign -------------------------------------------
    server.tool(
      "add_leads_to_campaign",
      "Add one or more leads to a campaign. COMPLIANCE: this can cause real cold email to be sent. You must set consent_confirmed to true, which asserts that every lead listed has given consent and has been checked against your suppression and unsubscribe lists, per CASL and PIPEDA. If consent_confirmed is false the call is refused. Each lead must include an email.",
      {
        consent_confirmed: z
          .boolean()
          .describe(
            "Required. Must be true. Asserts every lead is consented and suppression checked (CASL, PIPEDA). The call is refused if false.",
          ),
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id to add the leads to."),
        leads: z
          .array(
            z.object({
              email: z
                .string()
                .email()
                .describe("Required. The lead's email address."),
              first_name: z.string().optional().describe("Optional first name."),
              last_name: z.string().optional().describe("Optional last name."),
              company_name: z.string().optional().describe("Optional company name."),
              job_title: z.string().optional().describe("Optional job title."),
              phone: z.string().optional().describe("Optional phone number."),
              website: z.string().optional().describe("Optional website."),
              personalization: z
                .string()
                .optional()
                .describe("Optional personalization snippet (the {{personalization}} variable)."),
            }),
          )
          .min(1)
          .max(1000)
          .describe("Required. 1 to 1000 leads, each with at least an email."),
        skip_if_in_campaign: z
          .boolean()
          .optional()
          .describe("Skip a lead if it already exists in this campaign. Defaults to true."),
        skip_if_in_workspace: z
          .boolean()
          .optional()
          .describe("Skip a lead if it already exists anywhere in the workspace. Defaults to false."),
      },
      async (input) =>
        run(async () => {
          if (!input.consent_confirmed) return fail(CONSENT_REFUSAL);

          const data = await instantlyRequest<Record<string, unknown>>(
            "POST",
            "/leads/add",
            {
              body: {
                campaign_id: input.campaign_id,
                leads: input.leads,
                skip_if_in_campaign: input.skip_if_in_campaign ?? true,
                skip_if_in_workspace: input.skip_if_in_workspace ?? false,
              },
            },
          );
          return ok({
            message: "Leads submitted.",
            leads_uploaded: data.leads_uploaded ?? null,
            duplicated_leads: data.duplicated_leads ?? null,
            skipped_count: data.skipped_count ?? null,
            invalid_email_count: data.invalid_email_count ?? null,
            in_blocklist: data.in_blocklist ?? null,
          });
        }),
    );

    // ----- update_lead_status ----------------------------------------------
    server.tool(
      "update_lead_status",
      "Update a lead's interest status (for example Interested, Meeting Booked, Won, Not Interested). The lead is identified by email. Optionally scope to a campaign_id when the same email exists in more than one campaign. Use 'Reset to Lead' to clear the status.",
      {
        lead_email: z
          .string()
          .email()
          .describe("Required. The email of the lead to update."),
        interest_status: z
          .enum([
            "Out of Office",
            "Interested",
            "Meeting Booked",
            "Meeting Completed",
            "Won",
            "Not Interested",
            "Wrong Person",
            "Lost",
            "No Show",
            "Reset to Lead",
          ])
          .describe("Required. The new interest status."),
        campaign_id: z
          .string()
          .optional()
          .describe("Optional campaign id to disambiguate the lead."),
      },
      async ({ lead_email, interest_status, campaign_id }) =>
        run(async () => {
          const interest_value = INTEREST_STATUS[interest_status];
          const data = await instantlyRequest<Record<string, unknown>>(
            "POST",
            "/leads/update-interest-status",
            {
              body: {
                lead_email,
                interest_value,
                ...(campaign_id ? { campaign_id } : {}),
              },
            },
          );
          return ok({
            message:
              (data.message as string) ?? "Lead interest status update submitted.",
            lead_email,
            interest_status,
          });
        }),
    );

    // ----- get_campaign_analytics_daily ------------------------------------
    server.tool(
      "get_campaign_analytics_daily",
      "Get day-by-day analytics for a campaign to see the trend over time: emails sent, opens, replies, and bounces per day. Provide the campaign_id. The date range is optional and defaults to the last 90 days.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id from list_campaigns."),
        start_date: z
          .string()
          .optional()
          .describe("Optional start date, YYYY-MM-DD. Defaults to 90 days ago."),
        end_date: z
          .string()
          .optional()
          .describe("Optional end date, YYYY-MM-DD. Defaults to today."),
      },
      async ({ campaign_id, start_date, end_date }) =>
        run(async () => {
          const { start, end } = dateRangeDefaults(start_date, end_date);
          const data = await instantlyRequest<unknown>(
            "GET",
            "/campaigns/analytics/daily",
            { query: { campaign_id, start_date: start, end_date: end } },
          );
          const rows: Array<Record<string, unknown>> = Array.isArray(data)
            ? (data as Array<Record<string, unknown>>)
            : data
              ? [data as Record<string, unknown>]
              : [];
          const days = rows.map((row) => ({
            date: row.date ?? row.day ?? null,
            sent: num(row.emails_sent_count),
            opens: num(row.open_count),
            replies: num(row.reply_count),
            bounces: num(row.bounced_count),
          }));
          return ok({ campaign_id, start_date: start, end_date: end, days });
        }),
    );

    // ----- get_campaign_step_analytics -------------------------------------
    server.tool(
      "get_campaign_step_analytics",
      "Get per-step analytics for a campaign so you can see which email step is doing the work: sent, opens, open rate, replies, and reply rate for each step, with the step's subject line. Provide the campaign_id. Date range optional, defaults to the last 90 days.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id from list_campaigns."),
        start_date: z
          .string()
          .optional()
          .describe("Optional start date, YYYY-MM-DD. Defaults to 90 days ago."),
        end_date: z
          .string()
          .optional()
          .describe("Optional end date, YYYY-MM-DD. Defaults to today."),
      },
      async ({ campaign_id, start_date, end_date }) =>
        run(async () => {
          const { start, end } = dateRangeDefaults(start_date, end_date);
          const data = await instantlyRequest<Array<Record<string, unknown>>>(
            "GET",
            "/campaigns/analytics/steps",
            { query: { campaign_id, start_date: start, end_date: end } },
          );
          const rows = Array.isArray(data) ? data : [];

          // Best-effort: pull the sequence so we can attach each step's subject.
          // The steps analytics endpoint does not return subjects itself.
          const subjects: Record<string, string> = {};
          try {
            const campaign = await instantlyRequest<Record<string, unknown>>(
              "GET",
              `/campaigns/${encodeURIComponent(campaign_id)}`,
            );
            const sequences = campaign.sequences as
              | Array<{ steps?: Array<{ variants?: Array<{ subject?: string }> }> }>
              | undefined;
            const seqSteps = sequences?.[0]?.steps ?? [];
            seqSteps.forEach((s, i) => {
              const subject = s.variants?.[0]?.subject;
              if (subject) subjects[String(i + 1)] = subject;
            });
          } catch {
            // Subject enrichment is optional; analytics still return without it.
          }

          const steps = rows.map((row) => {
            const stepNum = row.step != null ? Number(row.step) : null;
            const sent = num(row.sent);
            const opens = num(row.opened);
            const replies = num(row.replies);
            return {
              step: stepNum,
              variant: row.variant ?? null,
              subject:
                stepNum != null ? (subjects[String(stepNum)] ?? null) : null,
              sent,
              opens,
              open_rate: rate(opens, sent),
              replies,
              reply_rate: rate(replies, sent),
            };
          });
          return ok({ campaign_id, start_date: start, end_date: end, steps });
        }),
    );

    // ----- get_campaign -----------------------------------------------------
    server.tool(
      "get_campaign",
      "Get one campaign's full configuration: name, status, sending schedule, and the ordered sequence steps with their subjects and delays. Useful before editing a campaign or adding a step.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id from list_campaigns."),
      },
      async ({ campaign_id }) =>
        run(async () => {
          const c = await instantlyRequest<Record<string, unknown>>(
            "GET",
            `/campaigns/${encodeURIComponent(campaign_id)}`,
          );
          const sequences = c.sequences as
            | Array<{ steps?: Array<Record<string, unknown>> }>
            | undefined;
          const seqSteps = sequences?.[0]?.steps ?? [];
          const steps = seqSteps.map((s, i) => {
            const variants = s.variants as
              | Array<{ subject?: string; body?: string }>
              | undefined;
            return {
              step: i + 1,
              delay: (s.delay as number) ?? null,
              subject: variants?.[0]?.subject ?? null,
              body: variants?.[0]?.body ?? null,
            };
          });
          return ok({
            id: c.id ?? campaign_id,
            name: c.name ?? null,
            status: c.status ?? null,
            status_label: campaignStatusLabel(c.status),
            campaign_schedule: c.campaign_schedule ?? null,
            email_list: c.email_list ?? [],
            daily_limit: c.daily_limit ?? null,
            steps,
          });
        }),
    );

    // ----- list_accounts ----------------------------------------------------
    server.tool(
      "list_accounts",
      "List the email sending accounts connected to your Instantly workspace, with each account's status, warmup status, warmup score, and daily sending limit. Use this to confirm which mailboxes are attached and healthy before activating a campaign.",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max accounts to return, 1 to 100. Defaults to 100."),
      },
      async ({ limit }) =>
        run(async () => {
          const data = await instantlyRequest<unknown>("GET", "/accounts", {
            query: { limit: limit ?? 100 },
          });
          // The list container key has varied across the V2 docs; accept any.
          const container = data as Record<string, unknown> | undefined;
          const items: Array<Record<string, unknown>> = Array.isArray(data)
            ? (data as Array<Record<string, unknown>>)
            : ((container?.items ??
                container?.accounts ??
                container?.data ??
                []) as Array<Record<string, unknown>>);
          const accounts = items.map((a) => ({
            email: a.email ?? null,
            status: a.status ?? null,
            warmup_status: a.warmup_status ?? null,
            warmup_score: a.stat_warmup_score ?? null,
            daily_limit: a.daily_limit ?? null,
          }));
          return ok({ count: accounts.length, accounts });
        }),
    );

    // ----- activate_campaign ------------------------------------------------
    server.tool(
      "activate_campaign",
      "Activate (start) a campaign so it begins sending. COMPLIANCE: this turns on real cold email. You must set consent_confirmed to true, which asserts that every lead in the campaign has given consent and has been checked against your suppression and unsubscribe lists, per CASL and PIPEDA. If consent_confirmed is false the call is refused. Before activating, the connector checks the campaign has at least one sequence step and at least one attached sending account, and refuses if either is missing.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id to activate."),
        consent_confirmed: z
          .boolean()
          .describe(
            "Required. Must be true. Asserts all leads are consented and suppression checked (CASL, PIPEDA). The call is refused if false.",
          ),
      },
      async ({ campaign_id, consent_confirmed }) =>
        run(async () => {
          if (!consent_confirmed) return fail(CONSENT_REFUSAL);

          // Readiness check: do not activate an empty or unsendable campaign.
          const c = await instantlyRequest<{
            sequences?: Array<{ steps?: unknown[] }>;
            email_list?: unknown[];
          }>("GET", `/campaigns/${encodeURIComponent(campaign_id)}`);
          const stepCount = c.sequences?.[0]?.steps?.length ?? 0;
          const accountCount = Array.isArray(c.email_list)
            ? c.email_list.length
            : 0;
          if (stepCount < 1) {
            return fail(
              "Cannot activate: this campaign has no sequence steps. Add at least one step first.",
            );
          }
          if (accountCount < 1) {
            return fail(
              "Cannot activate: this campaign has no sending accounts attached. Attach at least one account in Instantly first.",
            );
          }

          await instantlyRequest(
            "POST",
            `/campaigns/${encodeURIComponent(campaign_id)}/activate`,
          );
          return ok({
            message: "Campaign activated.",
            campaign_id,
            steps: stepCount,
            sending_accounts: accountCount,
          });
        }),
    );

    // ----- pause_campaign ---------------------------------------------------
    server.tool(
      "pause_campaign",
      "Pause an active campaign so it stops sending. Use this to halt sends quickly if deliverability drops or a list problem surfaces.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id to pause."),
      },
      async ({ campaign_id }) =>
        run(async () => {
          await instantlyRequest(
            "POST",
            `/campaigns/${encodeURIComponent(campaign_id)}/pause`,
          );
          return ok({ message: "Campaign paused.", campaign_id });
        }),
    );

    // ----- list_campaign_leads ----------------------------------------------
    server.tool(
      "list_campaign_leads",
      "List the leads in a campaign with their name, email, current sequence step, and interest status. Optionally filter to one interest status. Use this for reply handling and reporting.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id from list_campaigns."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max leads to return, 1 to 100. Defaults to 50."),
        interest_status: z
          .enum([
            "Out of Office",
            "Interested",
            "Meeting Booked",
            "Meeting Completed",
            "Won",
            "Not Interested",
            "Wrong Person",
            "Lost",
            "No Show",
            "Reset to Lead",
          ])
          .optional()
          .describe(
            "Optional. Only return leads with this interest status. 'Reset to Lead' matches leads with no status yet.",
          ),
      },
      async ({ campaign_id, limit, interest_status }) =>
        run(async () => {
          // NOTE: redact email before any internal log write. We do not log
          // contact rows here; only return them to the caller.
          //
          // The native filter key on POST /leads/list is `campaign` (matching
          // the `campaign` UUID field on the lead entity), NOT `campaign_id`.
          // Sending `campaign_id` was silently ignored, so the API returned the
          // whole workspace lead list regardless of the campaign requested.
          const data = await instantlyRequest<unknown>("POST", "/leads/list", {
            body: { campaign: campaign_id, limit: limit ?? 50 },
          });
          const container = data as Record<string, unknown> | undefined;
          const items: Array<Record<string, unknown>> = Array.isArray(data)
            ? (data as Array<Record<string, unknown>>)
            : ((container?.items ?? container?.data ?? []) as Array<
                Record<string, unknown>
              >);

          // Fail closed on scope: never return a lead that belongs to a
          // different campaign. If the API ever ignores the filter again (wrong
          // key, proxy quirk), this drops every off-campaign lead so the tool
          // returns an empty list rather than another campaign's audience.
          const scoped = items.filter((l) => l.campaign === campaign_id);

          // The API returned leads but none were scoped to this campaign. That
          // means the body filter key was not honored. Surface it loudly
          // instead of returning a misleading empty list.
          if (items.length > 0 && scoped.length === 0) {
            return ok({
              campaign_id,
              count: 0,
              leads: [],
              warning:
                "Instantly returned leads but none were scoped to this campaign. The /leads/list body filter key may be wrong; verify it against the live API (try 'campaign' vs 'campaign_id').",
            });
          }

          let leads = scoped.map((l) => ({
            email: l.email ?? null,
            first_name: l.first_name ?? null,
            last_name: l.last_name ?? null,
            step: l.step ?? null,
            interest_status: interestLabel(l.lt_interest_status),
            lt_interest_status: (l.lt_interest_status as number | null) ?? null,
          }));
          if (interest_status) {
            const target = INTEREST_STATUS[interest_status];
            leads = leads.filter((l) => l.lt_interest_status === target);
          }
          return ok({ campaign_id, count: leads.length, leads });
        }),
    );
  },
  {
    // Server capabilities advertised to the client.
    serverInfo: { name: "instantly-mcp", version: "1.0.0" },
  },
  {
    // Route config. The route lives at app/api/[transport]/route.ts, so the
    // Streamable HTTP endpoint is served at /api/mcp.
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: false,
  },
);

// ---------------------------------------------------------------------------
// No auth: Claude.ai custom connectors do not support static header tokens
// (only OAuth 2.1), so the endpoint is left open. The Vercel URL is kept
// private as the protection.
//
// CORS: the Claude web app connects to the MCP endpoint from the browser, so
// the responses must carry CORS headers and answer the OPTIONS preflight.
// Without them the browser blocks the request and Claude reports "couldn't
// connect". mcp-handler does not add these itself.
// ---------------------------------------------------------------------------

function applyCors(headers: Headers, req: Request): void {
  const origin = req.headers.get("origin") ?? "*";
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // Echo back whatever headers the preflight asks to send, so we never reject
  // a header the client needs. Fall back to a sensible default list.
  const requested = req.headers.get("access-control-request-headers");
  headers.set(
    "Access-Control-Allow-Headers",
    requested ??
      "Content-Type, Authorization, Accept, mcp-session-id, mcp-protocol-version",
  );
  headers.set("Access-Control-Expose-Headers", "mcp-session-id");
  headers.set("Access-Control-Max-Age", "86400");
}

const inner = handler as unknown as (req: Request) => Promise<Response>;

function withCors(
  fn: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const res = await fn(req);
    const headers = new Headers(res.headers);
    applyCors(headers, req);
    // Preserve the (possibly streaming SSE) body and status.
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

const route = withCors(inner);

export function OPTIONS(req: Request): Response {
  const headers = new Headers();
  applyCors(headers, req);
  return new Response(null, { status: 204, headers });
}

export { route as GET, route as POST, route as DELETE };
