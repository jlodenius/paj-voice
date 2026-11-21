# Audio recovery and diagnostics

[Back to setup](../README.md).

## Audio recovery

Saved audio selections are called routes in commands. Use `/paj-voice setup <name>` to save a
microphone/output pair and `/paj-voice route <name>` to select it. Switching briefly pauses
listening;
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
self-transcription but is not acoustic echo cancellation. Restored background music can still
prevent
listening or be recognized as a request. Headphones are safer.

Bluetooth microphones require WirePlumber's automatic headset-profile switching.

## Availability diagnostics

`/paj-voice availability diagnostics` reads at most 32 validated native availability observations
from the last 15 minutes. Status includes a summary with reason counts, recording timestamp and age.
These diagnostics stay only in memory, survive Voice off, and clear on session boundaries/shutdown.
Reading them performs no device query, process start, IPC, configuration access or recovery action.
They are separate from background audio focus diagnostics and do not control audio behavior.
Observations are best effort and may be dropped under transport pressure; absence is not health
proof.

The closed reason codes distinguish graph/endpoint resolution failures, capture health failures and
successful input/output recovery. `inputPresent` and `outputPresent` mean the same selected endpoint
resolved, not proof of physical presence or working capture. Null means unknown; an unresolved
source
is not proof that the microphone was unplugged. PCM age is bounded or unknown; recovery count is
native-runtime cumulative, not a count of physical reconnects. Historical entries are explicitly
marked as not belonging to the current native connection. No valid current observations means
`not_observed`, never “healthy.” No endpoint identities,
raw errors, transcripts or media are retained.

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
- `trace.lastSkip`: the last historical rejected decision, not a current terminal cause. Fixed
  values are `generation`, `invalid_frame`, `policy_off`, `inactive_output_unavailable`,
  `version_duplicate`,
  and `construction_dispatch_error`, or null before a rejection. Normal playback end is not failure
  and does not clear or replace the last skip. Gate order and control decisions are unchanged.

Trace counters and last skip survive off/rearm, clearing with session history on session change or
shutdown. Existing generation, companion/scope, version, and session fences reject stale callbacks;
each client's warnings retire only when its own close settles (or session invalidation fences them).
Pending cleanup uncertainty still warns even if replacement clients exist or multiple closes
overlap;
new playback cannot confirm old restoration. Off drops the current client, so its status becomes
`not_created`, while bounded history remains available. No frame bodies or IDs are
retained by the trace. No status data is written to persistent files.

The list identifies the client, shared broker, or native helper; the operation; and a fixed reason
code, with elapsed/timeout milliseconds and sanitized process exit, signal, or OS error codes when
available. Acknowledgement means the operation was processed, not proof of audible restoration.
No application names, device IDs, paths, media titles, URLs, transcripts, raw process output, or
credentials are stored.

History is memory-only, limited to 32 entries for 15 minutes in this Pi session. It survives Voice
off/cleanup for inspection, but clears on session change or shutdown. Startup and cleanup
diagnostics
are best effort; a crash may prevent delivery. Diagnostics cannot recover an earlier unlogged cause,
do not retry gain writes, and do not prove that audio remains quiet. Use normal app volume controls
if needed. A controlled live duck/restore test is a separate step, not part of this command.

The broker prepares its socket inside a unique private directory, verifies owner/type and mode
`0600`, then publishes the public pathname atomically without replacing an existing entry. This
prevents clients from seeing a partially permissioned startup socket. Shutdown retains the public
socket until owner release and engine cleanup finish, then checks ownership under the startup lock
before unlinking. Replacements are preserved; a busy publisher leaves stale-socket handling to the
next verified startup. No process-global permission mask is changed. Unsafe sockets still fail
closed; terminal clients
are not automatically reset, and old gain writes or uncertain restoration are never replayed.
This closes a reproducible startup race, not proof of the cause of a historical `other` diagnostic.
