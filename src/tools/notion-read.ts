/**
 * notion-read tool — Read pages, databases, and blocks from Notion.
 */

import { z } from "zod";
import { getNotionClient, richTextToPlain, getPageTitle } from "../utils/notion-client.js";
import { logger } from "../utils/logger.js";

export const notionReadSchema = z.object({
  page_id: z.string().optional().describe("Notion page ID to read"),
  database_id: z.string().optional().describe("Notion database ID to read"),
  block_id: z.string().optional().describe("Notion block ID to read children of"),
}).refine(
  (data) => data.page_id || data.database_id || data.block_id,
  { message: "At least one of page_id, database_id, or block_id is required" }
);

export type NotionReadInput = z.infer<typeof notionReadSchema>;

/**
 * Read a Notion page and return its properties + child blocks.
 */
async function readPage(pageId: string) {
  const notion = getNotionClient();

  const page = await notion.pages.retrieve({ page_id: pageId });
  logger.info("Retrieved page", { pageId });

  // Fetch child blocks
  const blocks = await notion.blocks.children.list({ block_id: pageId });

  const content = blocks.results.map((block: any) => {
    const type = block.type;
    const data = block[type];
    let text = "";

    if (data?.rich_text) {
      text = richTextToPlain(data.rich_text);
    }

    return { type, text, id: block.id };
  });

  return {
    id: (page as any).id,
    title: getPageTitle((page as any).properties),
    url: (page as any).url,
    properties: (page as any).properties,
    content,
  };
}

/**
 * Read a Notion database schema (properties/columns).
 */
async function readDatabase(databaseId: string) {
  const notion = getNotionClient();

  const db = await notion.databases.retrieve({ database_id: databaseId });
  logger.info("Retrieved database", { databaseId });

  const properties = Object.entries((db as any).properties).map(
    ([name, prop]: [string, any]) => ({
      name,
      type: prop.type,
      id: prop.id,
    })
  );

  return {
    id: (db as any).id,
    title: richTextToPlain((db as any).title),
    description: (db as any).description
      ? richTextToPlain((db as any).description)
      : null,
    properties,
  };
}

/**
 * Read children of a block.
 */
async function readBlockChildren(blockId: string) {
  const notion = getNotionClient();

  const response = await notion.blocks.children.list({ block_id: blockId });
  logger.info("Retrieved block children", { blockId, count: response.results.length });

  return response.results.map((block: any) => {
    const type = block.type;
    const data = block[type];
    let text = "";

    if (data?.rich_text) {
      text = richTextToPlain(data.rich_text);
    }

    return { id: block.id, type, text };
  });
}

/**
 * Execute the notion-read tool.
 */
export async function notionRead(input: NotionReadInput) {
  if (input.page_id) {
    return await readPage(input.page_id);
  }
  if (input.database_id) {
    return await readDatabase(input.database_id);
  }
  if (input.block_id) {
    return await readBlockChildren(input.block_id);
  }
  throw new Error("No valid ID provided");
}
