# Setup Guide

## Prerequisites

- Node.js 22+
- A Notion account with API access
- A Notion integration (API key)

## 1. Create a Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **"New integration"**
3. Name it "Agent Hub" (or whatever you prefer)
4. Select the workspace you want to use
5. Under **Capabilities**, enable:
   - Read content
   - Update content
   - Insert content
   - Read user information (optional)
6. Copy the **Internal Integration Secret** (starts with `ntn_`)

## 2. Set Up the Task Database

Create a new Notion database with these properties:

| Property | Type   | Description                           |
|----------|--------|---------------------------------------|
| Name     | Title  | Task name/description                 |
| Status   | Status | Pending → Running → Done / Failed     |
| Type     | Select | research / github-tracker / content-pipeline |
| Input    | Text   | JSON input for the task               |
| Output   | Text   | JSON result (filled by agents)        |
| Error    | Text   | Error message if task failed          |

### Status Options

Configure the Status property with these groups:

- **To-do:** Pending
- **In progress:** Running
- **Complete:** Done, Failed

### Share with Integration

1. Open the database page
2. Click **"..."** → **"Connections"**
3. Find and add your "Agent Hub" integration

## 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
NOTION_API_KEY=ntn_your_integration_secret
NOTION_DATABASE_ID=your_database_id
OPENAI_API_KEY=sk-your_openai_key  # Optional, for content generation
```

To find your database ID:
1. Open the database in Notion
2. The URL looks like: `notion.so/workspace/DATABASE_ID?v=...`
3. Copy the 32-character ID (add hyphens: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

## 4. Install & Build

```bash
npm install
npm run build
```

## 5. Run as MCP Server

### With Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "notion-agent-hub": {
      "command": "node",
      "args": ["/path/to/notion-agent-hub/dist/index.js"],
      "env": {
        "NOTION_API_KEY": "ntn_your_key",
        "NOTION_DATABASE_ID": "your_db_id"
      }
    }
  }
}
```

### Standalone

```bash
npm start
```

## 6. Test It

Create a task in your Notion database:
- **Name:** "Research: TypeScript MCP servers"
- **Type:** research
- **Status:** Pending
- **Input:** `{"topic": "TypeScript MCP servers", "parent_id": "your_page_id"}`

The agent will pick it up, search the web, and create a research page in Notion!
