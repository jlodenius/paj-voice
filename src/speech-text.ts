interface MessagePart { type?: unknown; text?: unknown }
interface AnswerMessage { role?: unknown; stopReason?: unknown; content?: unknown }

export function spokenAnswer(message?: AnswerMessage | null): string | null {
  if (message?.role !== 'assistant' || message.stopReason !== 'stop' || !Array.isArray(message.content) ||
      message.content.some((part: MessagePart) => part.type === 'toolCall')) return null;
  const text = message.content.filter((part: MessagePart): part is { type: 'text'; text: string } =>
      part.type === 'text' && typeof part.text === 'string')
    .map((part: { text: string }) => part.text).join(' ').trim();
  if (!text || text.length > 320 || text.split(/\s+/u).length > 50 ||
      /[\u0000-\u001f\u007f]|https?:\/\/|[*_`#<>\[\]]/u.test(text)) return null;
  return text;
}
