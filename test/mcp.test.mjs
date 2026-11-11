import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.mjs';

// Il contratto che vede ChatGPT: quali strumenti esistono e che una chiamata arrivi.
// La logica (ACL, selezione, idempotenza) e' provata in mcp-tools.test.mjs.

const fakeTools = () => ({
  list_chats: { inputSchema: {}, run: async () => ({ content: [{ type: 'text', text: 'chat: A' }], structuredContent: { chats: [{ session_id: 'a' }] } }) },
  select_chat: { inputSchema: { session_id: z.string() }, run: async (args) => ({ content: [{ type: 'text', text: `scelta ${args.session_id}` }] }) },
  talk: { inputSchema: { message: z.string().optional() }, run: async (args) => ({ content: [{ type: 'text', text: `RICEVUTO ${args.message}` }], structuredContent: { status: 'done' } }) },
  get_turn_status: { inputSchema: { request_id: z.string().optional() }, run: async () => ({ content: [{ type: 'text', text: 'in corso' }] }) },
});

async function connectPair(tools) {
  const server = createMcpServer({ tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

test('gli strumenti esposti sono quattro, con descrizione', { timeout: 20_000 }, async () => {
  const { client, server } = await connectPair(fakeTools());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_turn_status', 'list_chats', 'select_chat', 'talk']);
    for (const tool of tools) {
      assert.ok(tool.description.length > 30, `${tool.name} deve spiegarsi`);
      assert.equal(tool.inputSchema.type, 'object');
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('una chiamata arriva allo strumento e torna indietro', { timeout: 20_000 }, async () => {
  const { client, server } = await connectPair(fakeTools());
  try {
    const result = await client.callTool({ name: 'talk', arguments: { message: 'ciao' } });
    assert.equal(result.content[0].text, 'RICEVUTO ciao');
    assert.equal(result.structuredContent.status, 'done');

    const chats = await client.callTool({ name: 'list_chats', arguments: {} });
    assert.equal(chats.structuredContent.chats[0].session_id, 'a');
  } finally {
    await client.close();
    await server.close();
  }
});

test('gli schemi veri arrivano a ChatGPT convertiti, non svuotati', { timeout: 20_000 }, async () => {
  // Non è la stessa cosa degli strumenti finti qui sopra: questi sono quelli veri, con
  // `.max()`, `.int()`, `.optional()` e `.describe()`. È il punto dove un cambio di versione
  // della libreria degli schemi può togliere silenziosamente un limite o una descrizione — e
  // ChatGPT vedrebbe uno strumento che accetta qualsiasi cosa.
  const { createMcpTools } = await import('../src/mcp/tools.mjs');
  const { loadConfig } = await import('../src/config.mjs');
  const config = { ...loadConfig({}), maxMessageChars: 1000, maxWaitSeconds: 300, defaultWaitSeconds: 25 };
  const registry = {
    mcpAllowed: () => [],
    get: () => null,
  };
  const tools = createMcpTools({ config, registry, coordinator: { submit: () => { throw new Error('non usato'); } }, selections: { get: () => null }, clientId: 'c1' });

  const { client, server } = await connectPair(tools);
  try {
    const { tools: listed } = await client.listTools();
    const byName = Object.fromEntries(listed.map((tool) => [tool.name, tool]));

    const talk = byName.talk.inputSchema;
    assert.equal(talk.type, 'object');
    assert.deepEqual(talk.required, ['message'], 'message è obbligatorio, gli altri no');
    assert.equal(talk.properties.message.type, 'string');
    assert.equal(talk.properties.message.maxLength, 1000, 'il tetto alla lunghezza deve arrivare');
    assert.equal(talk.properties.wait_seconds.type, 'integer', 'intero, non numero con la virgola');
    assert.equal(talk.properties.wait_seconds.minimum, 5);
    // Il tetto dello **schema** è largo di proposito: il limite vero è il clamp a
    // `config.maxWaitSeconds`, che risponde invece di rifiutare. Qui si controlla solo che il
    // numero arrivi al client — se sparisse, ChatGPT potrebbe chiedere attese arbitrarie.
    assert.equal(talk.properties.wait_seconds.maximum, 600);
    assert.ok(talk.properties.request_id.description.includes('twice'), 'e la descrizione resta');

    assert.ok(byName.select_chat.inputSchema.required.includes('session_id'));
    assert.equal(byName.list_chats.inputSchema.type, 'object');
    assert.equal(byName.get_turn_status.inputSchema.required, undefined, 'nessun argomento obbligatorio');
  } finally {
    await client.close();
    await server.close();
  }
});
