import type { VoiceState } from './types.ts';

export type VoiceLayout = Pick<typeof import('@earendil-works/pi-tui'),
  'truncateToWidth' | 'visibleWidth' | 'wrapTextWithAnsi'>;

export type VoiceDisplayState = Partial<VoiceState> & {
  route?: string;
  preferredRoute?: string;
  fallbackRoute?: string;
  routeActive?: boolean;
  switchingRoute?: string;
};
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
    activity: state.processing ? 'Agent working - audio paused' : 'Voice paused - microphone closed',
    detail: 'Pause does not stop agent work.', controls: 'Resume: /paj-voice resume   Off: /paj-voice off' };
  if (state.starting) return { badge: 'warming up', tone: 'warning',
    activity: 'STARTING - preparing local speech', detail: 'Remain quiet until the ready beep.',
    controls: 'Cancel: /paj-voice off' };
  if (!state.enabled) return null;
  if (state.inputAvailable === false || state.outputAvailable === false) {
    const input = state.inputAvailable !== false, output = state.outputAvailable !== false;
    return { badge: input ? 'PLAYBACK SUSPENDED' : output ? 'MIC SUSPENDED' : 'AUDIO SUSPENDED', tone: 'warning',
      activity: input ? state.listening === false ? 'RECOGNITION PAUSED - playback suspended' : 'LISTENING - playback suspended'
        : output ? 'LISTENING SUSPENDED' : 'LISTENING AND PLAYBACK SUSPENDED',
      detail: 'Waiting for verified endpoints. No unconfigured microphone or speech replay.',
      controls: 'Pause: /paj-voice pause   Off: /paj-voice off' };
  }
  if (state.speakerMode) return { badge: 'SPEAKER MODE', tone: 'warning',
    activity: state.speaking ? 'SPEAKING - recognition paused' : state.listening === false
      ? 'WAITING FOR QUIET - recognition paused' : 'LISTENING - speaker-safe microphone',
    detail: 'Wait for LISTENING before speaking. Use /paj-voice stop to interrupt readouts.',
    controls: 'Pause: /paj-voice pause   Off: /paj-voice off' };
  return { badge: 'OPEN MIC', tone: 'warning',
    activity: state.capturing ? 'RECEIVING SPEECH - agent work may continue'
      : state.speaking ? 'SPEAKING - interrupt with your voice'
        : state.processing ? 'WORKING - microphone still listening' : 'READY - listening for your request',
    detail: 'All recognized speech is actionable with normal tools.',
    controls: 'Pause: /paj-voice pause   Off: /paj-voice off' };
}

const fg = (theme: Theme | undefined, color: Tone, text: string) => theme?.fg?.(color, text) ?? text;
const bold = (theme: Theme | undefined, text: string) => theme?.bold?.(text) ?? text;
const routeLabel = (state: VoiceDisplayState) => state.route
  ? `Audio: ${state.route}${state.routeActive ? '' : ' (selected)'}${state.usingFallback ? ` (fallback) | Preferred: ${state.preferredRoute ?? 'saved route'}` : ''}${state.switchingRoute ? ` → ${state.switchingRoute} (switching)` : ''}`
  : undefined;

export function voiceRequestMarkdown(markdown: string, theme?: Theme): string {
  const envelope = /^\[Voice request [\w-]{1,128}:[\w-]{1,128}\](?:\r\n|\n|\r)/u.exec(markdown);
  if (!envelope) return markdown;
  const label = [...'[Voice request]'].map(character => fg(theme, 'warning', bold(theme, character))).join('');
  return `${label}\n\n${markdown.slice(envelope[0].length)}`;
}

export function voiceStatus(state: VoiceDisplayState, theme?: Theme) {
  const view = appearance(state);
  return view ? fg(theme, view.tone, bold(theme, `VOICE MODE | ${view.badge}${routeLabel(state) ? ` | ${routeLabel(state)}` : ''}`)) : undefined;
}

export function voiceWidget(state: VoiceDisplayState, layout: VoiceLayout) {
  const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = layout;
  const fit = (text: string, width: number) => truncateToWidth(text, width, '…');
  const view = appearance(state);
  if (!view) return undefined;
  return (_tui: unknown, theme?: Theme) => ({
    render(width: number) {
      width = Math.max(1, Math.floor(width));
      if (width < 8) return [view.badge, ...(routeLabel(state) ? [routeLabel(state)!] : [])]
        .flatMap(text => wrapTextWithAnsi(text, width)).map(text => fg(theme, view.tone, text));
      const inside = width - 4;
      const background = (text: string) => theme?.bg?.('customMessageBg', text) ?? text;
      const row = (text: string, color: Tone, strong = false) => {
        const clipped = fit(text, inside);
        const content = clipped + ' '.repeat(Math.max(0, inside - visibleWidth(clipped)));
        return background(fg(theme, 'warning', '│ ') +
          fg(theme, color, strong ? bold(theme, content) : content) + fg(theme, 'warning', ' │'));
      };
      const heading = fit(` VOICE MODE | ${view.badge} `, width - 2);
      return [
        background(fg(theme, 'warning', '╭') + fg(theme, view.tone, bold(theme, heading)) +
          fg(theme, 'warning', '─'.repeat(width - 2 - visibleWidth(heading)) + '╮')),
        row(view.activity, view.tone, true),
        row(view.detail, 'muted'),
        row(view.controls, 'dim'),
        ...(routeLabel(state) ? wrapTextWithAnsi(routeLabel(state)!, inside).map(text => row(text, view.tone)) : []),
        background(fg(theme, 'warning', '╰' + '─'.repeat(width - 2) + '╯')),
      ];
    },
    invalidate() {},
  });
}
