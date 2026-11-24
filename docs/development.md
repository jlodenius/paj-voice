# Development

[Back to setup](../README.md).

Maintained Pi code is TypeScript; Python handles local audio. JavaScript in `dist` is generated.

```sh
nix develop
npm ci
npm run typecheck
npm test
./scripts/build-addon
```

Tests use fake audio. Package preflight loads models and synthesizes in memory without microphone
capture or playback. Software checks do not establish real-device audio quality or volume
restoration.
Model hashes are in [models/manifest.json](../models/manifest.json). Nix fetches the pinned
Amy medium model, config, and model card at build time; no weight files are checked into this repo
or downloaded at runtime. The bundle includes Amy's model card in `voice-notices/amy.txt`.

[Piper Voices][piper-voices] declares MIT at repository level, but the [Piper maintainer][amy-terms]
identifies Amy/Mycroft model weights as CC BY-SA and says the recording dataset terms are unknown.
The [Amy model card][amy-card] points to [Mimic 3 Voices][mimic-terms] (CC BY-SA 4.0) and identifies
Hi-Fi TTS reader 92 as its base; the [Hi-Fi TTS dataset][hifi-terms] is CC BY 4.0. Build locally
from the pinned sources. Do not treat the weights as MIT-only; review attribution, share-alike and
training data terms before redistributing the weights or a binary cache containing them.

Custom Nix `voiceModels` entries still override matching built-in IDs. The catalog supports
32 voices total, so with both built-ins it accepts up to 30 additional IDs.

[piper-voices]: https://huggingface.co/rhasspy/piper-voices/blob/e9ab671f2a0e50a701b34361136ba3e6a3a9eb0c/README.md
[amy-terms]: https://github.com/rhasspy/piper/issues/253#issuecomment-1784157564
[amy-card]: https://huggingface.co/rhasspy/piper-voices/blob/e9ab671f2a0e50a701b34361136ba3e6a3a9eb0c/en/en_US/amy/medium/MODEL_CARD
[mimic-terms]: https://github.com/MycroftAI/mimic3-voices/blob/b239a9084e21fbaa7ac78ea6e31f5de1c31c8f42/LICENSE
[hifi-terms]: https://github.com/MycroftAI/mimic3-voices/blob/b239a9084e21fbaa7ac78ea6e31f5de1c31c8f42/voices/en_US/hifi-tts_low/LICENSE
