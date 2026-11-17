function appearance(state) {
  if (state.muted) return { badge: 'MIC CLOSED', tone: 'muted',
    activity: state.processing ? 'Agent working - audio muted' : 'Voice paused - microphone closed',
    detail: 'Mute does not stop agent work.', controls: 'Resume: /paj-voice unmute   Off: /paj-voice off' };
  if (state.starting) return { badge: 'warming up', tone: 'warning',
    activity: 'STARTING - preparing local speech', detail: 'Remain quiet until the ready beep.',
    controls: 'Cancel: /paj-voice off' };
  if (!state.enabled) return null;
  return { badge: 'OPEN MIC', tone: 'warning',
    activity: state.capturing ? 'RECEIVING SPEECH - agent work may continue'
      : state.speaking ? 'SPEAKING - interrupt with your voice'
        : state.processing ? 'WORKING - microphone still listening' : 'READY - listening for your request',
    detail: 'All recognized speech is actionable with normal tools.',
    controls: 'Mute: /paj-voice mute   Off: /paj-voice off' };
}

const fg = (theme, color, text) => theme?.fg?.(color, text) ?? text;
const bold = (theme, text) => theme?.bold?.(text) ?? text;
const fit = (text, width) => text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;

export function voiceStatus(state, theme) {
  const view = appearance(state);
  return view ? fg(theme, view.tone, bold(theme, `VOICE MODE | ${view.badge}`)) : undefined;
}

export function voiceWidget(state) {
  const view = appearance(state);
  if (!view) return undefined;
  return (_tui, theme) => ({
    render(width) {
      width = Math.max(1, Math.floor(width));
      if (width < 8) return [fg(theme, view.tone, fit(view.badge, width))];
      const inside = width - 4;
      const background = text => theme?.bg?.('customMessageBg', text) ?? text;
      const row = (text, color, strong = false) => {
        const content = fit(text, inside).padEnd(inside);
        return background(fg(theme, 'warning', '│ ') +
          fg(theme, color, strong ? bold(theme, content) : content) + fg(theme, 'warning', ' │'));
      };
      const heading = fit(` VOICE MODE | ${view.badge} `, width - 2);
      return [
        background(fg(theme, 'warning', '╭') + fg(theme, view.tone, bold(theme, heading)) +
          fg(theme, 'warning', '─'.repeat(width - 2 - heading.length) + '╮')),
        row(view.activity, view.tone, true),
        row(view.detail, 'muted'),
        row(view.controls, 'dim'),
        background(fg(theme, 'warning', '╰' + '─'.repeat(width - 2) + '╯')),
      ];
    },
    invalidate() {},
  });
}
