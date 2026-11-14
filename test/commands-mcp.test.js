// Your own slash commands (files) and MCP servers (omp's /mcp commands, output kept out of the chat).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { activate } = require('./helper');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-cmds-'));
const trashed = [];
const { provider, posts, last } = activate({ vs: {
  workspace: { fs: { delete: async (uri) => { trashed.push(uri.fsPath); fs.unlinkSync(uri.fsPath); } } },
} });
provider.cwd = dir;
const prompts = [];
let mcpList = 'github | stdio | enabled | npx [user]\nlocal-db | http | disabled | https://db.example.com/mcp [project]';
provider.client = {
  request: async (c) => {
    if (c.type !== 'prompt') return {};
    prompts.push(c.message);
    const out = c.message === '/mcp list' ? mcpList : c.message.startsWith('/mcp ') ? `ok: ${c.message}` : 'Reloaded.';
    provider.onRecord({ type: 'command_output', text: out });
    return { agentInvoked: false };
  },
};
provider.ensureClient = async () => provider.client;
let answer = null;
provider.ask = async () => answer;

(async () => {
  const { listCommandFiles, commandFileText, parseMcpList } = require('../extension.js')._test;
  // frontmatter, quotes and new lines in the description stay valid YAML
  assert.strictEqual(commandFileText({ description: 'Review "it"\nnow', hint: '<file>', prompt: 'Review $ARGUMENTS\n' }),
    '---\ndescription: "Review \\"it\\" now"\nargument-hint: "<file>"\n---\n\nReview $ARGUMENTS\n');

  // create from the form: written to .omp/commands, omp reloads, listed with its description
  answer = { name: '/review', description: 'Review a file', hint: '<file>', prompt: 'Review $ARGUMENTS for bugs.', scope: 'project' };
  await provider.newCommand();
  const file = path.join(dir, '.omp', 'commands', 'review.md');
  assert(fs.existsSync(file));
  assert(prompts.includes('/reload-plugins'));
  let sheet = last('commandsSheet');
  assert.strictEqual(sheet.note, 'Created /review.');
  assert.deepStrictEqual(sheet.list.map((c) => [c.name, c.description, c.hint, c.scope]).filter((c) => c[0] === 'review'), [['review', 'Review a file', '<file>', 'project']]);
  // Claude Code commands in the project are listed too; no frontmatter -> first line as description
  fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'commands', 'plan.md'), '\nMake a plan for $ARGUMENTS.\n');
  assert.deepStrictEqual(listCommandFiles(dir).filter((c) => c.file.startsWith(dir)).map((c) => [c.name, c.description, c.scope]),
    [['review', 'Review a file', 'project'], ['plan', 'Make a plan for $ARGUMENTS.', 'project · .claude']]);
  // bad names and duplicates are refused
  answer = { ...answer, name: '../evil' };
  await provider.newCommand();
  assert(/not a valid name/.test(last('commandsSheet').note));
  answer = { ...answer, name: 'review' };
  await provider.newCommand();
  assert.strictEqual(last('commandsSheet').note, '/review already exists.');
  // delete: only files from the list; moved to the trash
  await provider.deleteCommand(path.join(dir, 'package.json'));
  assert.deepStrictEqual(trashed, []);
  await provider.deleteCommand(file);
  assert.deepStrictEqual(trashed, [file]);
  assert(/Deleted \/review/.test(last('commandsSheet').note));

  // MCP: the list is parsed, nothing reaches the chat
  assert.deepStrictEqual(parseMcpList('No MCP servers configured.'), []);
  posts.length = 0;
  await provider.showMcp();
  sheet = last('mcpSheet');
  assert.deepStrictEqual(sheet.servers.map((s) => [s.name, s.type, s.enabled, s.scope]), [['github', 'stdio', true, 'user'], ['local-db', 'http', false, 'project']]);
  assert(!posts.some((p) => p.type === 'command_output'), 'quiet commands stay out of the chat');
  assert(!sheet.changed);
  // switch, remove (with its scope), unknown names ignored
  await provider.mcpAction('enable', 'local-db');
  await provider.mcpAction('remove', 'github');
  await provider.mcpAction('remove', 'nope; rm -rf');
  await provider.mcpAction('format', 'github');
  assert.deepStrictEqual(prompts.filter((p) => /^\/mcp (enable|remove|format)/.test(p)), ['/mcp enable local-db', '/mcp remove github --scope user']);
  assert(last('mcpSheet').changed && /ok: \/mcp remove github/.test(last('mcpSheet').note));
  // add: command or URL, validated
  answer = { name: 'fs', kind: 'command', target: 'npx -y @modelcontextprotocol/server-filesystem .', scope: 'project' };
  await provider.addMcp();
  answer = { name: 'remote', kind: 'url', target: 'https://mcp.example.com/sse', scope: 'user' };
  await provider.addMcp();
  answer = { name: 'bad', kind: 'url', target: 'https://x.com/a b', scope: 'user' };
  await provider.addMcp();
  assert(/must start with http/.test(last('mcpSheet').note));
  assert.deepStrictEqual(prompts.filter((p) => p.startsWith('/mcp add')),
    ['/mcp add fs --scope project -- npx -y @modelcontextprotocol/server-filesystem .', '/mcp add remote --scope user --url https://mcp.example.com/sse']);
  // apply: restart keeps the conversation
  let restarted = 0;
  provider.restart = async () => { restarted++; };
  await provider.applyMcp();
  assert.strictEqual(restarted, 1);
  assert(!provider.mcpChanged);
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
