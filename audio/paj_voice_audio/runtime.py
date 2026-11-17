"""Historical wake-prefix prototype; the addon CLI uses open_mic.Runtime."""

import json
import math
import os
import re
import threading
import time
from pathlib import Path

from .core import Playback, Turns
from .devices import Graph, PipeCapture, PipeSink

os.environ.update(
    HF_HUB_OFFLINE="1",
    TRANSFORMERS_OFFLINE="1",
    HF_HUB_DISABLE_TELEMETRY="1",
    DO_NOT_TRACK="1",
)


def validate(config):
    if (
        not isinstance(config, dict)
        or config.get("version") != 1
        or config.get("languages") != ["en"]
        or config.get("responseLanguage") != "en"
    ):
        raise ValueError("Only version 1 English configuration is supported")
    phrases = config.get("addressPhrases")
    if (
        not isinstance(phrases, list)
        or not 1 <= len(phrases) <= 8
        or any(
            not isinstance(p, str) or not re.fullmatch(r"[a-z]+(?: [a-z]+){0,3}", p)
            for p in phrases
        )
    ):
        raise ValueError("Invalid address phrases")
    for section, field, directory in (
        ("stt", "model", True),
        ("tts", "model", False),
        ("tts", "config", False),
    ):
        value = config.get(section, {}).get(field)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError("Models must be explicit absolute local paths")
        path = Path(value)
        if not (path.is_dir() if directory else path.is_file()):
            raise ValueError(f"Missing local {section}.{field}")
    for asset in ("model.bin", "config.json", "tokenizer.json"):
        if not (Path(config["stt"]["model"]) / asset).is_file():
            raise ValueError(f"Missing local STT asset: {asset}")
    if config["stt"].get("computeType") not in ("int8", "float32"):
        raise ValueError("STT compute type must be int8 or float32")
    if "hotwords" in config["stt"]:
        hint = config["stt"]["hotwords"]
        if (
            not isinstance(hint, str)
            or not hint.strip()
            or len(hint) > 256
            or any(ord(char) < 32 or ord(char) == 127 for char in hint)
        ):
            raise ValueError("Invalid stt.hotwords spelling hint")
    voice_config = json.loads(Path(config["tts"]["config"]).read_text(encoding="utf-8"))
    language = voice_config.get("language", {})
    code = (
        language.get("code")
        or language.get("family")
        or voice_config.get("espeak", {}).get("voice")
    )
    if not isinstance(code, str) or not re.fullmatch(
        r"en(?:[-_][a-z0-9]+)*", code.lower()
    ):
        raise ValueError(
            "An English Piper voice with explicit language metadata is required"
        )
    audio = config.get("audio", {})
    if audio.get("echoCancellation") != "external":
        raise ValueError(
            "An externally echo-cancelled capture/playback pair is required"
        )
    if any(
        not isinstance(audio.get(key), str) or not audio[key].strip()
        for key in ("input", "output")
    ):
        raise ValueError("Explicit native PipeWire node names are required")
    for field, low, high in (
        ("silenceMs", 300, 5000),
        ("maxSeconds", 5, 120),
        ("prefixIntervalMs", 200, 2000),
        ("speechThreshold", 0.001, 0.2),
    ):
        value = config.get("turn", {}).get(field)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not low <= value <= high
        ):
            raise ValueError(f"Invalid turn.{field}")
    return config


class Runtime:
    def __init__(self, emit):
        self.emit = emit
        self.lock = threading.RLock()
        self.closed = False
        self.failed = False
        self.configured = False
        self.loaded = False
        self.ready = False
        self.muted = False
        self.capture = None
        self.sink = None
        self.playback = None
        self.turns = None
        self.graph = None
        self.stopped = threading.Event()

    def command(self, frame):
        kind = frame.get("type")
        with self.lock:
            if self.closed:
                return
            if kind == "configure":
                if self.configured:
                    raise ValueError("Companion can only be configured once")
                self.configured = True
                threading.Thread(
                    target=self._load,
                    args=(frame.get("config"),),
                    daemon=True,
                    name="voice-load",
                ).start()
            elif not self.configured:
                raise ValueError("Configure must be the first command")
            elif kind == "shutdown":
                self.shutdown()
            elif kind == "stop":
                if self.playback:
                    self.playback.stop()
            elif kind == "mute":
                if not isinstance(frame.get("muted"), bool):
                    raise ValueError("Mute must be boolean")
                self._mute(frame["muted"])
            elif kind == "speak":
                if not self.ready:
                    raise ValueError("Speech requested before ready")
                with self.turns.cv:
                    if (
                        not self.muted
                        and not self.turns.current
                        and not any(t.addressed for t in self.turns.turns.values())
                    ):
                        self.playback.enqueue(frame)
            else:
                raise ValueError("Unknown companion command")

    def _load(self, config):
        try:
            self.config = validate(config)
            graph = Graph()
            source, target = graph.bind(
                config["audio"]["input"], config["audio"]["output"]
            )
            import numpy as np
            from faster_whisper import WhisperModel
            from piper import PiperVoice
            from pysilero_vad import SileroVoiceActivityDetector

            model = WhisperModel(
                config["stt"]["model"],
                device="cpu",
                compute_type=config["stt"]["computeType"],
                cpu_threads=2,
                num_workers=1,
                local_files_only=True,
            )
            if "en" not in model.supported_languages:
                raise ValueError("The recognition model does not support English")
            voice = PiperVoice.load(
                config["tts"]["model"],
                config_path=config["tts"]["config"],
                use_cuda=False,
            )
            rate = voice.config.sample_rate
            if (
                isinstance(rate, bool)
                or not isinstance(rate, int)
                or not 8000 <= rate <= 192000
            ):
                raise ValueError("Unsupported Piper sample rate")

            def transcribe(pcm):
                samples = (
                    np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
                )
                segments, _ = model.transcribe(
                    samples,
                    language="en",
                    beam_size=1,
                    temperature=0,
                    condition_on_previous_text=False,
                    vad_filter=False,
                    hotwords=config["stt"].get("hotwords"),
                )
                return "".join(segment.text for segment in segments).strip()

            def synthesize(text):
                total = 0
                for chunk in voice.synthesize(text):
                    if (
                        chunk.sample_channels != 1
                        or chunk.sample_width != 2
                        or chunk.sample_rate != rate
                    ):
                        raise RuntimeError("Unexpected TTS audio format")
                    pcm = chunk.audio_int16_bytes
                    total += len(pcm)
                    if total > rate * 2 * 60:
                        raise RuntimeError("TTS duration safety limit exceeded")
                    yield pcm

            with self.lock:
                if self.closed:
                    return
                self.graph, self.source = graph, source
                self.vad_factory = SileroVoiceActivityDetector
                self.sink = PipeSink(graph.paths["pw-play"], target, rate)
                self.playback = Playback(synthesize, self.sink, self.emit, self.fail)
                self.turns = Turns(
                    config["turn"],
                    config["addressPhrases"],
                    transcribe,
                    self.playback,
                    self.emit,
                    self.fail,
                )
                self.turns.reset(True)
                self.loaded = True
                if not self.muted:
                    self._start_capture()
                threading.Thread(
                    target=self._health, daemon=True, name="voice-health"
                ).start()
        except Exception as error:
            self.fail(error)

    def _capture(self):
        return PipeCapture(
            self.graph.paths["pw-record"],
            self.source,
            self.vad_factory,
            self.config["turn"]["speechThreshold"],
            self.turns,
            self.fail,
        )

    def _start_capture(self):
        capture = self._capture()
        self.capture = capture
        capture.start()
        threading.Thread(
            target=self._capture_ready,
            args=(capture,),
            daemon=True,
            name="voice-capture-ready",
        ).start()

    def _capture_ready(self, capture):
        try:
            capture.wait_ready()
            with self.lock:
                if self.closed or self.muted or self.capture is not capture:
                    return
                self.turns.reset(False)
                if not self.ready:
                    self.ready = True
                    self.emit({"type": "ready"})
        except Exception as error:
            with self.lock:
                if not self.closed and not self.muted and self.capture is capture:
                    self.fail(error)

    def _mute(self, muted):
        if self.muted == muted:
            return
        self.muted = muted
        if self.turns:
            self.turns.reset(True)
        if self.playback:
            self.playback.stop()
        if self.capture:
            capture, self.capture = self.capture, None
            capture.close()
        if self.loaded and not muted:
            self._start_capture()

    def _health(self):
        next_graph = time.monotonic() + 2
        while not self.stopped.wait(0.1):
            try:
                with self.lock:
                    if self.closed:
                        return
                    capture = self.capture
                    sink, playback, turns, graph = (
                        self.sink,
                        self.playback,
                        self.turns,
                        self.graph,
                    )
                if time.monotonic() >= next_graph:
                    graph.check()
                    next_graph = time.monotonic() + 2
                sink.health()
                playback.health()
                turns.health()
                if capture:
                    capture.health()
            except Exception as error:
                self.fail(error)
                return

    def fail(self, error):
        with self.lock:
            if self.failed or self.closed:
                return
            self.failed = True
            try:
                self.emit({"type": "error", "message": str(error)[:512]})
            finally:
                self.shutdown()

    def shutdown(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.stopped.set()
            if self.turns:
                self.turns.close()
            if self.capture:
                capture, self.capture = self.capture, None
                try:
                    capture.close()
                except Exception:
                    pass
            if self.playback:
                try:
                    self.playback.close()
                except Exception:
                    pass
            if self.sink:
                try:
                    self.sink.close()
                except Exception:
                    pass
