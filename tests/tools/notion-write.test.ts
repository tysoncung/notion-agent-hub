import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/notion-client.js", () => {
  const mockClient = {
    pages: {
      create: vi.fn(),
      update: vi.fn(),
    },
    blocks: {
      children: {
        append: vi.fn(),
      },
    },
  };

  return {
    getNotionClient: () => mockClient,
    plainToRichText: (text: string) => [{ type: "text", text: { content: text } }],
  };
});

import { notionWrite } from "../../src/tools/notion-write.js";
import { getNotionClient } from "../../src/utils/notion-client.js";

describe("notion-write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a page with title and blocks", async () => {
    const client = getNotionClient() as any;

    client.pages.create.mockResolvedValue({
      id: "new-page-123",
      url: "https://notion.so/new-page-123",
    });

    const result = await notionWrite({
      action: "create",
      parent_id: "db-123-456-789-abc-def012345678",
      title: "My New Page",
      icon: "🚀",
      blocks: [
        { type: "heading_1", text: "Introduction" },
        { type: "paragraph", text: "Hello world" },
      ],
    });

    expect(result).toMatchObject({
      id: "new-page-123",
      created: true,
    });

    expect(client.pages.create).toHaveBeenCalledOnce();
    const call = client.pages.create.mock.calls[0][0];
    expect(call.parent).toHaveProperty("database_id");
    expect(call.icon).toEqual({ type: "emoji", emoji: "🚀" });
    expect(call.children).toHaveLength(2);
  });

  it("should update page properties", async () => {
    const client = getNotionClient() as any;

    client.pages.update.mockResolvedValue({
      id: "page-123",
      url: "https://notion.so/page-123",
    });

    const result = await notionWrite({
      action: "update",
      page_id: "page-123",
      title: "Updated Title",
    });

    expect(result).toMatchObject({
      id: "page-123",
      updated: true,
    });
  });

  it("should append blocks to a page", async () => {
    const client = getNotionClient() as any;

    client.blocks.children.append.mockResolvedValue({
      results: [{ id: "block-1" }, { id: "block-2" }],
    });

    const result = await notionWrite({
      action: "append",
      page_id: "page-123",
      blocks: [
        { type: "paragraph", text: "New content" },
        { type: "bulleted_list_item", text: "Item 1" },
      ],
    });

    expect(result).toMatchObject({
      page_id: "page-123",
      blocks_added: 2,
      appended: true,
    });
  });

  it("should throw if parent_id missing for create", async () => {
    await expect(
      notionWrite({ action: "create", title: "Test" })
    ).rejects.toThrow("parent_id is required");
  });
});
