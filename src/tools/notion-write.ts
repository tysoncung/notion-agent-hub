/**
 * notion-write tool — Create and update Notion pages with rich content.
 */

import { z } from "zod";
import { getNotionClient, plainToRichText } from "../utils/notion-client.js";
import { logger } from "../utils/logger.js";

const blockSchema = z.object({
  type: z.enum(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "toggle", "quote", "callout", "divider", "code"]),
  text: z.string().optional().describe("Text content for the block"),
  language: z.string().optional().describe("Programming language for code blocks"),
  children: z.array(z.object({
    type: z.enum(["paragraph", "bulleted_list_item"]),
    text: z.string(),
  })).optional().describe("Child blocks (for toggles)"),
});

export const notionWriteSchema = z.object({
  action: z.enum(["create", "update", "append"]).describe("Action to perform"),
  parent_id: z.string().optional().describe("Parent page or database ID (for create)"),
  page_id: z.string().optional().describe("Page ID to update or append to"),
  title: z.string().optional().describe("Page title"),
  icon: z.string().optional().describe("Page icon emoji"),
  blocks: z.array(blockSchema).optional().describe("Content blocks to add"),
  properties: z.record(z.any()).optional().describe("Page properties to set (for database pages)"),
});

export type NotionWriteInput = z.infer<typeof notionWriteSchema>;

/**
 * Convert our simplified block format to Notion API block format.
 */
function toNotionBlock(block: z.infer<typeof blockSchema>): any {
  if (block.type === "divider") {
    return { object: "block", type: "divider", divider: {} };
  }

  if (block.type === "code") {
    return {
      object: "block",
      type: "code",
      code: {
        rich_text: plainToRichText(block.text ?? ""),
        language: block.language ?? "plain text",
      },
    };
  }

  const base: any = {
    object: "block",
    type: block.type,
    [block.type]: {
      rich_text: plainToRichText(block.text ?? ""),
    },
  };

  // Handle toggle children
  if (block.type === "toggle" && block.children?.length) {
    base[block.type].children = block.children.map((child) => ({
      object: "block",
      type: child.type,
      [child.type]: {
        rich_text: plainToRichText(child.text),
      },
    }));
  }

  return base;
}

/**
 * Create a new page in Notion.
 */
async function createPage(input: NotionWriteInput) {
  const notion = getNotionClient();

  if (!input.parent_id) {
    throw new Error("parent_id is required for create action");
  }

  // Determine if parent is a database or page
  const parent: any = input.parent_id.length === 32 || input.parent_id.includes("-")
    ? { database_id: input.parent_id }
    : { page_id: input.parent_id };

  const pageData: any = {
    parent,
    properties: input.properties ?? {},
  };

  // Add title if provided
  if (input.title) {
    if (parent.database_id) {
      // For database pages, set the title property
      pageData.properties.Name = {
        title: plainToRichText(input.title),
      };
    } else {
      pageData.properties.title = {
        title: plainToRichText(input.title),
      };
    }
  }

  // Add icon
  if (input.icon) {
    pageData.icon = { type: "emoji", emoji: input.icon };
  }

  // Add content blocks
  if (input.blocks?.length) {
    pageData.children = input.blocks.map(toNotionBlock);
  }

  const page = await notion.pages.create(pageData);
  logger.info("Created page", { pageId: (page as any).id });

  return {
    id: (page as any).id,
    url: (page as any).url,
    created: true,
  };
}

/**
 * Update an existing page's properties.
 */
async function updatePage(input: NotionWriteInput) {
  const notion = getNotionClient();

  if (!input.page_id) {
    throw new Error("page_id is required for update action");
  }

  const updateData: any = {
    page_id: input.page_id,
    properties: input.properties ?? {},
  };

  if (input.title) {
    updateData.properties.Name = {
      title: plainToRichText(input.title),
    };
  }

  if (input.icon) {
    updateData.icon = { type: "emoji", emoji: input.icon };
  }

  const page = await notion.pages.update(updateData);
  logger.info("Updated page", { pageId: input.page_id });

  return {
    id: (page as any).id,
    url: (page as any).url,
    updated: true,
  };
}

/**
 * Append blocks to an existing page.
 */
async function appendBlocks(input: NotionWriteInput) {
  const notion = getNotionClient();

  if (!input.page_id) {
    throw new Error("page_id is required for append action");
  }

  if (!input.blocks?.length) {
    throw new Error("blocks are required for append action");
  }

  const response = await notion.blocks.children.append({
    block_id: input.page_id,
    children: input.blocks.map(toNotionBlock),
  });

  logger.info("Appended blocks", {
    pageId: input.page_id,
    count: response.results.length,
  });

  return {
    page_id: input.page_id,
    blocks_added: response.results.length,
    appended: true,
  };
}

/**
 * Execute the notion-write tool.
 */
export async function notionWrite(input: NotionWriteInput) {
  switch (input.action) {
    case "create":
      return await createPage(input);
    case "update":
      return await updatePage(input);
    case "append":
      return await appendBlocks(input);
    default:
      throw new Error(`Unknown action: ${input.action}`);
  }
}
