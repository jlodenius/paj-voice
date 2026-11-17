import array
import json
import math
import os
from pathlib import Path
import queue
import re
import threading
import time

from .input_ready import InputReady
from .lab_audio import LabCapture, Segments, Speaker
from .devices import Graph, PipeSink
from .speech import SpeechInference


def validate(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("Expected version 1 open-mic preferences")
    if set(value) - {"version", "languages", "responseLanguage", "cacheDir", "stt", "tts", "audio", "turn"}:
        raise ValueError("Unsupported voice fields; remove wake phrases and legacy prefix settings")
    if value.get("languages", ["en"]) != ["en"] or value.get("responseLanguage", "en") != "en":
        raise ValueError("Only English speech is supported")
    config = dict(value)
    bundle = Path(os.environ.get("PAJ_VOICE_SPEECH_BUNDLE", "/nonexistent"))
    stt, tts = dict(value.get("stt", {})), dict(value.get("tts", {}))
    if set(stt) - {"model", "computeType"} or set(tts) - {"model", "config"}:
        raise ValueError("Unsupported speech model fields; spelling hints are not used")
    stt.setdefault("model", str(bundle / "stt"))
    stt.setdefault("computeType", "int8")
    tts.setdefault("model", str(bundle / "tts/model.onnx"))
    tts.setdefault("config", tts["model"] + ".json")
    if stt["computeType"] not in ("int8", "float32"):
        raise ValueError("Invalid STT compute type")
    for path, directory in ((stt["model"], True), (tts["model"], False), (tts["config"], False)):
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise ValueError("Speech assets must be absolute local paths")
        if not (Path(path).is_dir() if directory else Path(path).is_file()):
            raise ValueError("Missing local speech asset; build the bundled package first")
    for name in ("model.bin", "config.json", "tokenizer.json"):
        if not (Path(stt["model"]) / name).is_file():
            raise ValueError("Incomplete local Whisper model")
    metadata = json.loads(Path(tts["config"]).read_text())
    language = metadata.get("language", {}).get("code") or metadata.get("espeak", {}).get("voice")
    if not isinstance(language, str) or not re.fullmatch(r"en(?:[-_][a-z0-9]+)*", language.lower()):
        raise ValueError("An English Piper voice is required")
    audio = value.get("audio", {})
    if (not isinstance(audio, dict) or set(audio) - {"input", "output", "echoCancellation"}
            or audio.get("echoCancellation") not in ("none", "external")
            or any(not isinstance(audio.get(key), str) or not audio[key].strip()
                   or audio[key] == "default" for key in ("input", "output"))):
        raise ValueError("Exact PipeWire input/output names and explicit echo handling are required")
    turn = dict(value.get("turn", {}))
    if set(turn) - {"silenceMs", "maxSeconds", "speechThreshold"}:
        raise ValueError("Prefix/wake timing settings are not supported")
    for key, default, low, high in (("silenceMs", 800, 300, 5000), ("maxSeconds", 12, 5, 30),
                                     ("speechThreshold", 0.001, 0.001, 0.2)):
        turn.setdefault(key, default)
        number = turn[key]
        if type(number) not in (int, float) or not math.isfinite(number) or not low <= number <= high:
            raise ValueError("Invalid utterance timing or speech threshold")
    cache = value.get("cacheDir")
    if not isinstance(cache, str) or not Path(cache).is_absolute():
        raise ValueError("The resolved runtime cache directory must be absolute")
    config.update(stt=stt, tts=tts, audio=dict(audio), turn=turn)
    return config


class HealthyInput:
    def __init__(self, receiver):
        self.receiver = receiver

    def feed(self, pcm, voiced, captured_at=None):
        samples = array.array("h", pcm)
        # The observed startup fault was flat saturation/DC, not ordinary clipped speech peaks.
        if (abs(sum(samples) / len(samples) / 32768) > 0.5
                and sum(abs(value) >= 32760 for value in samples) >= len(samples) / 2):
            raise RuntimeError("Input returned to flat clipping/DC corruption; audio stopped")
        self.receiver.feed(pcm, voiced, captured_at=captured_at)

    def close(self):
        self.receiver.close()


class Runtime:
    def __init__(self, emit):
        self.emit = emit
        self.lock = threading.RLock()
        self.model_lock = threading.Lock()
        self.closed = self.failed = self.configured = self.ready = self.muted = False
        self.stopped = threading.Event()
        self.shutdown_complete = threading.Event()
        self.capture = self.gate = self.segments = self.speaker = self.sink = None
        self.graph = self.models = None
        self.pending = set()
        self.keys = {}
        self.revision = 0
        self.epoch = 0
        self.input_active = False
        self.current_playback = None
        self.stage = "configure"
        self.jobs = queue.Queue(maxsize=2)
        self.speeches = queue.Queue(maxsize=2)
        self.busy = {"recognition": None, "synthesis": None}

    def command(self, frame):
        kind = frame["type"]
        if kind == "shutdown":
            self.shutdown()
            return
        with self.lock:
            if self.closed:
                return
            if kind == "configure":
                if self.configured:
                    raise ValueError("Configure once only")
                self.configured = True
                threading.Thread(target=self._load, args=(frame.get("config"),), daemon=True).start()
                return
            if not self.configured:
                raise ValueError("Configure must be first")
            if kind == "speak":
                text, ident, key = frame.get("text"), frame.get("id"), frame.get("key")
                if (not isinstance(text, str) or not text.strip() or len(text) > 320
                        or len(text.split()) > 50 or any(ord(ch) < 32 or ord(ch) == 127 for ch in text)
                        or not isinstance(ident, str) or not re.fullmatch(r"[\w-]{1,128}", ident)
                        or (key is not None and (not isinstance(key, str) or not key or len(key) > 128))):
                    raise ValueError("Invalid bounded speech request")
                if not self._can_speak():
                    self.emit({"type": "speech_end", "id": ident, "completed": False})
                    return
                if key:
                    self.keys[key] = ident
                    while len(self.keys) > 256:
                        del self.keys[next(iter(self.keys))]
                    kept = []
                    while True:
                        try:
                            previous = self.speeches.get_nowait()
                        except queue.Empty:
                            break
                        if previous.get("key") == key:
                            self.emit({"type": "speech_end", "id": previous["id"], "completed": False})
                            previous.clear()
                        else:
                            kept.append(previous)
                    for previous in kept:
                        self.speeches.put_nowait(previous)
                self.speeches.put_nowait({"id": ident, "text": text, "revision": self.revision, "key": key})
                return
        if kind == "stop":
            self._silence()
        elif kind == "mute" and frame.get("muted") is True:
            self._mute()
        else:
            raise ValueError("Unknown command; resume requires a fresh companion")

    def _load(self, value):
        try:
            self.stage = "preferences"
            config = validate(value)
            self.stage = "cache"
            cache = Path(config["cacheDir"])
            cache.mkdir(parents=True, exist_ok=True, mode=0o700)
            if cache.is_symlink() or cache.stat().st_uid != os.getuid():
                raise ValueError("Runtime cache must be an owned directory, not a symlink")
            os.environ.update(XDG_CACHE_HOME=str(cache), HF_HOME=str(cache / "huggingface"),
                              PYTHONDONTWRITEBYTECODE="1")
            self.stage = "devices"
            graph = Graph()
            source, target = graph.bind(config["audio"]["input"], config["audio"]["output"])
            if source.name.startswith("bluez"):
                raise ValueError("Use the laptop microphone, not a Bluetooth headset microphone")
            self.stage = "models"
            models = SpeechInference(stt=config["stt"]["model"], tts=config["tts"]["model"],
                                     tts_config=config["tts"]["config"], compute_type=config["stt"]["computeType"])
            from pysilero_vad import SileroVoiceActivityDetector
            with self.lock:
                if self.closed or self.muted:
                    return
                self.config, self.graph, self.source, self.models = config, graph, source, models
                self.vad_factory = SileroVoiceActivityDetector
                samples = models.np.arange(int(models.rate * 0.1))
                self.cue = (models.np.sin(2 * models.np.pi * 800 * samples / models.rate)
                            * models.np.hanning(len(samples)) * 1200).astype("<i2").tobytes()
                self.stage = "audio-setup"
                self.sink = PipeSink(graph.paths["pw-play"], target, models.rate)
                self.speaker = Speaker(self.sink, self._speaker_event)
                for target in (self._recognize, self._synthesize, self._health):
                    threading.Thread(target=target, daemon=True).start()
                self.epoch += 1
                epoch = self.epoch
                self.segments = Segments(lambda event: self._segment(event, epoch),
                                         lambda: self._interrupt(epoch), lambda: epoch,
                                         silence=config["turn"]["silenceMs"] / 1000,
                                         maximum=config["turn"]["maxSeconds"])
                self.gate = InputReady(HealthyInput(self.segments))
                self.capture = LabCapture(graph.paths["pw-record"], source, self.vad_factory,
                                          config["turn"]["speechThreshold"], self.gate, self.fail)
                self.stage = "capture-start"
                self.capture.start()
                capture, gate = self.capture, self.gate
            self._warmup(capture, gate, epoch)
            # Linux PDEATHSIG follows the spawning thread; keep it alive until owned children close.
            self.shutdown_complete.wait()
        except Exception as error:
            self.fail(error)

    def _warmup(self, capture, gate, epoch):
        deadline = time.monotonic() + 5
        self.stage = "warmup"
        self.emit({"type": "warming"})
        try:
            capture.wait_ready()
            while time.monotonic() < deadline:
                with self.lock:
                    if self.closed or self.muted or self.epoch != epoch:
                        return
                capture.health()
                if not gate.ready.wait(0.02):
                    continue
                with self.lock:
                    if self.closed or self.muted or self.epoch != epoch:
                        return
                    summary = gate.arm()
                    if summary is not None:
                        self.ready = True
                        self.stage = "listening"
                        self.emit({"type": "ready", "mode": "open-mic", "warmup": summary})
                        self.speaker.play(self.cue, "demo", ident="ready")
                        return
            self.emit({"type": "diagnostic", "stage": "warmup", "details": gate.snapshot()})
            raise RuntimeError("Input did not settle within five seconds")
        except Exception as error:
            with self.lock:
                obsolete = self.closed or self.muted or self.epoch != epoch
            if not obsolete:
                self.fail(error)

    def _interrupt(self, epoch):
        with self.lock:
            if self.closed or self.muted or self.epoch != epoch:
                return
            self.input_active = True
            self.revision += 1
            speaker = self.speaker
            if self.current_playback:
                self.current_playback[1].set()
        speaker.pause()
        speaker.discard()

    def _segment(self, event, epoch):
        try:
            ident = f"e{epoch}-t{event['id']}"
            with self.lock:
                if self.closed or self.muted or not self.ready or self.epoch != epoch:
                    return
                if event["type"] == "onset":
                    if len(self.pending) >= 4:
                        raise RuntimeError("Too many pending utterances")
                    self.pending.add(ident)
                    self.emit({"type": "addressed", "id": ident})
                elif event["type"] == "endpoint":
                    self.input_active = False
                    if event["truncated"] or not event["pcm"]:
                        self.pending.discard(ident)
                        self.emit({"type": "cancelled", "id": ident, "reason": "utterance_limit"})
                    else:
                        self.jobs.put_nowait({"id": ident, "epoch": epoch, "pcm": event["pcm"]})
        except Exception as error:
            self.fail(error)

    def _recognize(self):
        while not self.stopped.is_set():
            try:
                job = self.jobs.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                with self.lock:
                    if self.closed or self.muted or job["epoch"] != self.epoch:
                        continue
                    self.busy["recognition"] = time.monotonic()
                with self.model_lock:
                    text, _ = self.models.transcribe(job.pop("pcm"))
                if not isinstance(text, str) or len(text) > 16384:
                    raise RuntimeError("Recognition output exceeded the text bound")
                with self.lock:
                    if self.closed or self.muted or job["epoch"] != self.epoch:
                        continue
                    self.pending.discard(job["id"])
                    self.emit({"type": "utterance", "id": job["id"], "text": text} if text.strip()
                              else {"type": "cancelled", "id": job["id"], "reason": "empty"})
            except Exception as error:
                self.fail(error)
            finally:
                self.busy["recognition"] = None
                job.clear()

    def _can_speak(self, revision=None):
        return (not self.closed and self.ready and not self.muted and not self.pending
                and not self.input_active and (revision is None or revision == self.revision))

    def _speech_current(self, job):
        return self._can_speak(job["revision"]) and (not job.get("key") or self.keys.get(job["key"]) == job["id"])

    def _synthesize(self):
        while not self.stopped.is_set():
            try:
                job = self.speeches.get(timeout=0.1)
            except queue.Empty:
                continue
            played = False
            try:
                with self.lock:
                    if not self._speech_current(job):
                        continue
                    self.busy["synthesis"] = time.monotonic()
                with self.model_lock:
                    pcm = self.models.synthesize(job["text"])
                with self.lock:
                    if self._speech_current(job):
                        done = threading.Event()
                        self.current_playback = (job["id"], done)
                        self.speaker.play(pcm, "demo", ident=job["id"])
                        played = True
                        self.emit({"type": "speech_start", "id": job["id"]})
                self.busy["synthesis"] = None
                if played:
                    while not self.stopped.is_set() and not done.wait(0.1):
                        pass
            except Exception as error:
                self.fail(error)
            finally:
                self.busy["synthesis"] = None
                if not played and not self.closed:
                    self.emit({"type": "speech_end", "id": job["id"], "completed": False})
                job.clear()

    def _speaker_event(self, event):
        if event["type"] == "played":
            self.emit({"type": "speech_end", "id": event["id"], "completed": True})
            current = self.current_playback
            if current and current[0] == event["id"]:
                current[1].set()
        elif event["type"] == "fault":
            self.fail(RuntimeError(event.get("message") or "Playback failed"), stage="playback")

    def _silence(self):
        with self.lock:
            self.revision += 1
            speaker = self.speaker
            if self.current_playback:
                self.current_playback[1].set()
            while True:
                try:
                    job = self.speeches.get_nowait()
                except queue.Empty:
                    break
                self.emit({"type": "speech_end", "id": job["id"], "completed": False})
                job.clear()
        if speaker:
            speaker.cancel()
            speaker.discard()

    def _mute(self):
        with self.lock:
            self.muted = True
            self.ready = False
            self.epoch += 1
            self.pending.clear()
            gate, capture = self.gate, self.capture
            self.gate = self.capture = None
        self._silence()
        self._close((gate, capture))

    def _health(self):
        next_graph = 0
        while not self.stopped.wait(0.1):
            try:
                if time.monotonic() >= next_graph:
                    self.graph.check()
                    next_graph = time.monotonic() + 1
                self.sink.health()
                capture = self.capture
                if capture:
                    capture.health()
                for started in self.busy.values():
                    if started is not None and time.monotonic() - started > 10:
                        raise RuntimeError("Local inference exceeded ten seconds")
            except Exception as error:
                self.fail(error)
                return

    def fail(self, error, stage=None):
        with self.lock:
            if self.failed or self.closed:
                return
            self.failed = True
        try:
            self.emit({"type": "error", "stage": stage or self.stage, "message": str(error)[:512]})
        finally:
            self.shutdown()

    @staticmethod
    def _close(resources):
        for resource in resources:
            if resource is not None:
                try:
                    resource.close()
                except Exception:
                    pass

    def shutdown(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            self.ready = False
            self.epoch += 1
            self.revision += 1
            self.stopped.set()
            self.pending.clear()
            if self.current_playback:
                self.current_playback[1].set()
            resources = self.gate, self.capture, self.speaker, self.sink
            self.gate = self.capture = None
        self._close(resources)
        for inbox in (self.jobs, self.speeches):
            while True:
                try:
                    inbox.get_nowait().clear()
                except queue.Empty:
                    break
        self.shutdown_complete.set()
