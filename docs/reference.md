# Voice reference

Start with the [README](../README.md) for installation, commands, and settings.

## Audio recovery

Saved audio selections are called routes in commands. Use `/paj-voice setup <name>` to save a
microphone/output pair and `/paj-voice route <name>` to select it. Switching briefly pauses listening;
wait for the ready notice before speaking again. It does not interrupt agent work.

If a device disappears, Voice suspends the unavailable endpoint and waits for that same verified
device to return. It never chooses an arbitrary microphone. Interrupted speech is not replayed.

For automatic laptop fallback, while Voice is off:

```text
/paj-voice fallback setup laptop
```

Choose the built-in microphone and speakers and confirm their use. Alternatively,
`/paj-voice fallback <name>` uses an existing saved selection. `fallback off` disables automatic
fallback without changing the preferred selection.

If either preferred endpoint fails, both fallback endpoints must be available before switching.
Fallback stays active until you explicitly switch or rearm; reconnecting the headset does not switch
back automatically. The panel marks active fallback audio and shows the preferred selection.

Speaker-safe selections pause recognition during readouts and until quiet. This reduces
self-transcription but is not acoustic echo cancellation. Restored background music can still prevent
listening or be recognized as a request. Headphones are safer.

Bluetooth microphones require WirePlumber's automatic headset-profile switching.

## Recovering long dictation

At `maxMessageSeconds`, stop speaking. Voice keeps the captured transcript in memory rather than
submitting an unfinished request. `/paj-voice recover` loads it into an empty Pi editor for review;
complete it before sending. Up to four drafts are retained, after which Voice stops.

Drafts survive off/pause but are cleared when switching sessions or quitting Pi. They are not audio
recordings. Audio is processed locally; recognized text goes to Pi's provider and session history.

## Recognition safeguards

Voice discards punctuation-only output, output whose decoder evidence indicates unreliable
non-speech, and repeated decoder loops that are implausibly long for the VAD-positive capture time.
Rejected captures show a warning and submit nothing; they are never shortened into an actionable
acknowledgement. Short answers and plausible intentional repetition are still allowed.

These are conservative admission checks, not a cough classifier or a guarantee against hallucinations.
A confidently decoded noise sound can still look like speech, and legitimate speech can occasionally
be rejected. Potential speech can still interrupt a readout before recognition rejects it. Repeat the
request if needed. No raw audio or rejected transcript is saved by these checks.

## Incoming agent updates

With compatible Paj, incoming updates request a concise summary from your current Pi model. The
arrival notice is separate from the meaningful summary. Important results, blockers, and questions
remain spoken even when routine progress updates are disabled.

If an inbox-only response omits a usable summary, Voice requests one fresh summary automatically,
once per pending batch. It never replays old audio or substitutes a stale user-request token.
Stopping speech or starting a new request cancels an obsolete retry; explicit silence is respected.
If the retry still cannot produce a summary, Voice reports that failure once rather than repeatedly
asking you to request a summary. An inbox summary does not complete unrelated user work.

## Storage

Shared preferences are read from `~/.pi/agent/paj.json`, or `paj.json` under `PI_CODING_AGENT_DIR`.
`PAJ_VOICE_CONFIG` overrides that file. Preserve sibling addon settings when editing it; if the file
is a declarative symlink, edit its source.

Private device selections live in `~/.config/paj-voice/devices.json`; cache uses
`~/.cache/paj-voice`. `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` override these locations. Device IDs do not
belong in shared preferences. Models and executable paths are package-managed, not user options.

## Upgrading older settings

Upgrade the Voice package and reload affected Pi sessions before saving new options. A source
checkout or Nix pin update alone does not change an already installed or loaded extension.

The current background-audio settings are `enabled`, `gain`, and `ignoreApps`. Older `mode`, `apps`,
and `excludeApps` fields are rejected with migration guidance:

- Replace `mode: "off"` with `enabled: false`.
- Replace `mode: "duck-all"` with `enabled: true`.
- Rename `excludeApps` to `ignoreApps` and remove `apps`.
- Old selected-app `mode: "duck"` does not migrate automatically: enabling now includes all supported
  playback, including calls and alerts. Leave it disabled until that broader behavior is intended.

Older `version`, `stt`, `tts`, `audio`, `turn`, language, and runtime-path preferences are also
unsupported. Use the [current example](../examples/paj.json), preserving other addon sections.

## Background-audio diagnostics

`/paj-voice ducking diagnostics` shows recent safe diagnostics without opening audio, connecting to a
broker, or changing gain. They are also included in `/paj-voice status`.

The list identifies the client, shared broker, or native helper; the operation; and a fixed reason
code, with elapsed/timeout milliseconds and sanitized process exit, signal, or OS error codes when
available. Acknowledgement means the operation was processed, not proof of audible restoration.
No application names, device IDs, paths, media titles, URLs, transcripts, raw process output, or
credentials are stored. Normal warnings remain unchanged. Older loaded Voice clients can display
safe diagnostic records as warnings; reload affected sessions together when upgrading.

History is memory-only, limited to 32 entries for 15 minutes in this Pi session. It survives Voice
off/cleanup for inspection, but clears on session change or shutdown. Startup and cleanup diagnostics
are best effort; a crash may prevent delivery. Diagnostics cannot recover an earlier unlogged cause,
do not retry gain writes, and do not prove that audio remains quiet. Use normal app volume controls
if needed. A controlled live duck/restore test is a separate step, not part of this command.

## Development

Maintained Pi code is TypeScript; Python handles local audio. JavaScript in `dist` is generated.

```sh
nix develop
npm ci
npm run typecheck
npm test
./scripts/build-addon
```

Tests use fake audio. Package preflight loads models and synthesizes in memory without microphone
capture or playback. Software checks do not establish real-device audio quality or volume restoration.
Model hashes and voice-weight licensing notices are in [models/manifest.json](../models/manifest.json).
