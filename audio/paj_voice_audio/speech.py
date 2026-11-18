import os
from pathlib import Path
import time


class SpeechInference:
    def __init__(self, root=None, *, stt=None, tts=None, tts_config=None, compute_type="int8", volume=0.4, length_scale=1):
        for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
            os.environ[name] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        import numpy as np
        from faster_whisper import WhisperModel
        from piper import PiperVoice
        from pysilero_vad import SileroVoiceActivityDetector

        root = Path(root) if root is not None else None
        stt = stt or root / "stt"
        tts = tts or root / "tts/model.onnx"
        tts_config = tts_config or root / "tts/model.onnx.json"
        vad = SileroVoiceActivityDetector()
        if not isinstance(vad.chunk_bytes(), int) or not 0 < vad.chunk_bytes() <= 4096:
            raise ValueError("Unsupported packaged VAD frame size")
        self.volume, self.length_scale = volume, length_scale
        self.np = np
        self.whisper = WhisperModel(str(stt), device="cpu", compute_type=compute_type,
                                    cpu_threads=2, num_workers=1, local_files_only=True)
        if "en" not in self.whisper.supported_languages:
            raise ValueError("The local recognition model must support English")
        self.voice = PiperVoice.load(str(tts), config_path=str(tts_config), use_cuda=False)
        self.rate = self.voice.config.sample_rate
        if type(self.rate) is not int or not 8000 <= self.rate <= 48000:
            raise ValueError("Unsupported packaged voice rate")

    def transcribe(self, pcm):
        started = time.monotonic()
        samples = self.np.frombuffer(pcm, dtype="<i2").astype(self.np.float32) / 32768
        segments, _ = self.whisper.transcribe(samples, language="en", beam_size=1,
                                             temperature=0, condition_on_previous_text=False,
                                             vad_filter=False)
        text = "".join(segment.text for segment in segments).strip()
        return text, (time.monotonic() - started) * 1000

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
