import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/notion-client.js", () => {
  const mockClient = {
    databases: {
      query: vi.fn(),
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

import { notionQuery } from "../../src/tools/notion-query.js";
import { getNotionClient } from "../../src/utils/notion-client.js";

describe("notion-query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should query a database and return summarized results", async () => {
    const client = getNotionClient() as any;

    client.databases.query.mockResolvedValue({
      results: [
        {
          id: "page-1",
          url: "https://notion.so/page-1",
          created_time: "2026-01-01T00:00:00.000Z",
          last_edited_time: "2026-01-02T00:00:00.000Z",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Task 1" }] },
            Status: { type: "status", status: { name: "Done" } },
            Priority: { type: "select", select: { name: "High" } },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });

    const result = await notionQuery({
      database_id: "db-123",
      filter: {
        property: "Status",
        status: { equals: "Done" },
      },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      id: "page-1",
      title: "Task 1",
      properties: {
        Name: "Task 1",
        Status: "Done",
        Priority: "High",
      },
    });
    expect(result.has_more).toBe(false);
  });

  it("should pass filter and sorts to the API", async () => {
    const client = getNotionClient() as any;

    client.databases.query.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    await notionQuery({
      database_id: "db-123",
      filter: { property: "Status", status: { equals: "Pending" } },
      sorts: [{ property: "Created", direction: "descending" }],
      page_size: 10,
    });

    const call = client.databases.query.mock.calls[0][0];
    expect(call.database_id).toBe("db-123");
    expect(call.filter).toEqual({ property: "Status", status: { equals: "Pending" } });
    expect(call.sorts).toEqual([{ property: "Created", direction: "descending" }]);
    expect(call.page_size).toBe(10);
  });
});
