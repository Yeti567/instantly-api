// Local smoke test for the Instantly MCP server.
// Connects over Streamable HTTP (the same transport the MCP Inspector uses),
// lists the tools, and calls list_campaigns.
//
// Usage:
//   MCP_URL=http://localhost:3000/api/mcp node scripts/smoke-test.mjs
//
// With a real INSTANTLY_API_KEY in the server env, list_campaigns returns real
// data. With a fake key it returns a clean auth-failure message (still proves
// the full request path works).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:3000/api/mcp";

const transport = new StreamableHTTPClientTransport(new URL(url));

const client = new Client({ name: "smoke-test", version: "1.0.0" });

await client.connect(transport);
console.log("connected to", url);

const tools = await client.listTools();
console.log("\ntools:");
for (const t of tools.tools) console.log("  -", t.name);

console.log("\ncalling list_campaigns...");
const res = await client.callTool({ name: "list_campaigns", arguments: { limit: 5 } });
console.log("isError:", res.isError ?? false);
console.log(res.content?.[0]?.text ?? "(no text)");

await client.close();
process.exit(0);
