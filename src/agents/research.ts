/**
 * Research Agent — Takes a topic, searches the web, summarizes findings,
 * and writes structured output to a Notion page.
 */

import { webSearch } from "../tools/web-search.js";
import { notionWrite } from "../tools/notion-write.js";
import { logger } from "../utils/logger.js";
import type { Task } from "../queue/task-queue.js";

export interface ResearchInput {
  topic: string;
  parent_id: string;
  search_count?: number;
}

export interface ResearchResult {
  page_id: string;
  page_url: string;
  sources_count: number;
  topic: string;
}

/**
 * Run the research agent workflow:
 * 1. Search the web for the topic
 * 2. Compile findings
 * 3. Create a Notion page with structured results
 */
export async function runResearchAgent(input: ResearchInput): Promise<ResearchResult> {
  logger.info("Starting research agent", { topic: input.topic });

  // Step 1: Search
  const searchResults = await webSearch({
    query: input.topic,
    count: input.search_count ?? 5,
  });

  logger.info("Search complete", {
    topic: input.topic,
    results: searchResults.results.length,
    source: searchResults.source,
  });

  // Step 2: Build content blocks for the Notion page
  const blocks: any[] = [
    { type: "heading_2", text: "Research Summary" },
    {
      type: "callout",
      text: `Research conducted on: ${new Date().toISOString().split("T")[0]} | Sources: ${searchResults.results.length} | Search engine: ${searchResults.source}`,
    },
    { type: "divider" },
    { type: "heading_2", text: "Sources & Findings" },
  ];

  for (const result of searchResults.results) {
    blocks.push({
      type: "toggle",
      text: result.title || "Untitled Source",
      children: [
        { type: "paragraph", text: result.snippet || "No description available." },
        { type: "paragraph", text: `🔗 ${result.url}` },
      ],
    });
  }

  blocks.push(
    { type: "divider" },
    { type: "heading_2", text: "Key Takeaways" },
    { type: "paragraph", text: "⏳ Awaiting human review — add your analysis and key takeaways here." },
    { type: "divider" },
    { type: "heading_2", text: "Next Steps" },
    { type: "bulleted_list_item", text: "Review sources above" },
    { type: "bulleted_list_item", text: "Add analysis and insights" },
    { type: "bulleted_list_item", text: "Mark task as reviewed in the task database" }
  );

  // Step 3: Create the Notion page
  const page = await notionWrite({
    action: "create",
    parent_id: input.parent_id,
    title: `Research: ${input.topic}`,
    icon: "🔬",
    blocks,
  }) as { id: string; url: string; created: boolean };

  logger.info("Research page created", { pageId: page.id, url: page.url });

  return {
    page_id: page.id,
    page_url: page.url,
    sources_count: searchResults.results.length,
    topic: input.topic,
  };
}

/**
 * Task queue handler for research tasks.
 */
export async function handleResearchTask(task: Task): Promise<ResearchResult> {
  const input = task.input as ResearchInput;

  if (!input.topic) {
    throw new Error("Research task requires a 'topic' in input");
  }
  if (!input.parent_id) {
    throw new Error("Research task requires a 'parent_id' in input");
  }

  return runResearchAgent(input);
}
