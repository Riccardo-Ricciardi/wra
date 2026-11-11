import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const COPY = {
  list_chats: {
    title: 'Allowed chats',
    description: 'Lists the Claude Code chats the owner has authorized for MCP, with id, name, project and state. '
      + 'Unauthorized chats are not shown.',
  },
  select_chat: {
    title: 'Select chat',
    description: 'Selects the chat to talk to. The choice applies to THIS connection: it does not change other clients\' '
      + 'choice and does not change what the owner sees in the browser. Unauthorized chats are rejected.',
  },
  talk: {
    title: 'Talk to session',
    description: 'Sends a message to the selected chat and returns the reply. You can pass session_id to force the '
      + 'destination (authorized chats only) and request_id to make resubmission harmless: the same request_id is not '
      + 'executed twice. One turn per session at a time; if it is busy, the turn is queued. '
      + 'The target is frozen when the turn is accepted.',
  },
  get_turn_status: {
    title: 'Turn status',
    description: 'The status of a turn already requested (by request_id or turnId): queued, running with a partial, '
      + 'completed with the reply, or failed. For long turns without keeping a call blocked.',
  },
};

/** Registers the four tools. The implementations live in `tools.mjs`, bound to the client. */
export function createMcpServer({ tools }) {
  const mcp = new McpServer({ name: 'WRA', version: '0.2.0' });

  for (const [name, definition] of Object.entries(tools)) {
    const copy = COPY[name] ?? { title: name, description: name };
    mcp.registerTool(
      name,
      { title: copy.title, description: copy.description, inputSchema: definition.inputSchema },
      async (args) => definition.run(args),
    );
  }

  return mcp;
}