# Wake-free addressing for Paj Voice

Research date: 2026-11-17. This is a design recommendation, not a qualified implementation.
No microphones, playback devices, model downloads, paid endpoints, or production settings were used.

## Recommendation

Use an explicitly enabled, local-only speech admission pipeline, with reversible playback pausing
separate from command admission. Keep Whisper and Piper for now. Evaluate a local encoder classifier
on transcripts plus bounded assistant context before permitting wake-free agent dispatch.

There is no verified winning addressee model from this research. Start an
accuracy-oriented comparison
with GLiNER2-base and use GLiClass-edge as a small speed/resource baseline. This is an evaluation
shortlist, not evidence that either understands household addressees reliably. Do not
download either
without approval: the user previously asked to keep Whisper and stop model downloads.

Jev and Luna are real and relevant classification products, but the verified deployment paths are
hosted APIs. They are not the recommended fit for local filtering of private room conversation.

## What local classifier means

A local classifier is another trained AI model loaded by software on the laptop. It consumes text
and context and returns labels or scores, rather than generating conversational
replies. For example:

```text
Local microphone -> local VAD -> local Whisper -> local classifier + admission rules
                                                  |
                                           accepted request only
                                                  |
                                            selected Pi provider
```

Whisper and the classifier must operate locally to keep rejected speech from the Pi provider.
Local STT followed by a hosted classifier would still disclose rejected conversation as text.
These privacy properties depend on implementation: no rejected-text logs, persistent audio, debug
uploads, or classification calls to hosted endpoints. Accepted requests still go to the selected
Pi provider; the complete system is not necessarily offline. A false acceptance could therefore send
private partner conversation to that provider, which makes conservative admission important.

## Jev: verified identity and limitations

TypeSafe describes Jev as a System One model that produces typed decisions and probabilities rather
than free-form strings. Its introduction advertises 70-500 ms end-to-end service
responses. These are
vendor measurements, not our laptop results and not microphone-to-command latency.
Source: [TypeSafe announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

The model documentation says Jev accepts text and PNG/JPEG images, not native audio or video. It is
served through `POST /v1/systemone` and billed by input tokens. Its quick start requires an API key.
Sources: [models](https://docs.typesafe.ai/models),
[quick start](https://docs.typesafe.ai/introduction/quickstart).

The reviewed official documentation supplies a hosted API workflow, not downloadable Jev weights or
an established local inference path. That bounded finding does not rule out a private enterprise
arrangement. A Python SDK running locally is not evidence that its model inference runs locally.

Typed output does not guarantee a correct decision. TypeSafe distinguishes confidence, which
summarizes probability concentration, from the probability of correctness and recommends choosing
thresholds for the application and action stakes.
Source: [confidence documentation](https://docs.typesafe.ai/confidence).

## OpenAI Luna: the remembered capability exists

Microsoft's official documentation identifies the Decisions API and `gpt-6-luna`. It accepts text
and images and returns `predicate`, `choice`, or `score` answers. The documented
Azure setup requires
a hosted resource, model deployment, credentials, and API usage. This is classification, not speech
recognition or a verified pretrained addressee detector.
Source: [Azure OpenAI Decisions](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/decisions).

Asking whether a transcript addresses Paj is a plausible application, not a published guarantee.
Microsoft explicitly recommends thresholds tested on labeled application examples. Neither the
reviewed deployment documentation nor the supplied model-card research establishes a local Luna
weight distribution. No subscription-only integration was verified.

Direct retrieval of OpenAI's Luna model page returned HTTP 403 in the main research pass; the Azure
source above was readable. Additional first-party model and API findings, local alternatives, and
access limitations are in [the companion note](openai-invocation-classifiers.md).

## Local candidates

### GLiNER2-base: accuracy-oriented first candidate

Fastino's author-maintained card describes a 205M-parameter encoder supporting text classification,
CPU inference, downloadable weights, and Apache 2.0 licensing. Its hosted API is not required for
local inference. It can classify among application-defined labels without a conversational response.
Source: [author model card](https://huggingface.co/fastino/gliner2-base-v1).

This makes it a reasonable first candidate, not a demonstrated addressee detector. CPU latency,
working memory, game contention, and household false accepts remain unmeasured here. Generic
classification benchmarks do not establish dinner-versus-agent accuracy.

### GLiClass-edge-v3.0: lightweight comparison

The author card lists 32.7M parameters, a 131 MB model size, and Apache 2.0
licensing. GLiClass performs
zero-shot classification in one forward pass; its library supports CPU execution. The card's speed
figures use an A6000 GPU and must not be presented as laptop CPU performance. Its own generic
benchmarks also show accuracy trade-offs against larger models.
Sources: [model card](https://huggingface.co/knowledgator/gliclass-edge-v3.0),
[library](https://github.com/Knowledgator/GLiClass),
[CPU device handling](https://github.com/Knowledgator/GLiClass/blob/main/gliclass/pipeline.py).

Use it to find out whether a small model is sufficient, not because parameter count
proves suitability.
Classifier scores are not guaranteed calibrated probabilities of real-world intent.

### Purpose-built audio attention is not automatically local

Attention Labs' SAA explicitly targets addressee detection before STT, including side conversations
and playback echo. However, its open-source repository contains client SDKs for a hosted WebSocket
service; the README says model inference and weights remain server-side. On-device deployment is a
separate enterprise license. This is relevant prior art, not a recommended local drop-in.
Source: [official SAA repository](https://github.com/attenlabs/saa-sdk).

## Proposed interaction and admission rules

The following is design inference, not measured model capability:

1. Listening is explicitly armed, visibly indicated, and has an immediate mute/off control.
2. On credible speech activity, provisionally pause or duck only Paj's owned playback. Do not alter
   global output volume or Bluetooth profiles. Keep enough state to resume if speech is rejected.
3. Preserve the utterance in a bounded RAM buffer. Whisper transcribes without a required prefix.
4. Classify with bounded context: active agent names/projects, whether Paj asked a
question, the last
   relevant assistant turn, and whether a short follow-up window is open. Do not retain a rolling
   transcript of partner conversation as context.
5. Strong evidence of an assistant request admits the body once. An existing busy agent receives
   steering; an idle agent receives a request. Stopping playback alone never cancels agent work.
6. Rejected speech stays local and playback may resume. Uncertain speech causes no agent dispatch;
   do not constantly interrupt household conversation with "Was that for me?" prompts.
7. On accepted interruption, discard old playback and queued stale speech. Suppress new spoken
   updates while the user is giving the command. Enforce epochs, deadlines, and duplicate rejection.
8. Keep an optional explicit attention phrase as an override. An open follow-up window is evidence,
   not permission to automatically forward every subsequent utterance.

A classifier is not an authorization boundary for destructive operations. Normal agent permissions
and explicit confirmations still apply after speech admission.

## Subsequent local evaluation

The initial local tests did not establish a useful addressee filter. The frozen GLiNER2 setup marked
all 24 held-out fixtures uncertain and falsely accepted one development game-chat example. The
GLiClass-edge comparison marked every reused fixture uncertain. Its warm CPU classifier stage was
faster, about 37 ms versus 365 ms, but speed did not make the decisions useful. The same fixtures
were reused for comparison, not an independent second household evaluation. See [GLiNER2
evidence](addressing-benchmark.md) and [GLiClass evidence](addressing-gliclass-benchmark.md).

The commands-disabled lab defaults to the lighter GLiClass bundle only for testing interaction.
Neither setup is qualified for automatic agent admission. Synthetic speech also exposed "yes"
being misheard as "Best" and safely discarded, while "of course" worked; these Piper samples do
not establish the user's actual speech performance. No new threshold tuning or further model
search is justified by treating these fixture failures as successes.

## Limitations and acceptance evidence

Identical words can address a partner or Paj. "What is the status of the Nix agent?" may be a quoted
example or a question to a colleague. Speaker identity alone cannot solve this when the same person
addresses both. Text does not contain gaze or unspoken intent; uncertainty is unavoidable.

The task's existing measurements put Whisper inference around 0.8-2 seconds in several tests; one
barge-in stopped playback 6.069 seconds after first detected speech activity. These are historical
project observations, not new measurements. Adding a downstream classifier cannot eliminate STT
latency. Reversible VAD-based pausing addresses perceived interruption latency separately.

Semantic classification is not acoustic echo cancellation. An own-playback reference,
echo rejection,
and headphone leakage tests remain necessary; no AEC candidate has qualified in this project.
Do not promise pause timing, household rejection accuracy, or game performance without testing.

Proposed next evidence, requiring separate model-download approval:

- Begin with offline, authored text fixtures and held-out paraphrases, not live capture or training.
- Cover partner talk, game chat, self-talk, quoted requests, incomplete STT, broad
coding statements,
  real requests, follow-ups, and identical ambiguous phrases in different available contexts.
- Evaluate false accepts and missed requests separately, including whether ambiguity is rejected.
- Benchmark warm CPU inference, memory, and the complete STT-plus-classifier path under game load.
- Only after offline evidence, seek consent for bounded, commands-disabled live qualification.
  Measure unwanted activations per hour in representative conditions, not just balanced accuracy.

No reviewed source demonstrates a guaranteed wake-free gate for this particular room and workflow.
