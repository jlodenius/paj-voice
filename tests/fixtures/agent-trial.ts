import { appendFileSync } from 'node:fs';
import { Type } from 'typebox';
import { registerAgentTrial } from '../../src/agent-trial-extension.js';

export default function (pi) {
  let initialized = false, bridge, command, generation = 0, sequence = 0;
  const answered = new Set();
  const record = value => appendFileSync(process.env.VOICE_TEST_JOURNAL, JSON.stringify(value) + '\n');
  const adapt = ctx => ({ ...ctx, mode: 'tui', hasUI: true,
    ui: { ...ctx.ui, confirm: async () => true } });
  pi.registerTool({ name: 'voice_trial_canary', label: 'Forbidden test canary',
    description: 'Must be blocked by the read-only voice trial.', defaultActive: false,
    parameters: Type.Object({}),
    async execute() { record({ type: 'CANARY_EXECUTED' }); return { content: [{ type: 'text', text: 'unsafe' }], details: {} }; },
  });
  pi.registerCommand('trial-test-prepare', {
    description: 'Prepare fake audio with the real trial guard',
    async handler(_args, ctx) {
      if (!initialized) {
        initialized = true;
        let start;
        const wrapped = new Proxy(pi, { get(target, name) {
          if (name === 'registerCommand') return (_name, definition) => { command = definition; };
          if (name !== 'on') return Reflect.get(target, name);
          return (event, handler) => {
            if (event === 'session_start') { start = handler; return; }
            return target.on(event, async (value, current) => {
              const result = await handler(value, adapt(current));
              if (event === 'tool_call' && result?.block) record({ type: 'blocked', tool: value.toolName });
              return result;
            });
          };
        } });
        registerAgentTrial(wrapped, { allowedSessionId: ctx.sessionManager.getSessionId(),
          projectRoot: process.cwd(), env: {},
          async makeServer(options) {
            bridge = { ...options, socketPath: '/fake/no-audio', close() {},
              answer(target, text) {
                if (target !== generation || answered.has(target)) {
                  record({ type: 'stale_answer', generation: target });
                  return false;
                }
                answered.add(target);
                record({ type: 'answer', generation: target, text });
                return true;
              } };
            return bridge;
          } });
        start({}, adapt(ctx));
        pi.on('before_agent_start', () => { pi.setActiveTools(['voice_trial_canary']); });
      }
      await command.handler('prepare', adapt(ctx));
    },
  });
  pi.registerCommand('trial-test-utterance', {
    description: 'Fake recognized speech, no microphone',
    handler(text) {
      bridge.onOnset(++generation);
      bridge.onUtterance({ sequence: ++sequence, generation, text });
    },
  });
  pi.registerCommand('trial-test-release', {
    description: 'Release the fake trial guard',
    handler: (_args, ctx) => command.handler('release', adapt(ctx)),
  });
}
