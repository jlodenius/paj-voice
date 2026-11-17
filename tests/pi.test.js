import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const piBin = process.env.PAJ_VOICE_PI_BIN;
const realPi = { skip: !piBin, timeout: 45000 };
const verbose = 'This detailed screen-only explanation must never be automatically narrated. '.repeat(80);

async function fixture(t, fakeAudio = true) {
  const root = mkdtempSync(join(tmpdir(), 'paj-voice-pi-'));
  const agent = join(root, 'agent');
  const extensions = join(agent, 'extensions');
  mkdirSync(extensions, { recursive: true });
  mkdirSync(join(root, 'runtime'), { mode: 0o700 });
  const journal = join(root, 'audio.jsonl');
  writeFileSync(journal, '');
  const fixturePath = name => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));
  writeFileSync(join(extensions, 'inspect.ts'),
    `export { default } from ${JSON.stringify(fixturePath('inspect'))};\n`);
  if (fakeAudio) {
    const name = fakeAudio === 'trial' ? 'agent-trial' : 'voice';
    const path = fakeAudio === 'host-loader' ? process.env.PAJ_VOICE_HOST_LOADER : fixturePath(name);
    writeFileSync(join(extensions, 'voice.ts'),
      `export { default } from ${JSON.stringify(path)};\n`);
  } else {
    symlinkSync(packageRoot, join(extensions, 'paj-voice'));
  }
  writeFileSync(join(agent, 'paj.json'), JSON.stringify({
    subagents: { opaqueFixture: true }, captain: { opaqueFixture: true },
    voice: { version: 1, languages: ['en'], responseLanguage: 'en',
      stt: { model: '/nonexistent/stt' }, tts: { model: '/nonexistent/tts.onnx' },
      audio: { input: 'fake', output: 'fake', echoCancellation: 'external' } },
  }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always',
    cacheWarming: 'off', enableInstallTelemetry: false, retry: { enabled: false },
    compaction: { enabled: false } }));
  const requests = [];
  let held;
  let responseMode = 'text';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ payload, headers: req.headers });
    if (held) {
      const current = held;
      held = undefined;
      current.started();
      await current.wait;
    }
    let delta = { role: 'assistant', content: verbose };
    let finish = 'stop';
    if (responseMode === 'short') {
      responseMode = 'text';
      delta = { role: 'assistant', content: 'There are sixty seconds in one minute.' };
    } else if (responseMode === 'ordinary-tool') {
      responseMode = 'text';
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'normal-permissions', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'printf v1-tool-allowed' }) } }] };
      finish = 'tool_calls';
    } else if (responseMode === 'canary') {
      responseMode = 'text';
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'forbidden-canary', type: 'function',
        function: { name: 'voice_trial_canary', arguments: '{}' } }] };
      finish = 'tool_calls';
    }
    if (responseMode === 'speak') {
      responseMode = 'text';
      const context = JSON.stringify(payload.messages);
      const token = context.match(/generation=\\"([^"\\]+)\\", epoch=(\d+)/);
      if (!token) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Voice delivery token did not reach provider' } }));
        return;
      }
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'intentional-speech', type: 'function',
        function: { name: 'voice_speak', arguments: JSON.stringify({ text: 'The isolated test passed.',
          generation: token[1], epoch: Number(token[2]) }) } }] };
      finish = 'tool_calls';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = value => res.write(`data: ${JSON.stringify({ id: 'fake-provider-response',
      object: 'chat.completion.chunk', created: 1, model: 'fixture', ...value })}\n\n`);
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'voice-test-local': {
    api: 'openai-completions', apiKey: 'fake-local-only',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', name: 'Fixture',
      reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/API_KEY|TOKEN|SECRET|CREDENTIAL|^PAJ_|^CAPTAIN_|^PI_|^ANTHROPIC_|^OPENAI_|^AWS_|^GOOGLE_|^AZURE_|^XDG_/.test(key)));
  Object.assign(env, { HOME: root, PI_CODING_AGENT_DIR: agent, XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'), VOICE_TEST_JOURNAL: journal });
  const child = spawn(piBin, ['--offline', '--mode', 'rpc', '--no-session',
    '--provider', 'voice-test-local', '--model', 'fixture', '--thinking', 'off'],
  { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  const pending = new Map();
  const waiters = new Set();
  let next = 0;
  let buffer = '';
  let errors = '';
  const fail = error => {
    for (const request of pending.values()) request.reject(error);
    for (const waiter of waiters) waiter.reject(error);
    pending.clear();
    waiters.clear();
  };
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('error', fail);
  child.on('exit', () => fail(new Error(`Pi exited: ${errors}`)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('{')) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === 'response') {
        pending.get(event.id)?.resolve(event);
        pending.delete(event.id);
      }
      for (const waiter of waiters) if (waiter.predicate(event)) {
        waiter.resolve(event);
        waiters.delete(waiter);
      }
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    for (const request of requests) assert.equal(request.headers.authorization, 'Bearer fake-local-only');
  });
  async function request(type, extra = {}) {
    const id = `voice-request-${++next}`;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    const result = await response;
    assert.equal(result.success, true, result.error || errors);
    return result.data;
  }
  async function command(message) {
    const start = events.length;
    assert.equal((await request('prompt', { message })).disposition, 'handled');
    return events.slice(start).filter(event => event.method === 'notify');
  }
  const settled = () => new Promise((resolve, reject) => waiters.add({
    predicate: event => event.type === 'agent_settled', resolve, reject,
  }));
  async function prompt(message) {
    const done = settled();
    assert.equal((await request('prompt', { message })).disposition, 'started');
    await done;
  }
  const inspect = async () => JSON.parse((await command('/voice-test-inspect')).at(-1).message);
  return { request, command, prompt, settled, inspect, requests, events,
    speakNext: () => { responseMode = 'speak'; },
    shortNext: () => { responseMode = 'short'; }, canaryNext: () => { responseMode = 'canary'; },
    ordinaryToolNext: () => { responseMode = 'ordinary-tool'; },
    holdNext() {
      let release, started;
      const wait = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { started = resolve; });
      held = { started, wait };
      return { ready, release };
    } };
}

test('real Pi voice trial speaks final text and vetoes an adversarially re-enabled tool', realPi, async t => {
  const f = await fixture(t, 'trial');
  await f.command('/trial-test-prepare');
  assert.deepEqual((await f.inspect()).active, []);
  f.shortNext();
  let done = f.settled();
  await f.command('/trial-test-utterance How many seconds are in a minute?');
  await done;
  let snapshot = await f.inspect();
  assert.equal(snapshot.journal.find(frame => frame.type === 'answer')?.text,
    'There are sixty seconds in one minute.');
  assert.match(JSON.stringify(f.requests[0].payload.messages), /ALL model tool calls are blocked/);
  f.canaryNext();
  done = f.settled();
  await f.command('/trial-test-utterance Try to execute the forbidden test tool.');
  await done;
  snapshot = await f.inspect();
  assert.ok(snapshot.journal.some(frame => frame.type === 'blocked' && frame.tool === 'voice_trial_canary'));
  assert.ok(!snapshot.journal.some(frame => frame.type === 'CANARY_EXECUTED'));
  await f.command('/trial-test-release');
  assert.ok((await f.inspect()).active.includes('bash'));
});

test('real Pi preserves two additions during provider processing and suppresses the old answer', realPi, async t => {
  const f = await fixture(t, 'trial');
  await f.command('/trial-test-prepare');
  const held = f.holdNext();
  f.shortNext();
  const done = f.settled();
  try {
    await f.command('/trial-test-utterance First question.');
    await held.ready;
    await f.command('/trial-test-utterance An addition while processing.');
    await f.command('/trial-test-utterance A second correction.');
  } finally { held.release(); }
  await done;
  const snapshot = await f.inspect();
  const context = JSON.stringify(f.requests.at(-1).payload.messages);
  assert.match(context, /First question/);
  assert.match(context, /An addition while processing/);
  assert.match(context, /A second correction/);
  assert.ok(snapshot.journal.some(frame => frame.type === 'stale_answer' && frame.generation === 1));
  assert.deepEqual(snapshot.journal.filter(frame => frame.type === 'answer').map(frame => frame.generation), [3]);
  await f.command('/trial-test-release');
});

test('production open mic speaks a short answer and preserves normal Pi tool execution', realPi, async t => {
  const f = await fixture(t);
  await f.command('/paj-voice on');
  await f.command('/voice-test-ready');
  f.shortNext();
  let done = f.settled();
  await f.command('/voice-test-utterance How many seconds in a minute?');
  await done;
  let snapshot = await f.inspect();
  assert.ok(snapshot.journal.some(frame => frame.type === 'speak' && frame.text === 'There are sixty seconds in one minute.'));
  f.ordinaryToolNext();
  done = f.settled();
  await f.command('/voice-test-utterance Run the harmless normal-permissions test.');
  await done;
  assert.ok(f.events.some(event => event.type === 'tool_execution_end' && event.toolName === 'bash' && !event.isError));
  await f.command('/paj-voice off');
  snapshot = await f.inspect();
  assert.ok(snapshot.active.includes('bash'));
  assert.ok(snapshot.journal.some(frame => frame.type === 'closed'));
});

test('real Pi sends interrupted answer delivery context with a separate continuation', realPi, async t => {
  const f = await fixture(t);
  await f.command('/paj-voice on');
  await f.command('/voice-test-ready');
  f.shortNext();
  let done = f.settled();
  await f.command('/voice-test-utterance Tell me how many seconds');
  await done;
  f.shortNext();
  done = f.settled();
  await f.command('/voice-test-utterance in a minute');
  await done;
  const messages = f.requests.at(-1).payload.messages;
  const texts = messages.flatMap(message => typeof message.content === 'string' ? [message.content]
    : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text));
  assert.ok(texts.some(text => text.includes('"status":"interrupted"') &&
    text.includes('"reason":"new_speech"') && text.includes('"key":"answer"') &&
    text.includes('There are sixty seconds in one minute.')));
  assert.ok(texts.some(text => text.includes('Never rerun tools')));
  assert.equal(f.requests.length, 2);
  assert.equal(f.events.filter(event => event.type === 'tool_execution_start').length, 0);
  await f.command('/paj-voice off');
});

test('host immutable-build loader registers current status without opening audio', {
  ...realPi, skip: !piBin || !process.env.PAJ_VOICE_HOST_LOADER,
}, async t => {
  const f = await fixture(t, 'host-loader');
  const notices = await f.command('/paj-voice status');
  assert.ok(notices.some(event => event.message.includes('"lastError":null')));
  assert.ok(notices.some(event => event.message.includes('Extension build: /nix/store/')));
  assert.equal(f.requests.length, 0);
  assert.deepEqual((await f.inspect()).journal, []);
});

function assertHidden(snapshot) {
  assert.ok(!snapshot.active.includes('voice_speak'));
  assert.equal(snapshot.all.find(tool => tool.name === 'voice_speak').exposure, 'hidden');
  assert.equal(snapshot.replies.length, 1);
  assert.equal(snapshot.replies[0].enabled, false);
}

function assertVoiceContext(request, enabled) {
  const messages = request.payload.messages;
  assert.ok(messages.every(message => ['system', 'user', 'assistant', 'tool'].includes(message.role)));
  const policy = messages.filter(message => JSON.stringify(message.content).includes('Eyes-free voice is active'));
  assert.equal(policy.length, enabled ? 1 : 0);
  if (enabled) assert.equal(policy[0].role, 'user');
  const speak = request.payload.tools?.find(tool => tool.function.name === 'voice_speak');
  assert.equal(Boolean(speak), enabled);
  if (speak) {
    assert.equal(speak.function.parameters.type, 'object');
    assert.equal(speak.function.parameters.properties.text.maxLength, 320);
    assert.equal(speak.function.parameters.properties.epoch.type, 'integer');
    assert.deepEqual(speak.function.parameters.required, ['text', 'generation', 'epoch']);
  }
}

test('real Pi loads the package and TypeBox tool without Paj; RPC cannot open audio', realPi, async t => {
  const f = await fixture(t, false);
  const commands = (await f.request('get_commands')).commands;
  assert.ok(commands.some(command => command.name === 'paj-voice'));
  assert.ok(!commands.some(command => ['captain', 'agent-name'].includes(command.name)));
  assertHidden(await f.inspect());
  const notices = await f.command('/paj-voice on');
  assert.ok(notices.some(event => event.notifyType === 'error' && event.message.includes('main Pi TUI')));
  assertHidden(await f.inspect());
  assert.ok((await f.command('/paj-voice status')).some(event => event.message.includes('Preferences:')));
  await f.command('/paj-voice off');
  await f.prompt('Only the isolated fake provider may answer.');
  assert.equal(f.requests.length, 1);
  assertVoiceContext(f.requests[0], false);
  assert.deepEqual((await f.inspect()).journal, []);
});

test('real Pi projects voice custom context and executes only intentional concise speech', realPi, async t => {
  const f = await fixture(t);
  assertHidden(await f.inspect());
  await f.command('/paj-voice on');
  const starting = await f.inspect();
  assertHidden(starting);
  assert.equal(starting.replies[0].starting, true);
  const opened = starting.journal.find(frame => frame.type === 'opened');
  assert.equal(opened.config.stt.model, '/nonexistent/stt');
  assert.equal(opened.config.stt.hotwords, undefined);
  assert.equal(Object.hasOwn(opened.config, 'voice'), false);
  assert.equal(Object.hasOwn(opened.config, 'subagents'), false);
  await f.prompt('Before the fake worker is ready.');
  assertVoiceContext(f.requests.at(-1), false);
  await f.command('/voice-test-ready');
  const ready = await f.inspect();
  assert.equal(ready.replies[0].enabled, true);
  assert.ok(ready.active.includes('voice_speak'));
  await f.prompt('Give a detailed screen answer but do not call voice_speak.');
  assertVoiceContext(f.requests.at(-1), true);
  let spoken = (await f.inspect()).journal.filter(frame => frame.type === 'speak');
  assert.deepEqual(spoken.map(frame => frame.text),
    ['I’ve finished this response, but did not produce a spoken summary. Ask me to summarize the result aloud.']);
  f.speakNext();
  const start = f.requests.length;
  await f.prompt('Give one intentional spoken result.');
  assert.equal(f.requests.length, start + 2);
  for (const request of f.requests.slice(start)) assertVoiceContext(request, true);
  spoken = (await f.inspect()).journal.filter(frame => frame.type === 'speak');
  assert.deepEqual(spoken.map(frame => frame.text),
    ['I’ve finished this response, but did not produce a spoken summary. Ask me to summarize the result aloud.',
      'The isolated test passed.', 'I’m finished for now.']);
  const result = f.events.find(event => event.type === 'tool_execution_end' && event.toolName === 'voice_speak');
  assert.equal(result.isError, false);
  assert.equal(result.result.details.status, 'queued');
  assert.ok(f.events.some(event => event.type === 'message_end' && event.message.role === 'assistant' &&
    event.message.content.some(block => block.type === 'text' && block.text === verbose)));
  await f.command('/paj-voice off');
  const off = await f.inspect();
  assertHidden(off);
  assert.equal(off.journal.filter(frame => frame.type === 'closed').length, 1);
  await f.command('/voice-test-ready');
  assertHidden(await f.inspect());
  await f.prompt('Voice is now off.');
  assertVoiceContext(f.requests.at(-1), false);
  assert.equal((await f.inspect()).journal.filter(frame => frame.type === 'speak').length, 3);
});

test('real Pi without Paj admits fake speech and reload disposes worker and event subscriptions', realPi, async t => {
  const f = await fixture(t);
  await f.command('/paj-voice on');
  await f.command('/voice-test-ready');
  const done = f.settled();
  await f.command('/voice-test-utterance A request from the fake microphone.');
  await done;
  assert.equal(f.requests.length, 1);
  assert.ok(JSON.stringify(f.requests[0].payload.messages).includes('A request from the fake microphone.'));
  assertVoiceContext(f.requests[0], true);
  const before = await f.inspect();
  assert.equal(before.journal.filter(frame => frame.type === 'opened').length, 1);
  await f.command('/voice-test-reload');
  const reloaded = await f.inspect();
  assertHidden(reloaded);
  assert.equal(reloaded.journal.filter(frame => frame.type === 'closed').length, 1);
  await f.prompt('Reload must not retain voice context.');
  assertVoiceContext(f.requests.at(-1), false);
  await f.command('/paj-voice on');
  await f.command('/voice-test-ready');
  const restarted = await f.inspect();
  assert.equal(restarted.replies.length, 1);
  assert.equal(restarted.replies[0].enabled, true);
  assert.notEqual(restarted.replies[0].generation, before.replies[0].generation);
  await f.command('/paj-voice off');
  const final = await f.inspect();
  assertHidden(final);
  assert.equal(final.journal.filter(frame => frame.type === 'opened').length, 2);
  assert.equal(final.journal.filter(frame => frame.type === 'closed').length, 2);
});
