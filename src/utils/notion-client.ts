/**
 * Notion API client wrapper.
 * Provides a configured Client instance and helper utilities.
 */

import { Client } from "@notionhq/client";
import { logger } from "./logger.js";

let _client: Client | null = null;

/**
 * Get or create the singleton Notion client.
 * Reads NOTION_API_KEY from environment.
 */
export function getNotionClient(): Client {
  if (!_client) {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
      throw new Error("NOTION_API_KEY environment variable is required");
    }
    _client = new Client({ auth: apiKey });
    logger.info("Notion client initialized");
  }
  return _client;
}

/**
 * Extract plain text from Notion rich text array.
 */
export function richTextToPlain(
  richText: Array<{ plain_text: string }>
): string {
  return richText.map((t) => t.plain_text).join("");
}

/**
 * Build a rich text block from a plain string.
 */
export function plainToRichText(text: string) {
  return [
    {
      type: "text" as const,
      text: { content: text },
    },
  ];
}

/**
 * Extract the title from a Notion page's properties.
 */
export function getPageTitle(
  properties: Record<string, any>
): string | null {
  for (const prop of Object.values(properties)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      return richTextToPlain(prop.title);
    }
  }
  return null;
}
