/**
 * notion-query tool — Query Notion databases with filters and sorts.
 */

import { z } from "zod";
import { getNotionClient, richTextToPlain, getPageTitle } from "../utils/notion-client.js";
import { logger } from "../utils/logger.js";

export const notionQuerySchema = z.object({
  database_id: z.string().describe("Notion database ID to query"),
  filter: z.any().optional().describe("Notion filter object (see Notion API docs)"),
  sorts: z.array(z.object({
    property: z.string().optional(),
    timestamp: z.enum(["created_time", "last_edited_time"]).optional(),
    direction: z.enum(["ascending", "descending"]),
  })).optional().describe("Sort criteria"),
  page_size: z.number().min(1).max(100).optional().default(50).describe("Number of results per page"),
  start_cursor: z.string().optional().describe("Pagination cursor"),
});

export type NotionQueryInput = z.infer<typeof notionQuerySchema>;

/**
 * Extract a summary of page properties for display.
 */
function summarizeProperties(properties: Record<string, any>): Record<string, any> {
  const summary: Record<string, any> = {};

  for (const [name, prop] of Object.entries(properties)) {
    switch (prop.type) {
      case "title":
        summary[name] = richTextToPlain(prop.title);
        break;
      case "rich_text":
        summary[name] = richTextToPlain(prop.rich_text);
        break;
      case "number":
        summary[name] = prop.number;
        break;
      case "select":
        summary[name] = prop.select?.name ?? null;
        break;
      case "multi_select":
        summary[name] = prop.multi_select?.map((s: any) => s.name) ?? [];
        break;
      case "status":
        summary[name] = prop.status?.name ?? null;
        break;
      case "date":
        summary[name] = prop.date?.start ?? null;
        break;
      case "checkbox":
        summary[name] = prop.checkbox;
        break;
      case "url":
        summary[name] = prop.url;
        break;
      case "email":
        summary[name] = prop.email;
        break;
      case "phone_number":
        summary[name] = prop.phone_number;
        break;
      case "formula":
        summary[name] = prop.formula?.[prop.formula?.type];
        break;
      case "relation":
        summary[name] = prop.relation?.map((r: any) => r.id) ?? [];
        break;
      case "people":
        summary[name] = prop.people?.map((p: any) => p.name ?? p.id) ?? [];
        break;
      default:
        summary[name] = `[${prop.type}]`;
    }
  }

  return summary;
}

/**
 * Execute the notion-query tool.
 */
export async function notionQuery(input: NotionQueryInput) {
  const notion = getNotionClient();

  const queryParams: any = {
    database_id: input.database_id,
    page_size: input.page_size ?? 50,
  };

  if (input.filter) {
    queryParams.filter = input.filter;
  }

  if (input.sorts) {
    queryParams.sorts = input.sorts;
  }

  if (input.start_cursor) {
    queryParams.start_cursor = input.start_cursor;
  }

  const response = await notion.databases.query(queryParams);
  logger.info("Queried database", {
    databaseId: input.database_id,
    results: response.results.length,
    hasMore: response.has_more,
  });

  const pages = response.results.map((page: any) => ({
    id: page.id,
    title: getPageTitle(page.properties),
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    properties: summarizeProperties(page.properties),
  }));

  return {
    results: pages,
    has_more: response.has_more,
    next_cursor: response.next_cursor,
    total: pages.length,
  };
}
