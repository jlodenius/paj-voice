from dataclasses import dataclass
import os
from pathlib import Path
import re
import time


@dataclass(frozen=True)
class Transcription:
    text: str
    elapsed_ms: float
    rejected_reason: str | None = None


def implausible_repetition(text, speech_seconds):
    words = re.findall(r"[^\W_]+", text.casefold())
    for period in range(1, min(6, len(words) // 8) + 1):
        matched = 0
        for index in range(period, len(words)):
            matched = matched + 1 if words[index] == words[index - period] else 0
            span = matched + period
            if (span >= period * 8 and span >= len(words) * 0.6
                    and span > 8 * (speech_seconds + 0.25)):
                return True
    return False


@dataclass(frozen=True)
class SpeechOutput:
    voice: object
    rate: int
    volume: float
    length_scale: float

    @classmethod
    def load(cls, model, config, *, volume, length_scale):
        from piper import PiperVoice

        voice = PiperVoice.load(str(model), config_path=str(config), use_cuda=False)
        rate = voice.config.sample_rate
        if type(rate) is not int or not 8000 <= rate <= 48000:
            raise ValueError("Unsupported packaged voice rate")
        return cls(voice, rate, volume, length_scale)

    def synthesize(self, text):
        from piper import SynthesisConfig

        config = SynthesisConfig(volume=self.volume, length_scale=self.length_scale)
        result = bytearray()
        for chunk in self.voice.synthesize(text, syn_config=config):
            if (chunk.sample_channels != 1 or chunk.sample_width != 2
                    or chunk.sample_rate != self.rate):
                raise RuntimeError("Unexpected synthesis format")
            result.extend(chunk.audio_int16_bytes)
            if len(result) > self.rate * 120:
                raise RuntimeError("Synthesis exceeds speech bound")
        return bytes(result)


class SpeechInference:
    def __init__(self, root=None, *, stt=None, tts=None, tts_config=None, compute_type="int8", volume=0.4, length_scale=1):
        for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
            os.environ[name] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        import numpy as np
        from faster_whisper import WhisperModel
        from pysilero_vad import SileroVoiceActivityDetector

        root = Path(root) if root is not None else None
        stt = stt or root / "stt"
        tts = tts or root / "tts/model.onnx"
        tts_config = tts_config or root / "tts/model.onnx.json"
        vad = SileroVoiceActivityDetector()
        if not isinstance(vad.chunk_bytes(), int) or not 0 < vad.chunk_bytes() <= 4096:
            raise ValueError("Unsupported packaged VAD frame size")
        self.np = np
        self.whisper = WhisperModel(str(stt), device="cpu", compute_type=compute_type,
                                    cpu_threads=2, num_workers=1, local_files_only=True)
        if "en" not in self.whisper.supported_languages:
            raise ValueError("The local recognition model must support English")
        self.output = SpeechOutput.load(tts, tts_config, volume=volume, length_scale=length_scale)
        self.rate = self.output.rate

    def transcribe(self, pcm, *, speech_seconds=None):
        started = time.monotonic()
        samples = self.np.frombuffer(pcm, dtype="<i2").astype(self.np.float32) / 32768
        segments, _ = self.whisper.transcribe(samples, language="en", beam_size=1,
                                             temperature=0, condition_on_previous_text=False,
                                             vad_filter=False)
        decoded = [segment for segment in segments if segment.text.strip()]
        text = "".join(segment.text for segment in decoded).strip()
        duration = len(pcm) / 32000 if speech_seconds is None else speech_seconds
        reason = None
        if text and (not any(character.isalnum() for character in text)
                     or all(segment.no_speech_prob >= 0.6 and segment.avg_logprob <= -1.0
                            for segment in decoded)):
            reason = "non_speech"
        elif implausible_repetition(text, duration):
            reason = "implausible_repetition"
        return Transcription("" if reason else text, (time.monotonic() - started) * 1000, reason)

    def synthesize(self, text):
        return self.output.synthesize(text)
