import { EventEmitter } from 'node:events';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { registerVoice } from '../../src/extension.ts';

const Type = Object.fromEntries(['Object', 'String', 'Optional', 'Integer'].map(name => [name, value => ({ type: name, value })]));
export function fixture(overrides = {}) {
  const events = new EventEmitter(), handlers = new Map(), tools = new Map(), commands = new Map();
  const notices = [], messages = [], frames = [], workers = [], widgets = [], transformers = [], statuses = [];
  let busy = false, id = 'session-one';
  const pi = {
    events: { emit: (...args) => events.emit(...args), on(name, handler) { events.on(name, handler); return () => events.off(name, handler); } },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerMarkdownTransformer(transform, options) { transformers.push({ transform, ...options }); },
    registerCommand(name, definition) { commands.set(name, definition); },
    sendUserMessage: (...args) => { messages.push(args); busy = true; },
    exec: async () => ({ code: 0, stdout: '["test microphone"]' }),
    setActiveTools() { throw new Error('Voice must not change normal tool permissions'); },
  };
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => !busy,
    sessionManager: { getSessionId: () => id },
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args), confirm: async () => true,
      setWidget(name, widget, options) {
        const component = typeof widget === 'function' ? widget(null, {}) : undefined;
        widgets.push({ name, lines: component ? component.render(80) : widget, component, options });
      } },
  };
  const config = {};
  const forbidden = () => { throw new Error('Fixture requires an explicit fake for this dependency'); };
  const defaults = { layout: { truncateToWidth, visibleWidth, wrapTextWithAnsi }, env: { XDG_CONFIG_HOME: '/dev/null' },
    loadConfig: () => config,
    loadDevices: () => ({ version: 1, input: 'laptop', output: 'headphones' }),
    loadRoutes: () => undefined,
    saveDevices: forbidden, saveRoute: forbidden, saveFallback: forbidden,
    startAudioFocus: forbidden, previewBackgroundAudio: forbidden,
    startCompanion(args) {
      const worker = { args, closed: false, send: frame => frames.push(frame), close() { this.closed = true; } };
      workers.push(worker);
      return worker;
    } };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, key) && !['uuid', 'buildId'].includes(key)) {
      throw new Error(`Unknown fixture override: ${key}`);
    }
  }
  const options = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(defaults)) {
    options[key] ??= value;
  }
  const instance = registerVoice(pi, Type, options);
  const event = async (name, data = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(data, ctx) ?? result;
    return result;
  };
  const command = args => commands.get('paj-voice').handler(args, ctx);
  const audio = frame => workers.at(-1).args.onEvent(frame, workers.at(-1).args.generation);
  return { ...instance, events, event, tools, pi, ctx, notices, messages, frames, workers, widgets, transformers, statuses, command, audio,
    idle() { busy = false; }, replace() { id = 'session-two'; } };
}
