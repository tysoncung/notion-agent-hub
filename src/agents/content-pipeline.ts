/**
 * Content Pipeline Agent — Takes an outline from Notion, generates draft content,
 * and writes it back for human review.
 *
 * Workflow:
 * 1. Read the outline page from Notion
 * 2. Generate draft content based on the outline
 * 3. Create a new draft page linked to the outline
 * 4. Set status to "Review" for human approval
 */

import { notionRead } from "../tools/notion-read.js";
import { notionWrite } from "../tools/notion-write.js";
import { webSearch } from "../tools/web-search.js";
import { logger } from "../utils/logger.js";
import type { Task } from "../queue/task-queue.js";

export interface ContentPipelineInput {
  outline_page_id: string;  // Notion page with the content outline
  parent_id: string;        // Where to create the draft page
  research?: boolean;       // Whether to do web research first
}

/**
 * Extract section headers and bullet points from Notion blocks.
 */
function extractOutline(content: Array<{ type: string; text: string }>) {
  const sections: Array<{ heading: string; points: string[] }> = [];
  let currentSection: { heading: string; points: string[] } | null = null;

  for (const block of content) {
    if (block.type.startsWith("heading_")) {
      if (currentSection) sections.push(currentSection);
      currentSection = { heading: block.text, points: [] };
    } else if (
      block.type === "bulleted_list_item" ||
      block.type === "numbered_list_item"
    ) {
      if (currentSection) {
        currentSection.points.push(block.text);
      }
    } else if (block.type === "paragraph" && block.text) {
      if (currentSection) {
        currentSection.points.push(block.text);
      }
    }
  }

  if (currentSection) sections.push(currentSection);
  return sections;
}

/**
 * Generate draft content blocks from an outline.
 * In production, this would call an LLM (OpenAI, etc.).
 * For now, it creates a structured draft template.
 */
function generateDraftBlocks(
  title: string,
  sections: Array<{ heading: string; points: string[] }>,
  research?: Array<{ title: string; snippet: string; url: string }>
) {
  const blocks: any[] = [
    { type: "callout", text: "📝 DRAFT — This content was auto-generated and needs human review before publishing." },
    { type: "divider" },
  ];

  // Add research section if available
  if (research?.length) {
    blocks.push(
      { type: "heading_2", text: "Background Research" },
      {
        type: "toggle",
        text: `${research.length} sources consulted`,
        children: research.map((r) => ({
          type: "paragraph" as const,
          text: `${r.title}: ${r.snippet} (${r.url})`,
        })),
      },
      { type: "divider" }
    );
  }

  // Expand each section from the outline
  for (const section of sections) {
    blocks.push({ type: "heading_2", text: section.heading });

    if (section.points.length > 0) {
      // Create paragraph from points as a draft expansion
      blocks.push({
        type: "paragraph",
        text: `[Draft content for "${section.heading}"] — Expand on the following points:`,
      });

      for (const point of section.points) {
        blocks.push({ type: "bulleted_list_item", text: point });
      }
    } else {
      blocks.push({
        type: "paragraph",
        text: `[Draft content needed for "${section.heading}"]`,
      });
    }

    blocks.push({ type: "paragraph", text: "" }); // spacing
  }

  blocks.push(
    { type: "divider" },
    { type: "heading_2", text: "Review Checklist" },
    { type: "bulleted_list_item", text: "☐ Accuracy — verify all facts and claims" },
    { type: "bulleted_list_item", text: "☐ Tone — matches brand voice" },
    { type: "bulleted_list_item", text: "☐ Completeness — all sections filled out" },
    { type: "bulleted_list_item", text: "☐ Sources — properly cited" },
    { type: "bulleted_list_item", text: "☐ Approved for publishing" }
  );

  return blocks;
}

/**
 * Run the content pipeline agent.
 */
export async function runContentPipeline(input: ContentPipelineInput) {
  logger.info("Starting content pipeline", { outlinePageId: input.outline_page_id });

  // Step 1: Read the outline
  const outlinePage = await notionRead({ page_id: input.outline_page_id }) as {
    id: string; title: string | null; url: string; properties: any;
    content: Array<{ type: string; text: string; id: string }>;
  };
  const title = outlinePage.title ?? "Untitled Content";
  const sections = extractOutline(outlinePage.content);

  logger.info("Parsed outline", { title, sections: sections.length });

  // Step 2: Optional research
  let research: Array<{ title: string; snippet: string; url: string }> | undefined;

  if (input.research) {
    const searchResult = await webSearch({ query: title, count: 3 });
    research = searchResult.results;
    logger.info("Research complete", { sources: research.length });
  }

  // Step 3: Generate draft blocks
  const blocks = generateDraftBlocks(title, sections, research);

  // Step 4: Create the draft page
  const page = await notionWrite({
    action: "create",
    parent_id: input.parent_id,
    title: `[DRAFT] ${title}`,
    icon: "📝",
    blocks,
  }) as { id: string; url: string; created: boolean };

  logger.info("Draft page created", { pageId: page.id, url: page.url });

  return {
    page_id: page.id,
    page_url: page.url,
    title,
    sections_count: sections.length,
    has_research: !!research,
  };
}

/**
 * Task queue handler for content pipeline tasks.
 */
export async function handleContentPipelineTask(task: Task) {
  const input = task.input as ContentPipelineInput;

  if (!input.outline_page_id) {
    throw new Error("Content pipeline task requires 'outline_page_id' in input");
  }
  if (!input.parent_id) {
    throw new Error("Content pipeline task requires 'parent_id' in input");
  }

  return runContentPipeline(input);
}
