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
Model hashes and voice-weight licensing notices are in
[models/manifest.json](../models/manifest.json).
