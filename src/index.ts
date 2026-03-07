#!/usr/bin/env node

/**
 * Notion Agent Hub — MCP Server
 *
 * An MCP server that exposes Notion tools and agent workflows.
 * Supports stdio transport for local use and SSE for remote connections.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { notionRead, notionReadSchema } from "./tools/notion-read.js";
import { notionWrite, notionWriteSchema } from "./tools/notion-write.js";
import { notionQuery, notionQuerySchema } from "./tools/notion-query.js";
import { webSearch, webSearchSchema } from "./tools/web-search.js";
import { codeRun, codeRunSchema } from "./tools/code-run.js";
import { logger } from "./utils/logger.js";

// Create MCP server
const server = new McpServer({
  name: "notion-agent-hub",
  version: "0.1.0",
});

// ─── Tool: notion-read ───────────────────────────────────────────────────────

server.tool(
  "notion-read",
  "Read pages, databases, or blocks from Notion. Returns structured content including properties and child blocks.",
  {
    page_id: z.string().optional().describe("Notion page ID to read"),
    database_id: z.string().optional().describe("Notion database ID to read its schema"),
    block_id: z.string().optional().describe("Block ID to read its children"),
  },
  async (params) => {
    try {
      const result = await notionRead(params as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: notion-write ──────────────────────────────────────────────────────

server.tool(
  "notion-write",
  "Create or update Notion pages. Supports creating pages with rich content blocks (headings, paragraphs, lists, toggles, code, callouts).",
  {
    action: z.enum(["create", "update", "append"]).describe("create: new page, update: modify properties, append: add blocks"),
    parent_id: z.string().optional().describe("Parent page or database ID (required for create)"),
    page_id: z.string().optional().describe("Page ID (required for update/append)"),
    title: z.string().optional().describe("Page title"),
    icon: z.string().optional().describe("Page icon emoji"),
    blocks: z.array(z.object({
      type: z.enum(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "toggle", "quote", "callout", "divider", "code"]),
      text: z.string().optional(),
      language: z.string().optional(),
      children: z.array(z.object({ type: z.enum(["paragraph", "bulleted_list_item"]), text: z.string() })).optional(),
    })).optional().describe("Content blocks"),
    properties: z.record(z.any()).optional().describe("Page properties to set"),
  },
  async (params) => {
    try {
      const result = await notionWrite(params as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: notion-query ──────────────────────────────────────────────────────

server.tool(
  "notion-query",
  "Query a Notion database with filters and sorting. Returns matching pages with summarized properties.",
  {
    database_id: z.string().describe("Database ID to query"),
    filter: z.any().optional().describe("Notion filter object — see https://developers.notion.com/reference/post-database-query-filter"),
    sorts: z.array(z.object({
      property: z.string().optional(),
      timestamp: z.enum(["created_time", "last_edited_time"]).optional(),
      direction: z.enum(["ascending", "descending"]),
    })).optional().describe("Sort criteria"),
    page_size: z.number().min(1).max(100).optional().describe("Results per page (default 50)"),
    start_cursor: z.string().optional().describe("Pagination cursor from previous response"),
  },
  async (params) => {
    try {
      const result = await notionQuery(params as any);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: web-search ────────────────────────────────────────────────────────

server.tool(
  "web-search",
  "Search the web for information. Uses Brave Search API if available, falls back to DuckDuckGo. Useful for research tasks.",
  {
    query: z.string().describe("Search query"),
    count: z.number().min(1).max(20).optional().describe("Number of results (default 5)"),
  },
  async (params) => {
    try {
      const result = await webSearch({ query: params.query, count: params.count ?? 5 });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: code-run ──────────────────────────────────────────────────────────

server.tool(
  "code-run",
  "Execute JavaScript code in a sandboxed environment. Has access to Math, Date, JSON, and standard built-ins. No filesystem or network access.",
  {
    code: z.string().describe("JavaScript code to execute"),
    timeout_ms: z.number().min(100).max(30000).optional().describe("Timeout in ms (default 5000)"),
  },
  async (params) => {
    try {
      const result = await codeRun({ code: params.code, timeout_ms: params.timeout_ms ?? 5000 });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  logger.info("Starting Notion Agent Hub MCP server");

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server connected via stdio");
}

main().catch((err) => {
  logger.error("Fatal error", { error: err.message });
  process.exit(1);
});
