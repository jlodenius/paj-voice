# paj-voice

Local speech interaction with an existing Pi session, using an **explicitly armed continuous open
microphone**. No wake word, addressee classifier, Paj installation or Captain installation is
required. Linux, PipeWire, headphones and Pi 1.5.2 or newer are required.

This first version uses the capture, startup-readiness, Whisper and interruption path tested on the
laptop microphone and Sony headphones. The complete read-only trial produced real spoken answers
and responsive interruption. The tool-capable addon still needs its own live acceptance test; unit
and fake-provider tests do not establish general accuracy, game coexistence or acoustic latency.

## Permission and privacy

**While armed, every recognized utterance is an ordinary user request with the agent's normal tool
permissions, including commands and file changes.** Incidental speech, background dialogue and
recognition errors can therefore become actionable input. Only arm it where this is acceptable.
There is no speaker identification or uncertain-addressee confirmation in this version.

STT, VAD and TTS run locally. No audio is uploaded or saved to recording files, enrolled or used for
training. Recognized requests go to the selected Pi model provider, which may be remote, and
normally persist in Pi session history. Local speech models do not make the conversational Pi model
local.

Arming requires a manual TUI confirmation. Existing terminal/tool confirmation dialogs remain
manual: spoken "yes" cannot approve a blocking UI prompt. Voice does not expand recognized slash
commands, activate itself, grant extra tools, or change the agent's existing permissions.

## Build without activating audio

```sh
./scripts/build-addon
```

This builds `result-addon`, runs the package tests and loads the bundled speech models with a fixed
RAM-only synthesis check. It opens no microphone or playback stream and installs no package profile,
service or login-time listener. Runtime dependencies and pinned models live in the shared Nix store;
project build roots and caches stay in the project.

The package includes the tested CPU Whisper base.en, Piper voice and VAD environment. No classifier
weights or classifier dependencies are included. Runtime model downloads and telemetry are disabled;
Whisper uses two CPU inference threads. ASR and synthesis are serialized to avoid competing local
inference jobs. English is the only supported speech language in this version.

Whisper licensing/provenance and the Piper model card are included with the pinned assets. Piper
code is GPL-licensed; a model card's dataset license is not an independent grant for the voice
weights. The existing local-evaluation licensing caveat remains; this is not a new
weight-redistribution claim.

## Preferences and extension loading

Merge the `voice` object from `examples/paj.json` into the shared `~/.pi/agent/paj.json`, preserving
`subagents`, `captain` and other addon sections. Voice validates only its own section and preserves
sibling settings when saving device choices. `PAJ_VOICE_CONFIG` can explicitly select another entire shared file;
`PI_CODING_AGENT_DIR` selects the usual agent directory. There is no legacy `voice.json` fallback.

The installed package supplies its own audio executable; it is not a user preference. Cache storage
is selected automatically as `$XDG_CACHE_HOME/paj-voice`, or `~/.cache/paj-voice` when unset. Remove
`python` and `cacheDir` from older preferences. The internal companion protocol still receives the
resolved cache directory, but it is never read from user settings. The Nix wrapper supplies bundled
models, so `stt.model` and `tts.model/config` may be omitted. Explicit local model overrides are
supported, but remote identifiers and runtime downloads are not.

With voice off, run `/paj-voice setup` to select a microphone and headphones by readable names.
Technical PipeWire IDs remain visible for inspection and are stored for exact, fail-closed binding.
`/paj-voice devices` lists compatible devices without opening an audio stream or requiring valid
preferences. Selection never arms audio. Cancelling or changing sessions discards the selection.
Saving updates only the device IDs in the latest shared file, preserving sibling settings. An
out-of-store symlink is resolved to its owner-controlled source without replacing the link; immutable
Nix-store settings must be changed declaratively. Malformed or unsafe files are not overwritten;
detected concurrent changes cause saving to fail rather than overwrite them. Initial setup requires a valid Voice section from the example.
The example names are the tested laptop input and Sony output; adjust them for another machine.
`audio.echoCancellation` must explicitly be `none` or `external`. `none` is the tested direct-mic,
headphone route, not a claim of echo cancellation. An external route is never installed or loaded
by the addon. Defaults, reconnect fallback, gains and Bluetooth profiles are not changed.
Bluetooth microphone capture is rejected so playback need not switch into headset/call mode.

The built package exports `extensions/index.ts`. Configure it through the normal Pi package or
extension loader. Load the built package, not the unpackaged source extension: its executable is
resolved relative to the immutable package installation. Loading or reloading it does not arm
capture. For this personal checkout, the host's dormant local loader points at the single combined
preferences file. It replaces the temporary session-pinned `voice-trial` loader, without a system
activation. Load exactly one copy of the extension; remove the development loader when switching
to a Home Manager-installed copy. The development loader resolves the build link to its immutable
Nix store path before importing, avoiding stale transitive JavaScript after rebuild/reload; status
prints the loaded extension build identity. Direct imports from mutable source paths may remain
cached across a Pi reload.

Wake phrases, spelling hints and prefix timing options are no longer production preferences:
remove `addressPhrases`, `stt.hotwords` and `turn.prefixIntervalMs` from older Voice sections.
Default utterance settings match the tested path: 800 ms endpoint silence, twelve-second maximum,
one-second pre-roll and a 0.001 RMS floor alongside VAD. Long pauses can split an utterance.

## Use

In the intended main Pi TUI session:

```text
/paj-voice setup
/paj-voice devices
/paj-voice on
/paj-voice status
/paj-voice mute
/paj-voice unmute
/paj-voice stop
/paj-voice off
```

`on` asks for explicit consent, starts local inference and opens the selected microphone. Remain
quiet through warm-up and wait for the ready beep. Startup clipping/DC and VAD-active warm-up audio
are discarded until three consecutive quiet quarter-second buckets pass. Failure to settle within
five seconds stops audio and reports numeric diagnostics; post-ready speech is not cropped. If
the observed flat saturation/DC fault recurs after readiness, the stream stops rather than feeding
that corrupted frame to recognition; ordinary clipped speech peaks are not silently filtered.

After readiness, speak naturally without Paj/Pie/Pi. Capture stays open across utterances, model
processing and playback until you explicitly stop it. There is no trial timer or twenty-turn cap.
An above-editor **OPEN MIC** indicator remains visible even with a custom footer; it also reports
warming, muted, speaking and agent-processing states.

Speech activity stops owned playback before waiting for recognition. Both an earlier utterance and
an addition spoken during its decoding are preserved. Busy-session additions use Pi steering rather
than automatic agent cancellation. A newer input invalidates old audio and stale response tokens;
this can suppress a delayed answer if you keep talking before it arrives.

The next model context includes up to 16 recent user-facing speech records from this armed session:
not_queued, queued, started, completed or interrupted, with the spoken text and interruption reason. Completion
requires an explicit software playback-drain acknowledgement; it is not proof of acoustic audibility.
Discarded or unconfirmed end events never count as completed. History is RAM-only in the addon and
cleared on off or a new generation; snapshots passed to the model may persist in normal Pi history.
The transcript itself is not rewritten or automatically merged. The model is instructed to recognize
possible sentence continuations and freshly answer the combined intent using relevant unheard
information. It must honor explicit stops and topic changes, not blindly replay speech or rerun tools.
This adds no separate model call and does not weaken immediate audio interruption. Context delivery
is tested offline; whether a model correctly interprets a particular continuation needs live testing.

A theme-colored panel above the editor makes voice mode distinct without replacing your footer or
editor. It uses the theme's yellow (`warning`) for its frame, OPEN MIC badge and warm-up state,
with a muted MIC CLOSED label when paused. It shows current listening,
receiving, working or speaking activity, and the manual mute/off commands. Labels remain meaningful
without color, the panel fits narrow terminals, and it disappears when voice is off. There are no
flashing indicators or UI animations.

Short final public answers are spoken automatically when appropriate. For detailed coding results,
the model uses `voice_speak` for a separate intentional outcome, question or blocker, normally under
30 words and always at most 50 words / 320 characters. Verbose screen replies, hidden reasoning and
raw tool output are not automatically narrated. While armed, the model is instructed to assume the
user cannot see the screen and provide important answers, outcomes, blockers and questions aloud,
including with a reporting integration. Screen access is reserved for genuinely manual steps such
as blocking confirmations or credential entry, with a spoken explanation; voice cannot approve them.
If no spoken outcome is produced, a brief spoken notice invites a summary request instead of
referring the user to the screen. This notice does not itself summarize or verify the result.
New submissions get the brief spoken receipt “Got it.” Busy-session steering additions say
“Steering received.” Both mean submitted, not executed or successfully completed; rejected or
uncertain delivery keeps its explicit warning instead.

Task outcomes should explicitly say when work finishes, fails, stops or needs input. At Pi's actual
settled event, a request with progress speech but no automatic spoken final answer gets a brief
“I’m finished for now” notice. This means this response has ended, not that external work succeeded.
A spoken final answer is not followed by a duplicate completion notice.

Long-running requests get brief spoken progress about once a minute without ongoing sounds. The
model is instructed to give meaningful stage updates, normally 3–8 words. If it cannot speak while
busy, a local timer uses current tool-lifecycle metadata for short reminders such as “Running a
command” or “Reading files,” otherwise “Still working.” It never reads tool arguments or results.
These fallback reminders do not count as a final outcome. They wait during capture, playback or
blocking confirmations, and stop when the agent settles or audio is muted/off. Any intentional
speech postpones the next automatic reminder by another minute after playback ends. No separate
model call is made for the timer; a request awaiting agent startup is not described as active work.

After a minute idle, the addon says “I’m available and have nothing in progress.” It repeats at
one-minute intervals, at most three times per idle stretch. New requests, work or intentional speech
reset the count. The reminder's own playback does not reset it; intervals start after playback ends.
Reminders wait for capture/recognition, queued requests, agent work, pending playback and blocking
confirmations to clear. Uncertain delivery suppresses availability claims. Off, mute, shutdown and
session changes cancel timers. Reminders do not change microphone state or generate model requests.
These notices describe this Pi session, not unrelated agents or external background jobs.

`stop` discards speech only. `mute` closes the audio process completely; `unmute` explicitly
confirms and starts a fresh generation, with new warm-up and no stale playback. `off` closes audio
and releases owned reservations. None of these aborts agent work or changes normal tool permissions.
Voice-controlled mute/off is not implemented; use the manual commands as the privacy controls.

Session change, tree navigation, model selection change, shutdown, device loss, broken pipes or
bounded-queue failure stop capture rather than retargeting or choosing another device. No automatic
rearming or uncertain-delivery replay occurs. Overlong utterances are discarded through their
endpoint, not submitted as truncated commands. Local inference has a ten-second latency watchdog.

## Audio failures

An audio failure closes capture/playback without cancelling agent work. The notification includes
the native failure stage and a bounded, control-character-stripped error message. `/paj-voice status`
retains that `lastError` after audio stops; a new arming attempt clears it. Startup stages distinguish
preferences, cache, devices, models, capture start and warm-up; playback failures preserve the
underlying playback error. Do not loosen the readiness gate or change devices/gains based only on
a generic failure notification. The recorder's creating thread stays alive until owned audio
children have closed: Linux parent-death protection is thread-scoped, so finishing warm-up must not
end that thread while capture is still active.

## Optional addons

Captain integration belongs to **paj-captain**. It can register specialized reporting instructions;
the first registered reporter owns that policy and prevents duplicate generic final-answer
narration. Standalone Pi operation needs neither Paj nor Captain. When Paj is present, admission
honors its editor/external reservations and stops on identity loss rather than silently bypassing
it.

```js
let voice;
pi.events.emit('paj-voice:api:v1', { reply(api) { voice = api; } });
const unregister = voice?.registerReporter({
  id: 'my-addon', instructions: 'Report brief outcomes, questions and blockers.',
});
```

`getState()` reports activation, session/generation, interruption `epoch`, processing and reporting
owner. Subscribe to `paj-voice:state:v1` for updates. `speak({ text, generation, epoch, priority,
key, id })` queues short intentional speech; use the token associated with the work, never retag
stale output. IDs deduplicate within a generation; keys supersede queued updates and urgent speech
stops older playback. Queued/drained software audio is not proof of acoustic delivery.

This trusted in-process interface cannot activate, unmute, retarget or abort Pi. Unregister
reporters when appropriate and clean up subscribers on shutdown. It is not an operating-system
sandbox.

## Nix / Home Manager

The flake exports `homeManagerModules.default`. Its package includes the pinned speech runtime and
models, excluding training, HTTP-server and classifier extras. Importing/enabling the module
installs the extension and companion, not a microphone service. Activation still requires
`/paj-voice on`.

`programs.paj-voice.configFile` supplies the **entire shared** `paj.json`; alternatively `settings`
supplies inner Voice preferences and generates `{ voice = settings; }`. They are exclusive and own
the whole file. When the host already manages combined addon settings, leave both unset (their
defaults) to avoid overwriting sibling sections. Use locked inputs for deployed configurations.

## Checks and historical labs

Run `npm test` for JavaScript, protocol and fake-audio tests. Optional real-Pi tests use an isolated
home and local fake provider; they exercise short answers, intentional speech, normal harmless tool
execution, session binding and teardown without touching real microphones or provider accounts.

The [STT evaluation](docs/stt-evaluation.md), [fixed-response continuous
test](docs/continuous-test.md) and [read-only agent trial](docs/agent-trial.md) remain
diagnostic/research tools. The earlier [classifier lab](docs/lab.md) and wake-prefix runtime are
historical experiments, not production activation paths. Their synthetic/unit results do not qualify
live speech reliability.