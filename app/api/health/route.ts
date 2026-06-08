// Unprotected health check. Useful to confirm the deployment is live.
// It reports only whether the required env vars are present, never their values.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "instantly-mcp",
      mcp_endpoint: "/api/mcp",
      configured: {
        instantly_api_key: Boolean(process.env.INSTANTLY_API_KEY),
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
