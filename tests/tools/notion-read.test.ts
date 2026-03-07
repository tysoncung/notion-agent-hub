import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Notion client
vi.mock("../../src/utils/notion-client.js", () => {
  const mockClient = {
    pages: {
      retrieve: vi.fn(),
    },
    databases: {
      retrieve: vi.fn(),
    },
    blocks: {
      children: {
        list: vi.fn(),
      },
    },
  };

  return {
    getNotionClient: () => mockClient,
    richTextToPlain: (rt: Array<{ plain_text: string }>) => rt.map((t) => t.plain_text).join(""),
    getPageTitle: (props: Record<string, any>) => {
      for (const prop of Object.values(props)) {
        if (prop.type === "title" && Array.isArray(prop.title)) {
          return prop.title.map((t: any) => t.plain_text).join("");
        }
      }
      return null;
    },
  };
});

import { notionRead } from "../../src/tools/notion-read.js";
import { getNotionClient } from "../../src/utils/notion-client.js";

describe("notion-read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should read a page and return structured content", async () => {
    const client = getNotionClient() as any;

    client.pages.retrieve.mockResolvedValue({
      id: "page-123",
      url: "https://notion.so/page-123",
      properties: {
        Name: {
          type: "title",
          title: [{ plain_text: "Test Page" }],
        },
      },
    });

    client.blocks.children.list.mockResolvedValue({
      results: [
        {
          id: "block-1",
          type: "paragraph",
          paragraph: {
            rich_text: [{ plain_text: "Hello world" }],
          },
        },
      ],
    });

    const result = await notionRead({ page_id: "page-123" });

    expect(result).toMatchObject({
      id: "page-123",
      title: "Test Page",
      url: "https://notion.so/page-123",
      content: [
        { type: "paragraph", text: "Hello world", id: "block-1" },
      ],
    });
  });

  it("should read a database schema", async () => {
    const client = getNotionClient() as any;

    client.databases.retrieve.mockResolvedValue({
      id: "db-123",
      title: [{ plain_text: "Tasks" }],
      description: [],
      properties: {
        Name: { type: "title", id: "title" },
        Status: { type: "status", id: "status" },
      },
    });

    const result = await notionRead({ database_id: "db-123" });

    expect(result).toMatchObject({
      id: "db-123",
      title: "Tasks",
      properties: [
        { name: "Name", type: "title" },
        { name: "Status", type: "status" },
      ],
    });
  });

  it("should throw if no ID is provided", async () => {
    await expect(notionRead({} as any)).rejects.toThrow();
  });
});
