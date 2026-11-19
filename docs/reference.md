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

## Availability diagnostics

`/paj-voice availability diagnostics` reads at most 32 validated native availability observations
from the last 15 minutes. Status includes a summary with reason counts, recording timestamp and age.
These diagnostics stay only in memory, survive Voice off, and clear on session boundaries/shutdown.
Reading them performs no device query, process start, IPC, configuration access or recovery action.
They are separate from background audio focus diagnostics and do not control audio behavior.

The closed reason codes distinguish graph/endpoint resolution failures, capture health failures and
successful input/output recovery. `inputPresent` and `outputPresent` mean the same selected endpoint
resolved, not proof of physical presence or working capture. Null means unknown; an unresolved source
is not proof that the microphone was unplugged. PCM age is bounded or unknown; recovery count is
native-runtime cumulative, not a count of physical reconnects. Historical entries are explicitly
marked as not belonging to the current native connection. No valid current observations, including
older runtimes without this protocol, means `not_observed`, never “healthy.” No endpoint identities,
raw errors, transcripts or media are retained.

## Speaker protection

Ordinary `/paj-voice setup <name>` asks you to explicitly choose speakers/uncertain playback
(protection ON) or confirm headphones (protection OFF). Protection ON is the conservative first
choice. Device metadata is advisory, never proof: Bluetooth is always unknown, and a headphone hint
never saves a choice automatically. No choice or canceled confirmation means no changes.

Protection ON is **half-duplex**, not acoustic echo cancellation: recognition pauses during all
Voice output (including receipts, answers, narration, status and fallback speech), through its tail
and until quiet. Voice barge-in is unavailable during this interval. Use typed `/paj-voice stop`,
also displayed in the panel; agent work continues. Protection OFF retains full-duplex headphone
operation.
Background speech or music outside Voice playback can still become requests; headphones are safer.

To change only an existing route's protection, without selecting new devices:

```text
/paj-voice protection desk speakers
/paj-voice protection headset headphones
```

Omit the last argument for a chooser. Both choices require confirmation in a main Pi TUI with Voice
fully off. Nothing is hot-applied or automatically rearmed; the saved choice applies at the next
manual arm. Existing routes without a `speakerMode` flag remain unchanged until you explicitly
choose. The command changes only that private flag, preserving exact endpoints, route names, preferred
selection and fallback. Protection cannot be disabled on the configured automatic fallback route.

Setup saves new bindings without changing an existing preferred route unless you explicitly select
“Make preferred.” The first route becomes the initial preferred route with confirmation. Replacing
an existing binding is disclosed in the final confirmation. Setup and protection edits refuse stale
consent or concurrent route changes rather than overwrite them. Choices use the existing private,
user-owned atomic store; shared preferences are unchanged.

## Timed microphone pause

While Voice is already armed, use `/paj-voice pause 10 seconds` or say “mute for 10 seconds”.
The spoken request uses `voice_pause_input` with integer `seconds` and the current generation/epoch.
This closes only microphone capture and discards partial or in-flight recognition. Speech output,
agent work, and normal tool permissions continue. It never arms Voice from off, startup, or a full
pause, and cannot approve terminal confirmations.

A request initially shows **MIC PAUSING**: recorder closure is unconfirmed, so do not assume privacy.
The tool returns `requested`, not proof of closure. Only a matching native shutdown acknowledgement
confirms the paused state and starts displaying the native remaining time. The duration runs from
the request, not from acknowledgement. Missing acknowledgement after three seconds or a transport
failure stops Voice through its normal companion-close path and reports closure as unconfirmed.
A late acknowledgement cannot restore listening after that failure or an explicit stop.

Typed `pause` and `mute` accept an optional `for` and an exact integer duration: `seconds`, `sec`,
`s`, `minutes`, `min`, or `m` (singular words also work). The total must be 1–300 seconds. Fractions,
signs, mixed units, trailing words, and durations without units are rejected. For example,
`/paj-voice mute for 1 minute` pauses capture for 60 seconds.

A new request replaces the deadline from now; retrying the same tool-call ID does not extend it.
Up to 512 distinct requests are accepted per armed session; rearm with normal confirmation if this
limit is reached, rather than forgetting old IDs and extending a retried request.
The native runtime owns the monotonic deadline. The panel countdown is status only: zero means
fresh warmup, not listening. Wait for readiness; speaker-safe routes still wait for playback and
quiet before recognizing speech. Expiry does not replay discarded recognition or old speech.

Automatic resume requires the same armed session and the exact saved input/output endpoint
identities. Off, full pause, shutdown, session replacement, route switching, or an explicit stop
cancels that intent. If either endpoint disappears or the pair would change, the microphone stays
held, even if the original pair later returns. No pair-changing fallback is selected while paused;
existing fallback settings are unchanged. Output recovery remains independent. Use
`/paj-voice resume` for normal fresh confirmation rather than silently opening another microphone.

Closing capture can cause Bluetooth headset profile changes, such as HFP to A2DP, after a delay.
Changed profile nodes or serials conservatively hold the microphone rather than broadening resume
permission to another endpoint. This feature has fake-test coverage, not hardware qualification;
automatic resume is not guaranteed across headset profile churn.

Recorder teardown must confirm child-process exit before acknowledging a pause. On a close error or
unconfirmed exit, Voice cancels timed resume, reports a sanitized privacy error, and retains the
recorder for cleanup retries. Failure may stop speech output too. If cleanup still cannot confirm
exit, the error is not a claim that the microphone is physically closed.

Bare `/paj-voice pause` or `/paj-voice mute` still closes **all** audio. `/paj-voice resume` always
uses the normal confirmation flow, including when ending a timed pause early.

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

`/paj-voice ducking diagnostics` shows current focus status alongside recent safe diagnostics. Both
are also included in `/paj-voice status`. Reading either command never creates a focus client, reads
settings files, opens audio, connects/spawns, acquires/sends/pings/retries, schedules focus control
timers, closes/restores, or changes gain/configuration. Status uses cached route information; use
`/paj-voice route` to read saved routes afresh.

Current status contains only these memory-only, independent copies:

- `armedPolicy`: enabled and linear gain from the validated arm snapshot, not saved preferences.
  It is null without an armed snapshot (including after off); paused Voice retains that snapshot.
  An armed snapshot with no background-audio section means disabled and gain `0.2`.
- `client.state`: `not_created` when no current client exists; `unavailable` for an existing external
  client without a usable getter; otherwise `idle`, `connecting`, `connected`, `failed`, `closing`,
  or `closed`. Connected means a local socket was attached, not proof of audible lowering, a
  successful set acknowledgement, or restoration. Idle means no current local playback intent.
  Closing/closed describe local client cleanup, never confirmed restoration.
- `client.leasePresent`: whether the client currently holds a local intent token. This is NOT a
  confirmed broker lease. False, idle, or closed likewise cannot prove restoration. It is null when
  the existing client's status is unavailable; absent clients report false.
- `client.terminal`: one actual terminal failure's safe reason/origin and age, retained for that
  client object's lifetime even after history expires. Successful close is not a failure. An initial
  terminal failure is not replaced by later cleanup; failed cleanup alone can supply the record.
  Only directly correlated failures supply codes; unrelated helper events, successes, or earlier
  recoverable connection errors do not become terminal causes. Uncorrelated failures use `unknown`.
  Ages saturate at 2,147,483,647 milliseconds. The client's optional `now` test clock affects only
  observational age, never control timers, deadlines, or retry delays.
- `trace.observed`: playback-state frames reaching the current companion callback, including invalid
  frames and rejected generations. `acceptedPlaying` counts true transitions passing existing gates
  before construction/dispatch; `playingCalls` counts attempted `playing()` calls, including calls
  ignored by an already-failed client. None proves gain changed. All counters saturate at 1,000,000.
- `trace.lastSkip`: the last historical rejected decision, not a current terminal cause. Fixed values
  are `generation`, `invalid_frame`, `policy_off`, `inactive_output_unavailable`, `version_duplicate`,
  and `construction_dispatch_error`, or null before a rejection. Normal playback end is not failure
  and does not clear or replace the last skip. Gate order and control decisions are unchanged.

Trace counters and last skip survive off/rearm, clearing with session history on session change or
shutdown. Existing generation, companion/scope, version, and session fences reject stale callbacks;
each client's warnings retire only when its own close settles (or session invalidation fences them).
Pending cleanup uncertainty still warns even if replacement clients exist or multiple closes overlap;
new playback cannot confirm old restoration. Off drops the current client, so its status becomes
`not_created`, while bounded history remains available. No frame bodies or IDs are
retained by the trace. No status data is written to persistent files.

The list identifies the client, shared broker, or native helper; the operation; and a fixed reason
code, with elapsed/timeout milliseconds and sanitized process exit, signal, or OS error codes when
available. Acknowledgement means the operation was processed, not proof of audible restoration.
No application names, device IDs, paths, media titles, URLs, transcripts, raw process output, or
credentials are stored. Existing warning messages remain unchanged. Older loaded Voice clients can display
safe diagnostic records as warnings; reload affected sessions together when upgrading.

History is memory-only, limited to 32 entries for 15 minutes in this Pi session. It survives Voice
off/cleanup for inspection, but clears on session change or shutdown. Startup and cleanup diagnostics
are best effort; a crash may prevent delivery. Diagnostics cannot recover an earlier unlogged cause,
do not retry gain writes, and do not prove that audio remains quiet. Use normal app volume controls
if needed. A controlled live duck/restore test is a separate step, not part of this command.

This visibility is prospective, not a sound-loss fix or a diagnosis. Loading a new build resets local
objects; it cannot inspect an older loaded client's private closure or recover expired history. No
broker/native wire operation or recovery behavior is added.

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
