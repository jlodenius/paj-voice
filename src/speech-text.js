export function spokenAnswer(message) {
  if (message?.role !== 'assistant' || message.stopReason !== 'stop' || !Array.isArray(message.content) ||
      message.content.some(part => part.type === 'toolCall')) return null;
  const text = message.content.filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join(' ').trim();
  if (!text || text.length > 320 || text.split(/\s+/u).length > 50 ||
      /[\u0000-\u001f\u007f]|https?:\/\/|[*_`#<>\[\]]/u.test(text)) return null;
  return text;
}
