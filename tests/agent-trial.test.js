import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerAgentTrial, spokenAnswer } from '../src/agent-trial-extension.js';

function fixture(entries = []) {
  const handlers = new Map(), commands = new Map(), events = new EventEmitter();
  const notices = [], messages = [], answers = [], stages = [];
  let tools = ['read', 'bash', 'codemode'], busy = false, pending = false, server, session = 'chosen';
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => !busy, hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => session, getBranch: () => entries },
    ui: { notify: text => notices.push(text), setStatus() {}, confirm: async () => true } };
  const pi = {
    events: { emit: (...args) => events.emit(...args),
      on(name, handler) { events.on(name, handler); return () => events.off(name, handler); } },
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools: () => [...tools], setActiveTools: value => { tools = [...value]; },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendUserMessage(...args) { messages.push(args); busy = true; },
  };
  registerAgentTrial(pi, { allowedSessionId: 'chosen', projectRoot: '/project', env: {},
    async makeServer(options) {
      server = { ...options, socketPath: '/private/agent.sock', closed: false,
        close() { this.closed = true; options.onClose('closed'); },
        answer(...args) { answers.push(args); return true; },
        status(...args) { stages.push(args); } };
      return server;
    } });
  return { ctx, pi, entries, events, messages, answers, notices, stages,
    event: (name, event = {}) => handlers.get(name)?.(event, ctx),
    command: value => commands.get('voice-trial').handler(value, ctx),
    server: () => server, tools: () => tools,
    idle() { busy = false; pending = false; }, queued() { pending = true; },
    replace() { session = 'another-session'; } };
}

const assistant = text => ({ message: { role: 'assistant', stopReason: 'stop', content: [
  { type: 'thinking', thinking: 'never speak this' }, { type: 'text', text },
] } });

test('dormant until prepare; exact session pin and runtime veto cover all tools', async () => {
  const f = fixture();
  await f.event('session_start');
  assert.equal(f.server(), undefined);
  assert.equal(await f.event('tool_call', { toolName: 'bash' }), undefined);
  await f.command('prepare');
  assert.deepEqual(f.tools(), []);
  assert.equal(f.entries.at(-1).data.active, true);
  for (const toolName of ['read', 'bash', 'write', 'codemode', 'mcp__dangerous', 'send_agent_message']) {
    assert.equal((await f.event('tool_call', { toolName, parentToolCallId: 'nested' })).block, true);
  }
  await f.command('off');
  assert.equal(f.server().closed, true);
  assert.equal((await f.event('tool_call')).block, true);
  f.replace();
  await f.command('prepare');
  assert.match(f.notices.at(-1), /pinned|original/);
});

test('older utterances are retained, slash text is literal, replies bind actual provider context', async () => {
  const f = fixture();
  await f.event('session_start');
  await f.command('prepare');
  const server = f.server();
  server.onOnset(1);
  server.onUtterance({ sequence: 1, generation: 1, text: '/dangerous-command' });
  assert.equal(f.messages[0][1].expandPromptTemplates, false);
  assert.equal(f.messages[0][1].deliverAs, 'steer');
  assert.match(f.messages[0][0], /\n\/dangerous-command$/);
  await f.event('before_agent_start', { messageType: 'user', prompt: f.messages[0][0], systemPrompt: 'base', systemPromptOptions: { sections: {} } });
  await f.event('context', { messages: [{ role: 'user', content: f.messages[0][0] }] });
  server.onOnset(2);
  server.onUtterance({ sequence: 2, generation: 1, text: 'an older decode still matters' });
  server.onUtterance({ sequence: 3, generation: 2, text: 'actually answer this instead' });
  await f.event('message_end', assistant('The first answer.'));
  assert.deepEqual(f.answers.at(-1), [1, 'The first answer.']);
  await f.event('context', { messages: [{ role: 'user', content: [{ type: 'text', text: f.messages[2][0] }] }] });
  await f.event('message_end', assistant('The corrected answer.'));
  assert.deepEqual(f.answers.at(-1), [2, 'The corrected answer.']);
  assert.equal(f.messages.length, 3);
  assert.equal(f.ctx.abort, undefined);
});

test('missing reply association is reported rather than silently dropping the final answer', async () => {
  const f = fixture();
  await f.event('session_start');
  await f.command('prepare');
  f.server().onUtterance({ sequence: 1, generation: 1, text: 'a question' });
  await f.event('context', { messages: [{ role: 'user', content: 'unmatched context fixture' }] });
  await f.event('message_end', assistant('A short final answer.'));
  assert.equal(f.answers.length, 0);
  assert.ok(f.stages.some(([stage, reason]) => stage === 'reply' && reason === 'no_association'));
});

test('disconnect and busy release keep the guard; explicit idle release restores exact tools', async () => {
  const f = fixture();
  await f.event('session_start');
  await f.command('prepare');
  f.server().onUtterance({ sequence: 1, generation: 1, text: 'hello' });
  f.server().onClose('connection lost');
  await f.command('release');
  assert.deepEqual(f.tools(), []);
  assert.equal((await f.event('tool_call')).block, true);
  f.idle(); f.queued();
  await f.command('release');
  assert.deepEqual(f.tools(), []);
  f.idle();
  await f.command('release');
  assert.deepEqual(f.tools(), ['read', 'bash', 'codemode']);
  assert.equal(f.entries.at(-1).data.active, false);
  assert.equal(await f.event('tool_call'), undefined);
  assert.throws(() => f.server().onUtterance({ sequence: 2, generation: 1, text: 'late' }));
  assert.equal(f.messages.length, 1);
});

test('guard survives extension reload without reopening capture or a socket', async () => {
  const before = fixture();
  await before.event('session_start');
  await before.command('prepare');
  await before.event('session_shutdown');
  const after = fixture(before.entries);
  await after.event('session_start');
  assert.equal(after.server(), undefined);
  assert.deepEqual(after.tools(), []);
  assert.equal((await after.event('tool_call')).block, true);
  await after.command('release');
  assert.deepEqual(after.tools(), ['read', 'bash', 'codemode']);
});

test('typed/nonvoice input closes audio but does not lift the tool guard', async () => {
  const f = fixture();
  await f.event('session_start');
  await f.command('prepare');
  await f.event('input', { source: 'interactive' });
  assert.equal(f.server().closed, true);
  assert.equal((await f.event('tool_call')).block, true);
  await f.event('message_end', assistant('Typed answer must not be spoken.'));
  assert.equal(f.answers.length, 0);
});

test('Paj identity is reserved and revalidated; missing identity fails before tools are changed', async () => {
  const f = fixture();
  let identity = { piSessionId: 'chosen', pid: process.pid, role: 'primary' };
  let reserved = 0, released = 0;
  const api = { version: 1, getSnapshot: () => ({ identity, editorBusy: false }),
    tryReserve() { reserved++; return true; }, release() { released++; } };
  f.events.on('paj:external:v1', request => request.reply(api));
  await f.event('session_start');
  await f.command('prepare');
  assert.equal(reserved, 1);
  identity = { ...identity, piSessionId: 'different' };
  f.events.emit('paj:external:changed:v1');
  assert.equal(f.server().closed, true);
  assert.equal(released, 1);
  assert.equal((await f.event('tool_call')).block, true);
  const missing = fixture();
  identity = null;
  missing.events.on('paj:external:v1', request => request.reply(api));
  await missing.event('session_start');
  await missing.command('prepare');
  assert.equal(missing.server(), undefined);
  assert.deepEqual(missing.tools(), ['read', 'bash', 'codemode']);
});

test('speech takes only short final public text, never thinking, tool output, code or partial answers', () => {
  assert.equal(spokenAnswer(assistant('There are sixty seconds in one minute.').message), 'There are sixty seconds in one minute.');
  assert.equal(spokenAnswer({ role: 'toolResult', content: [{ type: 'text', text: 'private' }] }), null);
  for (const text of ['long '.repeat(100), '```bash rm -rf /```', 'See https://private.example', 'line\nbreak']) {
    assert.equal(spokenAnswer(assistant(text).message), null);
  }
  assert.equal(spokenAnswer({ ...assistant('partial').message, stopReason: 'aborted' }), null);
  assert.equal(spokenAnswer({ role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'private' }] }), null);
});
