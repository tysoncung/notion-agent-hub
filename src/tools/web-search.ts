/**
 * web-search tool — Search the web for research tasks.
 * Uses the Brave Search API (or falls back to a simple fetch-based approach).
 */

import { z } from "zod";
import { logger } from "../utils/logger.js";

export const webSearchSchema = z.object({
  query: z.string().describe("Search query string"),
  count: z.number().min(1).max(20).optional().default(5).describe("Number of results to return"),
});

export type WebSearchInput = z.infer<typeof webSearchSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search using Brave Search API if BRAVE_API_KEY is set.
 */
async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY not set");
  }

  const params = new URLSearchParams({
    q: query,
    count: String(count),
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();

  return (data.web?.results ?? []).slice(0, count).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

/**
 * Fallback: fetch a DuckDuckGo instant answer (limited but no API key needed).
 */
async function duckDuckGoInstant(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    no_html: "1",
    skip_disambig: "1",
  });

  const response = await fetch(`https://api.duckduckgo.com/?${params}`);
  const data: any = await response.json();

  const results: SearchResult[] = [];

  if (data.AbstractText) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL || "",
      snippet: data.AbstractText,
    });
  }

  for (const topic of data.RelatedTopics ?? []) {
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.substring(0, 80),
        url: topic.FirstURL,
        snippet: topic.Text,
      });
    }
  }

  return results;
}

/**
 * Execute the web-search tool.
 */
export async function webSearch(input: WebSearchInput): Promise<{ results: SearchResult[]; source: string }> {
  logger.info("Web search", { query: input.query, count: input.count });

  try {
    const results = await braveSearch(input.query, input.count ?? 5);
    return { results, source: "brave" };
  } catch {
    logger.info("Brave Search unavailable, falling back to DuckDuckGo instant");
    const results = await duckDuckGoInstant(input.query);
    return { results: results.slice(0, input.count ?? 5), source: "duckduckgo" };
  }
}
