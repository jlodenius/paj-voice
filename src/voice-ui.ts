import type { VoiceState } from './types.ts';

type VoiceDisplayState = Partial<VoiceState>;
type Tone = 'muted' | 'warning' | 'dim';
interface Theme {
  fg?(color: Tone, text: string): string;
  bg?(color: 'customMessageBg', text: string): string;
  bold?(text: string): string;
}

function appearance(state: VoiceDisplayState): {
  badge: string; tone: Tone; activity: string; detail: string; controls: string;
} | null {
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

const fg = (theme: Theme | undefined, color: Tone, text: string) => theme?.fg?.(color, text) ?? text;
const bold = (theme: Theme | undefined, text: string) => theme?.bold?.(text) ?? text;
const fit = (text: string, width: number) => text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;

export function voiceStatus(state: VoiceDisplayState, theme?: Theme) {
  const view = appearance(state);
  return view ? fg(theme, view.tone, bold(theme, `VOICE MODE | ${view.badge}`)) : undefined;
}

export function voiceWidget(state: VoiceDisplayState) {
  const view = appearance(state);
  if (!view) return undefined;
  return (_tui: unknown, theme?: Theme) => ({
    render(width: number) {
      width = Math.max(1, Math.floor(width));
      if (width < 8) return [fg(theme, view.tone, fit(view.badge, width))];
      const inside = width - 4;
      const background = (text: string) => theme?.bg?.('customMessageBg', text) ?? text;
      const row = (text: string, color: Tone, strong = false) => {
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
