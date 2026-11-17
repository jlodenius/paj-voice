# OpenAI Luna and local invocation classification

## Finding

**Luna is a verified OpenAI model name, not necessarily a mistaken recollection.** OpenAI's
model page identifies **GPT-6 Luna**, model ID `gpt-6-luna`, with text/image inputs, text outputs,
and **no audio support**. It lists token-based API pricing, including $0.10 input and $0.50 output
per million text tokens at the displayed standard rates.
Source: [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).

The likely remembered classification capability is the **Decisions API**. Microsoft's official
Azure OpenAI documentation describes `/openai/v1/decisions`, currently supporting `gpt-6-luna`,
with three bounded question types: `predicate` returns an estimated probability, `choice` selects
from supplied options, and `score` evaluates ordered rubric levels. Inputs are text and/or images;
examples include refund detection and department routing, not microphone addressee detection.
Source: [Microsoft Decisions documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/decisions).

OpenAI's Decisions guide and announcement were discoverable in search, but direct retrieval
returned HTTP 403. They are navigation leads, **not the evidence for detailed claims here**:
[OpenAI guide](https://developers.openai.com/api/docs/guides/decisions),
[OpenAI announcement](https://openai.com/index/decisions-api/).

**Deployment conclusion:** the verified Luna offering is a hosted API, not a verified downloadable
local classifier. Azure's documented setup requires a subscription, resource, deployed model and
credentials; OpenAI's page specifies usage-based API billing. Neither reviewed page supplies Luna
weights, a local inference procedure, or a local-weight license. That is a bounded documentation
finding, **not proof that no local Luna offering exists anywhere**.
Sources: [Azure prerequisites](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/decisions),
[OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6-luna).

## What this does, and does not, establish

A developer could ask a predicate such as “Is this transcript addressed to the coding assistant?”
and supply conversation context. That is a proposed application of the documented predicate API,
**not a verified pretrained invocation detector or an accuracy guarantee**. Microsoft explicitly
instructs users to choose thresholds using labeled application examples and false-positive versus
false-negative costs; refusals must be handled separately from low-probability answers.
Source: [Decisions interpretation guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/decisions).

Realtime **turn detection is a different problem**. Microsoft's Realtime documentation describes
`server_vad` as silence-based chunking and `semantic_vad` as estimating whether a speaker has
finished an utterance. It also permits disabling automatic response creation. Those documented
controls do not establish that the speaker intended to address the assistant. Realtime receives
client audio over a hosted API; it is not a local/private substitute for local STT.
Source: [Realtime audio and VAD documentation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio).

Bounded searches for OpenAI invocation/addressee detection did not identify a separately released,
locally runnable OpenAI addressee classifier. Some queries were blocked with HTTP 202; direct
OpenAI Realtime VAD documentation returned HTTP 403. **No result is not proof of absence.** The
positive evidence above is enough to distinguish Luna classification from speech endpointing.

## Verified local alternatives

These are alternatives for **transcript processing**, not interchangeable audio wake detectors.
None of the reviewed cards establishes dinner-versus-agent addressee accuracy in this room.

### GLiNER2: most direct initial classifier candidate

`fastino/gliner2-base-v1` is a downloadable 205M-parameter BERT-based encoder with text
classification, entity extraction and structured extraction. Its author-maintained card documents
single-label and multi-label classification, CPU inference without a GPU, local fine-tuning, and
Apache 2.0 licensing. The hosted Fastino service is optional, not required by the documented local
model interface. No hardware-specific latency or memory budget for this workstation is established.
Source: [Fastino model card](https://huggingface.co/fastino/gliner2-base-v1).

**Inference:** this is the closest ready-made local interface for an initial comparison of labels
such as `assistant_request`, `other_conversation`, and `uncertain`. Those labels and their operating
thresholds would still need task-specific evaluation; the generic card is not evidence that
zero-shot labels reliably identify an addressee.

### ModernBERT: custom trained classifier backbone

`answerdotai/ModernBERT-base` is a downloadable 149M-parameter encoder, released under Apache 2.0.
Its card describes the base checkpoint as a masked language model and explicitly calls for
fine-tuning for downstream classification. It is therefore not an out-of-the-box intent detector.
Source: [ModernBERT author model card](https://huggingface.co/answerdotai/ModernBERT-base).

**Inference:** consider it if labeled household/game/agent transcripts justify training a dedicated
classification head. This research establishes neither CPU latency nor a memory requirement on the
actual machine; parameter count alone is not a runtime benchmark.

### FunctionGemma: local function routing, not a proven addressee detector

Google describes FunctionGemma as a text-only, 270M-parameter Gemma 3 derivative for function
calling, intended for task-specific fine-tuning rather than direct dialogue. It has open weights
under Gemma's terms, not an Apache/MIT grant. Google documents local laptop/desktop deployment and
an on-device CPU example; its Samsung S25 Ultra measurements do not predict this gaming machine's
latency or contention with Whisper.
Sources: [Google overview](https://ai.google.dev/gemma/docs/functiongemma),
[Google model card](https://gemma.ai/models/functiongemma/model-card/).

**Inference:** useful if the goal also includes mapping accepted utterances to a fixed action API.
For accepting versus rejecting ambient conversation alone, it adds a generative function-calling
interface without demonstrated addressee benefit. Function relevance is not the same as deciding
who was being addressed.

### OpenAI gpt-oss-safeguard: genuinely downloadable, wrong specialization

OpenAI's `gpt-oss-safeguard-20b` card explicitly offers downloadable Apache-2.0 weights and
classification of **text against supplied safety policies**. It describes 21B total/3.6B active
parameters and fitting on a 16 GB VRAM GPU, requires Harmony formatting, and recommends ordinary
gpt-oss for applications outside safety. This is evidence of an open OpenAI specialized classifier,
but **not Luna and not a recommended small invocation model**.
Source: [OpenAI-owned model card](https://huggingface.co/openai/gpt-oss-safeguard-20b).

## Recommendation for the open-microphone gaming scenario

**Do not adopt Luna for this requirement:** the verified service would send transcripts/images to
a hosted endpoint and incur API usage rather than satisfy local-only classification. Luna also
cannot replace STT because its documented modalities exclude audio.
Sources: [OpenAI modalities and pricing](https://developers.openai.com/api/docs/models/gpt-6-luna),
[Azure service setup](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/decisions).

**Research recommendation, not a qualified deployment:** retain local STT, compare GLiNER2 with a
small task-trained encoder, and keep an explicit arming/wake or push-to-talk mechanism available.
Evaluate before allowing ambient speech to become agent steering. Include partner conversations,
game speech, self-talk, quoted agent requests, incomplete transcripts, and ambiguous “How is it
going?” examples; include explicit assistant-status positives and conversational follow-ups.
Measure false accepts per hour, missed requests, and end-to-end latency under game load, not just
balanced-dataset accuracy. Reject uncertainty by default. These are proposed acceptance criteria,
not results of this research.

**Fundamental inference:** identical transcripts can be addressed to a partner or an agent. A
text-only model sees neither gaze nor physical addressee; even perfect STT cannot supply missing
intent. Speaker identity is also insufficient when the same user addresses both parties. Context
and explicit arming can reduce ambiguity, but no reviewed source demonstrates a guaranteed
wake-free solution for this scenario.

The supplied baseline is approximately 0.8–2 seconds for Whisper `base.en` with two CPU threads,
with a measured 6.069-second first-VAD-to-playback-stop path and no qualified AEC candidate. These
are **task-owner-provided observations, not independently remeasured here**. A downstream
transcript classifier cannot remove the time spent obtaining that transcript, and classification
does not itself cancel acoustic echo. This note makes no hardware or latency qualification claim.

## Research scope and caveats

Reviewed repository Markdown conventions in `README.md`; this is a research-only note. Used ddgr
for bounded discovery and read official vendor documentation or author-owned model cards. No
microphone/playback access, model downloads, installations, service starts, production-code edits,
configuration changes, branches, or commits were performed. Search and extraction blocks are
reported above rather than filled with secondary-source assertions. Model cards establish model
identity and intended deployment, not independently validated household addressee performance.
