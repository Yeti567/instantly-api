import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  instantlyRequest,
  InstantlyError,
  INTEREST_STATUS,
  campaignStatusLabel,
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
      "Get performance stats for one campaign: emails sent, opens (total and unique), replies (total and unique), and bounces, plus lead and contacted counts. Provide the campaign_id from list_campaigns. Optionally restrict to a date range.",
      {
        campaign_id: z
          .string()
          .min(1)
          .describe("Required. The campaign id to get analytics for."),
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
            Array<Record<string, unknown>>
          >("GET", "/campaigns/analytics", {
            query: { id: campaign_id, start_date, end_date },
          });
          const row = Array.isArray(data) ? data[0] : undefined;
          if (!row) {
            return fail(
              "No analytics found for that campaign_id. Confirm it is correct with list_campaigns.",
            );
          }
          return ok({
            campaign_id: row.campaign_id ?? campaign_id,
            campaign_name: row.campaign_name ?? null,
            sent: row.emails_sent_count ?? 0,
            opens: row.open_count ?? 0,
            opens_unique: row.open_count_unique ?? 0,
            replies: row.reply_count ?? 0,
            replies_unique: row.reply_count_unique ?? 0,
            bounces: row.bounced_count ?? 0,
            leads_count: row.leads_count ?? 0,
            contacted_count: row.contacted_count ?? 0,
            unsubscribed: row.unsubscribed_count ?? 0,
          });
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
            "IANA timezone for the schedule, for example America/Toronto. Defaults to America/Toronto.",
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

          const steps = input.sequence_steps.map((s, i) => ({
            type: "email",
            delay: s.delay_days ?? (i === 0 ? 0 : 2),
            delay_unit: "days",
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
                  timezone: input.timezone ?? "America/Toronto",
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
// Auth wrapper: every request must present the shared secret.
// ---------------------------------------------------------------------------

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function withAuth(
  inner: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const expected = process.env.MCP_AUTH_TOKEN;
    if (!expected) {
      return new Response(
        JSON.stringify({
          error:
            "Server is not configured: MCP_AUTH_TOKEN is missing. Set it in the deployment environment.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const authHeader = req.headers.get("authorization") ?? "";
    const bearer = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const provided = bearer || (req.headers.get("x-mcp-token") ?? "");

    if (!provided) {
      return unauthorized(
        "Missing credentials. Send Authorization: Bearer <token> or an x-mcp-token header.",
      );
    }
    if (provided !== expected) {
      return unauthorized("Invalid token.");
    }
    return inner(req);
  };
}

const authed = withAuth(handler as unknown as (req: Request) => Promise<Response>);

export { authed as GET, authed as POST, authed as DELETE };
