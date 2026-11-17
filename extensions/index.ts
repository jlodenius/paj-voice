import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerVoice } from '../src/extension.js';

export default function (pi: ExtensionAPI) {
  registerVoice(pi, Type);
}
