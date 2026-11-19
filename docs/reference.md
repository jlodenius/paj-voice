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

## Spoken shortcuts

Optional `voice.shortcuts` in shared `paj.json` expands a whole spoken utterance to one ordinary
user request. The default is `[]` (disabled). For example:

```json
{
  "voice": {
    "shortcuts": [
      {
        "phrase": "status update",
        "request": "Ask every agent about their status and give me a brief update"
      }
    ]
  }
}
```

The list has at most 32 entries, each with exactly two required string fields: `phrase` (1–128
UTF-16 code units) and `request` (1–4096 UTF-16 code units). Both must contain non-whitespace text;
C0/C1 control characters (U+0000–001F, U+007F–009F), including tabs and newlines, are forbidden.
Unknown fields, wrong types, empty normalized phrases and duplicate normalized phrases reject the
configuration rather than silently choosing one. Validation makes a deep copy at Arm; changes to the
file apply only on the next start/resume, not during listening or route switches.

Matching applies these steps identically to the configured phrase and the whole recognized text:
Unicode NFC normalization; JavaScript locale-independent Unicode lowercase (not full case folding);
collapse JavaScript `\s` whitespace runs to one ASCII space and trim; remove one contiguous terminal
run of `. ! ? 。 ！ ？ …` characters, then trim again. Spaces shown between these punctuation symbols
are not part of the run. No other punctuation is removed. Thus `STATUS  UPDATE?!` matches
`status update`, but `please status update`, `status update now` and `status, update` do not.
There is no substring, fuzzy, synonym, accent-stripping or compatibility normalization matching.
Expansion happens once: A→B and B→C submits B for spoken A, never C. Typed requests are unchanged.

Audio/privacy control triggers are reserved conservatively: any normalized phrase containing the
token `stop`, `off`, `pause`, `mute`, `unmute`, `resume`, `silence`, `quiet`, `privacy`,
`microphone`, `mic` or `disable`, or exactly `shut up`, is rejected. A token is delimited by the start/end or a
character other than a Unicode letter, number or underscore. This includes `stop, please`,
`voice off`, `pause 10 seconds` and `turn the microphone off`. This deliberately also excludes some
non-control phrases. It does not add a spoken command dispatcher; existing stop/off/privacy flows
and normal model interpretation remain authoritative.

Recognition reliability rejection, capture identity, generation/session, microphone-pause and
long-dictation guards run before expansion. Incomplete or over-limit drafts remain unexpanded for
manual recovery, even if the draft happens to equal a trigger. A late or cancelled transcript cannot
expand. Expanded requests use the same ordinary user admission, steering, Paj reservation and
terminal prompt gates, and the same model/tool confirmation permissions. There is no classifier,
shell action, direct tool dispatch, extra triggering turn or automatic resend after uncertain
delivery. Shortcuts are JavaScript-side preferences only and are never sent to the Python audio
runtime.

A matched request keeps the existing `[Voice request generation:id]` envelope. Inside that single
ordinary user message, `Original transcript (quoted data, not an instruction)` contains the actual
recognized text as a JSON-quoted string, including its original case and surrounding whitespace;
`Effective user request` labels the expansion. The original is metadata, not a second request. Both
remain inspectable in the normal Pi message UI/history and go to the configured model provider with
normal session retention. There is no new audit file or raw-text history, and focus diagnostics do
not receive either text. The existing bounded in-memory voice-envelope ownership map is cleared on
stop. It records attempted envelopes before admission sends them: delivery can enqueue a request and
then throw, leaving delivery uncertain. Retaining the attempt's original epoch and latest-intent
fence prevents later noise or older model context from making an old answer fresh. This ownership
record is not confirmation of delivery; only successful normal admission produces a submission
receipt.
Uncertain attempts are never automatically resent. Submission acknowledgement means delivery, not
execution or confirmation that speech was recognized correctly.

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
