import { appendFileSync } from 'node:fs';
import { Type } from 'typebox';
import { registerVoice } from '../../src/extension.js';

export default function (pi) {
  const journal = process.env.VOICE_TEST_JOURNAL;
  let worker;
  let serial = 0;
  const record = value => appendFileSync(journal, `${JSON.stringify(value)}\n`);
  const wrapped = new Proxy(pi, {
    get(target, name) {
      if (name !== 'registerCommand') return Reflect.get(target, name);
      return (command, definition) => target.registerCommand(command, {
        ...definition,
        handler: (args, ctx) => definition.handler(args, { ...ctx, mode: 'tui', hasUI: true,
          ui: { ...ctx.ui, confirm: async () => true } }),
      });
    },
  });
  registerVoice(wrapped, Type, {
    startCompanion(options) {
      worker = options;
      record({ type: 'opened', generation: options.generation, config: options.config });
      return {
        send(frame) { record(frame); return true; },
        close() { record({ type: 'closed', generation: options.generation }); },
      };
    },
  });
  pi.registerCommand('voice-test-ready', {
    description: 'Signal fake audio worker readiness',
    handler: async () => worker.onEvent({ type: 'ready' }, worker.generation),
  });
  pi.registerCommand('voice-test-utterance', {
    description: 'Submit fake addressed speech without audio',
    handler: async text => {
      const id = `fake-capture-${++serial}`;
      worker.onEvent({ type: 'addressed', id }, worker.generation);
      worker.onEvent({ type: 'utterance', id, text }, worker.generation);
    },
  });
}
