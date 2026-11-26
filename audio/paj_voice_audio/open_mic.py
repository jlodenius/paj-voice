import array
import math
import os
from pathlib import Path
import queue
import re
import threading
import time

from .input_ready import InputReady
from .audio import Capture, Segments, Speaker
from .devices import CaptureFault, Graph, Node, PipeSink, exact_name
from .speech import SpeechInference, SpeechOutput
from .voices import DEFAULT_LENGTH_SCALE, resolve_default_voice, resolve_voice, validate_voice_assets


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
    if set(stt) - {"model", "computeType"} or set(tts) - {"model", "config", "voice", "volume", "lengthScale"}:
        raise ValueError("Unsupported speech model fields; spelling hints are not used")
    stt.setdefault("model", str(bundle / "stt"))
    stt.setdefault("computeType", "int8")
    if "voice" in tts:
        tts.update(resolve_voice(bundle, tts['voice']))
    elif not ({"model", "config"} & tts.keys()):
        tts.update(resolve_default_voice(bundle))
    for key, default, low, high in (("volume", 0.4, 0, 1), ("lengthScale", DEFAULT_LENGTH_SCALE, 0.5, 2)):
        tts.setdefault(key, default)
        if type(tts[key]) not in (int, float) or not math.isfinite(tts[key]) or not low <= tts[key] <= high:
            raise ValueError('Invalid speech volume or speed')
    tts.setdefault("model", str(bundle / "tts/model.onnx"))
    tts.setdefault("config", tts["model"] + ".json")
    if stt["computeType"] not in ("int8", "float32"):
        raise ValueError("Invalid STT compute type")
    path = stt["model"]
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError("Speech assets must be absolute local paths")
    if not Path(path).is_dir():
        raise ValueError("Missing local speech asset; build the bundled package first")
    validate_voice_assets(tts['model'], tts['config'])
    for name in ("model.bin", "config.json", "tokenizer.json"):
        if not (Path(path) / name).is_file():
            raise ValueError("Incomplete local Whisper model")
    audio = value.get("audio", {})
    if (not isinstance(audio, dict) or set(audio) - {"input", "output", "echoCancellation", "inputDevice", "outputDevice", "fallback", "speakerMode"}
            or audio.get("echoCancellation") not in ("none", "external")
            or any(not isinstance(audio.get(key), str) or not audio[key].strip()
                   or audio[key] == "default" for key in ("input", "output"))):
        raise ValueError("Exact PipeWire input/output names and explicit echo handling are required")
    if 'fallback' in audio and not isinstance(audio['fallback'], dict):
        raise ValueError("Invalid fallback audio route")
    for route in (audio, audio.get("fallback")):
        if route is None:
            continue
        if not isinstance(route, dict):
            raise ValueError("Invalid fallback audio route")
        if route is not audio:
            if (set(route) - {"name", "input", "output", "inputDevice", "outputDevice", "speakerMode"}
                    or not isinstance(route.get("name"), str) or not route["name"].strip()
                    or len(route["name"]) > 80
                    or any(ord(char) < 32 or ord(char) == 127 for char in route["name"])):
                raise ValueError("Invalid fallback friendly name or fields")
        if 'speakerMode' in route and type(route['speakerMode']) is not bool:
            raise ValueError("Invalid speaker mode")
        for key, kind in (("input", "Audio/Source"), ("output", "Audio/Sink")):
            exact_name(route.get(key), kind)
        for key in ("inputDevice", "outputDevice"):
            identity = route.get(key)
            if identity is not None and (not isinstance(identity, str) or not identity.strip()
                    or len(identity) > 1024 or any(ord(char) < 32 or ord(char) == 127 for char in identity)):
                raise ValueError("Invalid physical audio device identity")
    turn = dict(value.get("turn", {}))
    if set(turn) - {"silenceMs", "maxSeconds", "speechThreshold"}:
        raise ValueError("Prefix/wake timing settings are not supported")
    for key, default, low, high in (("silenceMs", 800, 300, 5000), ("maxSeconds", 120, 5, 120),
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
    def __init__(self, receiver, allowed=None):
        self.receiver, self.allowed = receiver, allowed

    def feed(self, pcm, voiced, captured_at=None):
        samples = array.array("h", pcm)
        # The observed startup fault was flat saturation/DC, not ordinary clipped speech peaks.
        if (abs(sum(samples) / len(samples) / 32768) > 0.5
                and sum(abs(value) >= 32760 for value in samples) >= len(samples) / 2):
            raise CaptureFault('capture_dc_corruption', "Input returned to flat clipping/DC corruption; audio stopped")
        if self.allowed is None or self.allowed(pcm, voiced, captured_at):
            self.receiver.feed(pcm, voiced, captured_at=captured_at)

    def close(self):
        self.receiver.close()


class Runtime:
    def __init__(self, emit, clock=time.monotonic):
        self.emit = emit
        self.clock = clock
        self.lock = threading.RLock()
        self.model_lock = threading.Lock()
        self.speech_bundle = Path(os.environ.get('PAJ_VOICE_SPEECH_BUNDLE', '/nonexistent'))
        self.tts_reload_inflight = False
        self.input_cleanup_lock = threading.Lock()
        self.retired_inputs = []
        self.closed = self.failed = self.configured = self.ready = self.muted = False
        self.stopped = threading.Event()
        self.shutdown_complete = threading.Event()
        self.capture = self.gate = self.segments = self.speaker = self.sink = None
        self.graph = self.models = None
        self.pending = set()
        self.recovery_count = 0
        self.availability_observation = dict.fromkeys(
            ('inputPresent', 'outputPresent', 'inputChanged', 'outputChanged'))
        self.keys = {}
        self.revision = 0
        self.epoch = 0
        self.input_active = False
        self.using_fallback = False
        self.listening = True
        self.owned_playback = False
        self.owned_playback_token = None
        self.acoustic_until = float('-inf')
        self.guard_quiet = None
        self.guard_voiced = False
        self.input_available = self.output_available = False
        self.output_epoch = 0
        self.input_deadline = 0
        self.input_pause = None
        self.pause_revision = 0
        self.pause_requests = {}
        self.frozen = ()
        self.current_playback = None
        self.active_speech = None
        self.stage = "configure"
        self.jobs = queue.Queue(maxsize=2)
        self.speeches = queue.Queue(maxsize=2)
        self.speech_available = threading.Condition(self.lock)
        self.busy = {"recognition": None, "synthesis": None}

    def command(self, frame):
        kind = frame["type"]
        if kind == "shutdown":
            self.shutdown()
            return
        if kind == 'input_pause':
            self._pause_input(frame)
            return
        if kind == 'reload_tts':
            self._reload_tts(frame)
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
                self.speech_available.notify()
                return
        if kind == "stop":
            with self.lock:
                paused = self.input_pause is not None
                if paused:
                    self.input_pause['phase'] = 'held'
                    self.pause_revision += 1
            if paused:
                self._suspend(input_lost=True)
                with self.lock:
                    self._pause_state()
            self._silence()
        elif kind == "mute" and frame.get("muted") is True:
            self._mute()
        else:
            raise ValueError("Unknown command; resume requires a fresh companion")

    def _reload_tts(self, frame):
        ident = frame.get('id')
        if not isinstance(ident, str) or not re.fullmatch(r'[\w-]{1,128}', ident):
            return
        tts = frame.get('tts')
        valid = (set(frame) == {'type', 'id', 'tts'} and isinstance(tts, dict)
                 and set(tts) in ({'volume', 'lengthScale'}, {'voice', 'volume', 'lengthScale'})
                 and ('voice' not in tts or (isinstance(tts['voice'], str)
                      and re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', tts['voice'])))
                 and type(tts['volume']) in (int, float) and 0 <= tts['volume'] <= 1
                 and type(tts['lengthScale']) in (int, float) and 0.5 <= tts['lengthScale'] <= 2)
        with self.lock:
            if self.closed or self.failed:
                return
            if not valid or not self._tts_reload_ready() or self.tts_reload_inflight:
                self.emit({'type': 'tts_reloaded', 'id': ident, 'applied': False})
                return
            fence = self.epoch, self.output_epoch
            self.tts_reload_inflight = True
            completed = threading.Event()

            def expire():
                with self.lock:
                    if completed.is_set() or self.closed or self.failed:
                        return
                    completed.set()
                    self.emit({'type': 'tts_reloaded', 'id': ident, 'applied': False})

            timer = threading.Timer(30, expire)
            timer.daemon = True
            try:
                timer.start()
                threading.Thread(target=self._load_tts, args=(ident, dict(tts), fence, timer, completed),
                                 daemon=True, name='voice-tts-reload').start()
            except RuntimeError:
                completed.set()
                timer.cancel()
                self.tts_reload_inflight = False
                self.emit({'type': 'tts_reloaded', 'id': ident, 'applied': False})

    def _tts_reload_ready(self):
        return self.configured and self.ready and not self.muted and self.models is not None

    def _load_tts(self, ident, tts, fence, timer, completed):
        candidate = None
        try:
            paths = (resolve_voice(self.speech_bundle, tts['voice']) if 'voice' in tts
                     else resolve_default_voice(self.speech_bundle))
            validate_voice_assets(paths['model'], paths['config'])
            # Loading owns no inference lock; recognition and the current output can keep working.
            candidate = SpeechOutput.load(paths['model'], paths['config'], volume=tts['volume'],
                                          length_scale=tts['lengthScale'])
        except Exception:
            pass
        retired = None
        try:
            with self.lock:
                timer.cancel()
                self.tts_reload_inflight = False
                if self.closed or self.failed or completed.is_set():
                    return
                completed.set()
                applied = (candidate is not None and self._tts_reload_ready()
                           and fence == (self.epoch, self.output_epoch))
                if applied:
                    # Hold the retired session until outside the runtime lock, including its cleanup.
                    retired, self.models.output = self.models.output, candidate
                self.emit({'type': 'tts_reloaded', 'id': ident, 'applied': applied})
        except Exception as error:
            self.fail(error)
        finally:
            del retired

    def _pause_state(self):
        pause = self.input_pause
        if pause and not pause['closing']:
            self.emit({'type': 'input_pause_state', 'id': pause['id'], 'phase': pause['phase'],
                       'remainingMs': max(0, min(300000, math.ceil((pause['deadline'] - self.clock()) * 1000)))
                       if pause['phase'] == 'paused' else 0,
                       'listening': self.input_available and self.listening})

    def _pause_input(self, frame):
        seconds, ident = frame.get('seconds'), frame.get('id')
        if (type(seconds) is not int or not 1 <= seconds <= 300
                or not isinstance(ident, str) or not re.fullmatch(r'[\w-]{1,128}', ident)):
            raise ValueError('Input pause requires an ID and integer seconds from 1 to 300')
        with self.lock:
            if not self.configured:
                raise ValueError('Configure must be first')
            if ident in self.pause_requests:
                if self.pause_requests[ident] != seconds:
                    raise ValueError('Input pause ID conflict')
                self._pause_state()
                return
            if self.closed or self.muted or not self.ready or (self.input_pause and self.input_pause['phase'] == 'held'):
                return
            if len(self.pause_requests) >= 512:
                return
            self.pause_requests[ident] = seconds
            self.pause_revision += 1
            pause = {'id': ident, 'deadline': self.clock() + seconds, 'phase': 'paused',
                     'frozen': self.frozen, 'closing': True}
            self.input_pause = pause
        try:
            self._suspend(input_lost=True, strict_input=True)
        except Exception:
            self.fail(RuntimeError('Microphone closure unconfirmed; Voice stopped for privacy. Recorder cleanup will retry.'),
                      stage='input-pause-closure')
            return
        with self.lock:
            if self.input_pause is not pause:
                return
            pause['closing'] = False
            if pause['phase'] == 'paused' and self.clock() >= pause['deadline']:
                pause['phase'] = 'warming'
            self._set_listening(False)
            self._pause_state()

    def _input_blocked(self):
        pause = self.input_pause
        return pause is not None and (pause['phase'] != 'warming' or pause['frozen'] != self.frozen
                                      or (self.source, self.target) != pause['frozen'])

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
            audio = config["audio"]
            identities = tuple(audio.get(key) for key in ("inputDevice", "outputDevice"))
            if any(value is not None and (not isinstance(value, str) or not value.strip()
                   or len(value) > 1024 or any(ord(char) < 32 for char in value)) for value in identities):
                raise ValueError("Invalid physical audio device identity")
            binding = (audio["input"], audio["output"], *identities) if any(identities) else (audio["input"], audio["output"])
            try:
                source, target = graph.bind(*binding)
            except RuntimeError:
                fallback = audio.get('fallback')
                if fallback is None:
                    raise
                try:
                    fallback_binding = self._binding(fallback)
                    source, target = graph.bind(*fallback_binding)
                    binding = fallback_binding
                    self.using_fallback = True
                except RuntimeError:
                    try:
                        source, target = graph.available(*binding)
                    except RuntimeError:
                        source = target = None
            self.stage = "models"
            models = SpeechInference(stt=config["stt"]["model"], tts=config["tts"]["model"],
                                     tts_config=config["tts"]["config"], compute_type=config["stt"]["computeType"],
                                     volume=config["tts"]["volume"], length_scale=config["tts"]["lengthScale"])
            from pysilero_vad import SileroVoiceActivityDetector
            with self.lock:
                if self.closed or self.muted:
                    return
                self.config, self.graph, self.source, self.models = config, graph, source, models
                self.availability_observation = {
                    'inputPresent': source is not None, 'outputPresent': target is not None,
                    'inputChanged': False if source is not None else None,
                    'outputChanged': False if target is not None else None}
                self.vad_factory = SileroVoiceActivityDetector
                samples = models.np.arange(int(models.rate * 0.1))
                self.cue = (models.np.sin(2 * models.np.pi * 800 * samples / models.rate)
                            * models.np.hanning(len(samples)) * 1200).astype("<i2").tobytes()
                self.stage = "audio-setup"
            if source is None or target is None:
                with self.lock:
                    if self.closed or self.muted:
                        return
                    self.source, self.target = source, target
                    self.frozen = tuple(node or Node(audio[key], '', kind, audio.get(key + 'Device'))
                                        for node, key, kind in ((source, 'input', 'Audio/Source'),
                                                                (target, 'output', 'Audio/Sink')))
                    self.ready = True
                    self.emit({'type': 'ready', 'mode': 'open-mic', 'fallback': False,
                               'input': False, 'output': False, 'listening': False,
                               'speakerMode': self.speaker_mode})
                if target is not None:
                    self._resume_output(target)
                    with self.lock:
                        speaker, output_epoch = self.speaker, self.output_epoch
                    if speaker:
                        try:
                            speaker.play(self.cue, ident='ready')
                        except Exception:
                            self._suspend(output_lost=True, output_epoch=output_epoch)
                if source is not None:
                    self._resume_input(source)
                self._run_workers()
                return
            transition_started = self.clock()
            transition_deadline = transition_started + 12
            bluetooth_devices = tuple(identity for identity, node in zip(identities, (source, target))
                                      if identity and node.bluetooth)
            bluetooth = source.bluetooth or target.bluetooth
            # WirePlumber 0.5.18 restores the previous Bluetooth profile after a 2000ms delay.
            settle_until = transition_started + 2.5 if target.bluetooth else transition_started
            while not self.stopped.is_set():
                try:
                    with self.lock:
                        if self.closed or self.muted:
                            return
                    self._remaining(transition_deadline)
                    source, target = graph.bind(*binding, deadline=transition_deadline)
                    with self.lock:
                        if self.closed or self.muted:
                            return
                        self._remaining(transition_deadline)
                        self.source, self.target = source, target
                        self.frozen = (source, target)
                        self.output_epoch += 1
                        output_epoch = self.output_epoch
                        self.sink = PipeSink(graph.paths["pw-play"], target, models.rate)
                        self.speaker = self._new_speaker(self.sink, output_epoch)
                        self.epoch += 1
                        epoch = self.epoch
                        self.segments = Segments(lambda event, bound=epoch: self._segment(event, bound),
                                                 lambda: None, lambda bound=epoch: bound,
                                                 silence=config["turn"]["silenceMs"] / 1000,
                                                 maximum=config["turn"]["maxSeconds"])
                        self.gate = InputReady(HealthyInput(self.segments, self._capture_allowed))
                        self.capture = Capture(graph.paths["pw-record"], source, self.vad_factory,
                                               config["turn"]["speechThreshold"], self.gate,
                                               lambda error, bound=epoch: self._capture_fault(error, bound))
                        self.stage = "capture-start"
                        self.capture.start()
                        capture, gate = self.capture, self.gate
                    self._warmup(capture, gate, epoch, recover=bluetooth or audio.get('fallback') is not None,
                                 deadline=transition_deadline, settle_until=settle_until)
                    if self.closed or self.muted:
                        return
                    break
                except Exception:
                    with self.lock:
                        was_ready = self.ready
                        self.epoch += 1
                        if self.capture is not None or self.gate is not None or self.segments is not None:
                            self.retired_inputs.append((self.gate, self.capture, self.segments))
                        resources = self.speaker, self.sink
                        self.capture = self.gate = self.segments = self.speaker = self.sink = None
                    self._close(resources)
                    if not self._retry_input_cleanup():
                        self.fail(RuntimeError('Microphone closure unconfirmed; Voice stopped for privacy. Recorder cleanup will retry.'),
                                  stage='input-start-closure')
                        return
                    if self.closed or self.muted:
                        return
                    self._remaining(transition_deadline)
                    if not was_ready and not self.using_fallback and audio.get('fallback') is not None:
                        try:
                            fallback_binding = self._binding(audio['fallback'])
                            source, target = graph.bind(*fallback_binding, deadline=transition_deadline)
                        except RuntimeError:
                            pass
                        else:
                            with self.lock:
                                if self.closed or self.muted:
                                    return
                                self.using_fallback = True
                            binding = fallback_binding
                            bluetooth = source.bluetooth or target.bluetooth
                            settle_until = self.clock()
                            continue
                    if was_ready or not bluetooth_devices or not any(graph.profile_transition(device, deadline=transition_deadline)
                                                for device in bluetooth_devices):
                        raise
                    self.stopped.wait(min(0.1, self._remaining(transition_deadline)))
            if self.closed or self.muted:
                return
            self._run_workers()
        except Exception as error:
            self.fail(error)

    def _run_workers(self):
        for worker in (self._recognize, self._synthesize, self._health, self._watchdog):
            threading.Thread(target=worker, daemon=True).start()
        # Linux PDEATHSIG follows the spawning thread; keep it alive until owned children close.
        self.shutdown_complete.wait()

    @staticmethod
    def _binding(route):
        identities = tuple(route.get(key) for key in ('inputDevice', 'outputDevice'))
        return ((route['input'], route['output'], *identities) if any(identities)
                else (route['input'], route['output']))

    def _try_fallback(self):
        with self.lock:
            if self.closed or self.muted or not self.ready or self.using_fallback or self.input_pause:
                return False
            route = self.config['audio'].get('fallback')
            if route is None:
                return False
            epoch, output_epoch = self.epoch, self.output_epoch
        try:
            source, target = self.graph.bind(*self._binding(route))
        except Exception:
            return False
        with self.lock:
            if (self.closed or self.muted or self.using_fallback or self.input_pause or self.epoch != epoch
                    or self.output_epoch != output_epoch):
                return False
            changed_input = source != self.source or not self.input_available
        self._suspend(input_lost=changed_input, output_lost=True, epoch=epoch, output_epoch=output_epoch)
        with self.lock:
            if self.closed or self.muted or self.input_pause:
                return False
            self.using_fallback = True
            self.frozen = (source, target)
            self.availability_observation = {
                'inputPresent': True, 'outputPresent': True,
                'inputChanged': False, 'outputChanged': False}
            self._availability()
        try:
            self._resume_output(target)
        except Exception:
            self._suspend(output_lost=True)
        if not self.input_available:
            try:
                self._resume_input(source)
                self._arm_recovered_input(source)
            except Exception:
                self._suspend(input_lost=True)
        return True

    @property
    def speaker_mode(self):
        return self.using_fallback or getattr(self, 'config', {}).get('audio', {}).get('speakerMode', False)

    def _set_listening(self, listening):
        if self.listening != listening:
            self.listening = listening
            if self.ready and self.input_available:
                self.emit({'type': 'capture_state', 'listening': listening})

    def _capture_allowed(self, pcm, voiced, captured_at):
        with self.lock:
            if self.closed or self.muted or self._input_blocked():
                return False
            if not self.speaker_mode:
                return True
            now = self.clock()
            captured = now if captured_at is None else captured_at
            if self.owned_playback or captured <= self.acoustic_until:
                self.guard_quiet = None
                allowed = False
            elif not self.listening:
                if voiced:
                    self.guard_voiced = True
                    self.guard_quiet = None
                elif self.guard_quiet is None:
                    self.guard_quiet = captured
                if (not voiced and self.guard_quiet is not None
                        and captured - self.guard_quiet >= self.config['turn']['silenceMs'] / 1000):
                    self.guard_voiced = False
                    self.acoustic_until = max(self.acoustic_until, captured)
                    self._set_listening(True)
                allowed = self.listening
            else:
                allowed = True
            segments = self.segments
            if not allowed:
                self._drop_pending_capture()
        if not allowed and segments:
            segments.discard()
        return allowed

    def _drop_pending_capture(self):
        self.input_active = False
        for ident in self.pending:
            self.emit({'type': 'cancelled', 'id': ident, 'reason': 'capture_paused'})
        self.pending.clear()
        while True:
            try:
                self.jobs.get_nowait().clear()
            except queue.Empty:
                break

    def _capture_diagnostic(self, error, capture, epoch):
        with self.lock:
            if self.closed or self.muted or self.epoch != epoch or self.capture is not capture:
                return
            reason = error.reason if isinstance(error, CaptureFault) else 'capture_health_failed'
            self._availability_diagnostic(reason, capture)

    def _capture_fault(self, error, epoch):
        with self.lock:
            if self.closed or self.muted or self.epoch != epoch:
                return
            self._capture_diagnostic(error, self.capture, epoch)
            if not self.ready:
                if self.capture:
                    self.capture.fault_reason = error.reason if isinstance(error, CaptureFault) else 'capture_health_failed'
                    self.capture.fault = str(error)
                return
        self._suspend(input_lost=True, epoch=epoch)

    def _remaining(self, deadline):
        remaining = deadline - self.clock()
        if remaining <= 0:
            raise TimeoutError('Audio route transition deadline expired')
        return remaining

    def _warmup(self, capture, gate, epoch, recover=False, deadline=None, settle_until=0):
        deadline = min(self.clock() + 5, deadline) if deadline is not None else self.clock() + 5
        next_graph = 0
        self.stage = "warmup"
        self.emit({"type": "warming"})
        try:
            capture.wait_ready(timeout=min(3, self._remaining(deadline)))
            while self.clock() < deadline:
                with self.lock:
                    if self.closed or self.muted or self._input_blocked() or self.epoch != epoch:
                        return
                capture.health()
                if recover and self.clock() >= next_graph:
                    self.graph.check(deadline=deadline)
                    next_graph = self.clock() + 0.2
                self._remaining(deadline)
                if not gate.ready.wait(min(0.02, self._remaining(deadline))) or self.clock() < settle_until:
                    continue
                if recover:
                    self.graph.check(deadline=deadline)
                with self.lock:
                    if self.closed or self.muted or self._input_blocked() or self.epoch != epoch:
                        return
                    self._remaining(deadline)
                    summary = gate.arm()
                    if summary is not None:
                        self.ready = True
                        self.input_available = self.output_available = True
                        self.stage = "listening"
                        if self.speaker_mode:
                            self.owned_playback = True
                            self.owned_playback_token = (None, 'ready')
                            self._set_listening(False)
                        self.emit({"type": "ready", "mode": "open-mic", "warmup": summary,
                                   "fallback": self.using_fallback, "listening": self.listening,
                                   "speakerMode": self.speaker_mode})
                        speaker, output_epoch = self.speaker, self.output_epoch
                if summary is not None:
                    try:
                        speaker.play(self.cue, ident="ready")
                    except Exception:
                        self._suspend(output_lost=True, output_epoch=output_epoch)
                    return
            self.emit({"type": "diagnostic", "stage": "warmup", "details": gate.snapshot()})
            raise CaptureFault('input_warmup_timeout', "Input did not settle within five seconds")
        except Exception as error:
            with self.lock:
                obsolete = self.closed or self.muted or self.epoch != epoch
            if not obsolete:
                diagnostic_error = CaptureFault('input_warmup_timeout', '') if isinstance(error, TimeoutError) else error
                self._capture_diagnostic(diagnostic_error, capture, epoch)
                if recover:
                    raise
                self.fail(error)

    def _interrupt(self, epoch):
        with self.lock:
            if (self.closed or self.muted or self._input_blocked() or self.epoch != epoch
                    or (self.speaker_mode and not self.listening)):
                return []
            # Only this revision's live jobs can be cancelled by this onset. Once a
            # job crosses into current_playback we cannot prove no output occurred.
            with self.speeches.mutex:
                queued = tuple(self.speeches.queue)
            playback_id = self.current_playback[0] if self.current_playback else None
            pre_output_ids = list(dict.fromkeys(
                job['id'] for job in (self.active_speech, *queued)
                if job and not job.get('ended') and job['id'] != playback_id and self._speech_current(job)
            ))
            self.input_active = True
            self.revision += 1
            speaker, output_epoch = self.speaker, self.output_epoch
            if self.current_playback:
                self.emit({'type': 'speech_end', 'id': self.current_playback[0], 'completed': False})
                self.current_playback[1].set()
                self.current_playback = None
        if speaker:
            try:
                speaker.cancel()
            except Exception:
                self._suspend(output_lost=True, output_epoch=output_epoch)
        return pre_output_ids

    def _segment(self, event, epoch):
        try:
            ident = f"e{epoch}-t{event['id']}"
            with self.lock:
                if (self.closed or self.muted or self._input_blocked() or not self.ready
                        or not self.input_available or self.epoch != epoch
                        or (self.speaker_mode and not self.listening)):
                    return False
                if event["type"] == "onset":
                    # Admission can race playback; fence the onset before interrupting output.
                    if self.speaker_mode and event.get('at', self.clock()) <= self.acoustic_until:
                        return False
                    pre_output_ids = self._interrupt(epoch)
                    if len(self.pending) >= 4:
                        raise RuntimeError("Too many pending utterances")
                    self.pending.add(ident)
                    addressed = {"type": "addressed", "id": ident}
                    if pre_output_ids:
                        addressed["preOutputSpeechIds"] = pre_output_ids
                    self.emit(addressed)
                elif event["type"] == "truncated":
                    self.emit({"type": "limit", "id": ident})
                elif event["type"] == "endpoint":
                    if ident not in self.pending:
                        return
                    self.input_active = False
                    if not event["pcm"]:
                        self.pending.discard(ident)
                        self.emit({"type": "cancelled", "id": ident, "reason": "empty"})
                    else:
                        self.jobs.put_nowait({"id": ident, "epoch": epoch, "pcm": event["pcm"],
                                             "truncated": event["truncated"],
                                             "speech_seconds": event.get("speech_seconds", len(event["pcm"]) / 32000)})
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
                with self.model_lock:
                    with self.lock:
                        if self.closed or self.muted or job["epoch"] != self.epoch:
                            continue
                        seconds = min(120, len(job["pcm"]) / 32000)
                        self.busy["recognition"] = (self.clock(), max(10, 2 * seconds))
                    try:
                        transcription = self.models.transcribe(job.pop("pcm"),
                                                               speech_seconds=job["speech_seconds"])
                        text = transcription.text
                    finally:
                        self.busy["recognition"] = None
                if not isinstance(text, str) or len(text) > 16384:
                    raise RuntimeError("Recognition output exceeded the text bound")
                with self.lock:
                    if (self.closed or self.muted or job["epoch"] != self.epoch
                            or job['id'] not in self.pending):
                        continue
                    self.pending.discard(job["id"])
                    if transcription.rejected_reason:
                        self.emit({"type": "cancelled", "id": job["id"], "reason": "unreliable_speech"})
                    else:
                        self.emit({"type": "review" if job["truncated"] else "utterance",
                                   "id": job["id"], "text": text} if text.strip()
                                  else {"type": "cancelled", "id": job["id"], "reason": "empty"})
            except Exception as error:
                with self.lock:
                    obsolete = self.closed or self.muted or job.get('epoch') != self.epoch
                if not obsolete:
                    self.fail(error)
            finally:
                self.busy["recognition"] = None
                job.clear()

    def _can_speak(self, revision=None):
        return (not self.closed and self.ready and self.output_available and not self.muted and not self.pending
                and not self.input_active and (revision is None or revision == self.revision))

    def _speech_current(self, job):
        return self._can_speak(job["revision"]) and (not job.get("key") or self.keys.get(job["key"]) == job["id"])

    def _synthesize(self):
        while not self.stopped.is_set():
            job = None
            played = False
            playback_fault = None
            try:
                with self.speech_available:
                    self.speech_available.wait_for(lambda: self.stopped.is_set() or not self.speeches.empty())
                    if self.stopped.is_set():
                        return
                    # Transfer ownership under the same lock that captures onset proof.
                    job = self.speeches.get_nowait()
                    if not self._speech_current(job):
                        continue
                    self.active_speech = job
                with self.model_lock:
                    with self.lock:
                        if not self._speech_current(job):
                            continue
                        output = self.models.output
                        self.busy["synthesis"] = (self.clock(), 10)
                    try:
                        rate, pcm = output.rate, output.synthesize(job["text"])
                    finally:
                        del output
                        self.busy["synthesis"] = None
                with self.lock:
                    if self.active_speech is job:
                        self.active_speech = None
                    if self._speech_current(job):
                        done = threading.Event()
                        self.current_playback = (job["id"], done)
                        try:
                            self.speaker.play(pcm, ident=job["id"], rate=rate)
                            played = True
                            self.emit({"type": "speech_start", "id": job["id"]})
                        except Exception:
                            playback_fault = self.output_epoch
                if playback_fault is not None:
                    self._suspend(output_lost=True, output_epoch=playback_fault)
                    played = True
                self.busy["synthesis"] = None
                if played:
                    while not self.stopped.is_set() and not done.wait(0.1):
                        pass
            except Exception as error:
                self.fail(error)
            finally:
                self.busy["synthesis"] = None
                if job is not None:
                    with self.lock:
                        if self.active_speech is job:
                            self.active_speech = None
                        if not played and not self.closed and not job.get('ended'):
                            self.emit({"type": "speech_end", "id": job["id"], "completed": False})
                        job.clear()

    def _new_speaker(self, sink, epoch):
        callback = lambda event: self._speaker_event(event, epoch)
        speaker = Speaker(sink, callback)
        speaker.activity = callback
        return speaker

    def _speaker_event(self, event, output_epoch=None):
        with self.lock:
            if self.closed or self.muted or (output_epoch is not None and output_epoch != self.output_epoch):
                return
            if (event['type'] in ('playing', 'idle') and isinstance(event.get('id'), str)
                    and isinstance(event.get('generation'), int)):
                self.emit({'type': 'playback_state', 'id': event['id'],
                           'playbackGeneration': event['generation'], 'outputEpoch': self.output_epoch,
                           'playing': event['type'] == 'playing'})
            if event['type'] == 'playing':
                if self.speaker_mode:
                    self.owned_playback = True
                    self.owned_playback_token = (event.get('generation'), event.get('id'))
                    self.guard_quiet = None
                    self.guard_voiced = False
                    self._set_listening(False)
                    self._drop_pending_capture()
                return
            if event['type'] == 'idle':
                token = (event.get('generation'), event.get('id'))
                if self.speaker_mode and token == self.owned_playback_token:
                    self.owned_playback = False
                    self.owned_playback_token = None
                    self.acoustic_until = max(self.acoustic_until, self.clock() + 0.5)
                    self.guard_quiet = None
                return
            if event['type'] == 'played':
                current = self.current_playback
                if current and current[0] == event['id']:
                    self.emit({'type': 'speech_end', 'id': event['id'], 'completed': True})
                    current[1].set()
                    self.current_playback = None
                return
            if event['type'] != 'fault':
                return
            initial = not self.ready
            bound = self.output_epoch
        if initial:
            self.fail(RuntimeError(event.get('message') or 'Playback failed'), stage='playback')
        else:
            self._suspend(output_lost=True, output_epoch=bound)

    def _silence(self):
        with self.lock:
            self.revision += 1
            speaker, output_epoch = self.speaker, self.output_epoch
            if self.current_playback:
                self.emit({'type': 'speech_end', 'id': self.current_playback[0], 'completed': False})
                self.current_playback[1].set()
                self.current_playback = None
            while True:
                try:
                    job = self.speeches.get_nowait()
                except queue.Empty:
                    break
                self.emit({"type": "speech_end", "id": job["id"], "completed": False})
                job.clear()
        if speaker:
            try:
                speaker.cancel()
            except Exception:
                self._suspend(output_lost=True, output_epoch=output_epoch)

    def _mute(self):
        with self.lock:
            self.muted = True
            self.input_pause = None
            self.pause_revision += 1
            self.ready = False
            self.input_available = self.output_available = False
            self.epoch += 1
            self.pending.clear()
            gate, capture = self.gate, self.capture
            self.gate = self.capture = None
        self._silence()
        self._close((gate, capture))

    def _availability_diagnostic(self, reason, capture=None, recovered=False):
        with self.lock:
            if recovered:
                self.recovery_count = min(2147483647, self.recovery_count + 1)
            age = None
            try:
                last_pcm = getattr(capture, 'last_pcm', None)
                if type(last_pcm) in (int, float) and math.isfinite(last_pcm):
                    elapsed = self.clock() - last_pcm
                    if math.isfinite(elapsed):
                        age = int(min(60, max(0, elapsed)) * 1000)
            except Exception:
                pass
            try:
                self.emit({'type': 'availability_diagnostic', 'v': 1, 'reason': reason,
                           **self.availability_observation, 'pcmAgeMs': age,
                           'recoveryCount': self.recovery_count})
            except Exception:
                pass

    def _availability(self):
        self.emit({'type': 'availability', 'input': self.input_available,
                   'output': self.output_available, 'fallback': self.using_fallback,
                   'listening': self.input_available and self.listening,
                   'speakerMode': self.speaker_mode})

    def _suspend(self, input_lost=False, output_lost=False, epoch=None, output_epoch=None, strict_input=False):
        resources = []
        retired = None
        guard_epoch = None
        held_pause = None
        with self.lock:
            if self.closed or self.muted or not self.ready:
                return
            before = self.input_available, self.output_available
            if input_lost and (epoch is None or epoch == self.epoch):
                strict_input = strict_input or self.input_pause is not None
                if self.input_pause and self.input_pause['phase'] == 'warming':
                    self.input_pause['phase'] = 'held'
                    held_pause = self.input_pause
                    self.pause_revision += 1
                if self.capture is not None or self.input_available:
                    self.epoch += 1
                    self.input_available = self.input_active = False
                    detached = (self.gate, self.capture, self.segments)
                    if strict_input:
                        retired = detached
                        self.retired_inputs.append(retired)
                    else:
                        resources.extend(detached)
                    self.gate = self.capture = self.segments = None
                    for ident in self.pending:
                        self.emit({'type': 'cancelled', 'id': ident, 'reason': 'input_disconnected'})
                    self.pending.clear()
                    while True:
                        try:
                            self.jobs.get_nowait().clear()
                        except queue.Empty:
                            break
            if output_lost and (output_epoch is None or output_epoch == self.output_epoch):
                if self.speaker is not None or self.sink is not None or self.output_available:
                    self.output_epoch += 1
                    self.output_available = False
                    if self.speaker_mode and self.owned_playback:
                        guard_epoch = self.output_epoch
                    self.revision += 1
                    resources.extend((self.speaker, self.sink))
                    self.speaker = self.sink = None
                    if self.active_speech and not self.active_speech.get('ended'):
                        self.emit({'type': 'speech_end', 'id': self.active_speech['id'], 'completed': False})
                        self.active_speech['ended'] = True
                    if self.current_playback:
                        self.emit({'type': 'speech_end', 'id': self.current_playback[0], 'completed': False})
                        self.current_playback[1].set()
                        self.current_playback = None
                    while True:
                        try:
                            job = self.speeches.get_nowait()
                        except queue.Empty:
                            break
                        self.emit({'type': 'speech_end', 'id': job['id'], 'completed': False})
                        job.clear()
            if before != (self.input_available, self.output_available):
                self._availability()
        self._close(resources)
        if retired is not None and not self._retry_input_cleanup():
            self.fail(RuntimeError('Microphone closure unconfirmed; Voice stopped for privacy. Recorder cleanup will retry.'),
                      stage='input-pause-closure')
            return
        if held_pause is not None:
            with self.lock:
                if self.input_pause is held_pause:
                    self._pause_state()
        if guard_epoch is not None:
            with self.lock:
                if self.output_epoch == guard_epoch:
                    self.owned_playback = False
                    self.owned_playback_token = None
                    self.acoustic_until = max(self.acoustic_until, self.clock() + 0.5)
                    self.guard_quiet = None

    def _resume_output(self, target):
        sink = PipeSink(self.graph.paths['pw-play'], target, self.models.rate)
        with self.lock:
            if self.closed or self.muted or self.output_available:
                obsolete = True
            else:
                obsolete = False
                self.output_epoch += 1
                bound = self.output_epoch
                self.sink = sink
                self.speaker = self._new_speaker(sink, bound)
                self.target = target
                self.output_available = True
                self._availability()
                self._availability_diagnostic('output_recovered', recovered=True)
        if obsolete:
            self._close((sink,))

    def _resume_input(self, source):
        with self.lock:
            if self.closed or self.muted or self._input_blocked() or self.input_available or self.capture is not None:
                return
            self.epoch += 1
            epoch, pause_revision = self.epoch, self.pause_revision
            self.guard_voiced = False
            self.guard_quiet = None
            if not self.speaker_mode and not self.owned_playback and self.clock() > self.acoustic_until:
                self._set_listening(True)
        segments = Segments(lambda event: self._segment(event, epoch),
                            lambda: None, lambda: epoch,
                            silence=self.config['turn']['silenceMs'] / 1000,
                            maximum=self.config['turn']['maxSeconds'])
        gate = InputReady(HealthyInput(segments, self._capture_allowed))
        capture = Capture(self.graph.paths['pw-record'], source, self.vad_factory,
                          self.config['turn']['speechThreshold'], gate,
                          lambda error: self._capture_fault(error, epoch))
        with self.lock:
            obsolete = (self.closed or self.muted or self._input_blocked() or self.epoch != epoch
                        or self.pause_revision != pause_revision)
            if not obsolete:
                self.source = source
                self.segments, self.gate, self.capture = segments, gate, capture
        if obsolete:
            self._close((gate, capture, segments))
            return
        try:
            with self.lock:
                if (self.closed or self.muted or self._input_blocked() or self.epoch != epoch
                        or self.pause_revision != pause_revision):
                    return
                self.input_deadline = self.clock() + 5
                capture.start()
            self.emit({'type': 'warming'})
        except Exception as error:
            self._capture_diagnostic(error, capture, epoch)
            self._suspend(input_lost=True, epoch=epoch, strict_input=True)

    def _arm_recovered_input(self, source):
        with self.lock:
            capture, epoch = self.capture, self.epoch
        if capture is None:
            return
        try:
            capture.health()
        except Exception as error:
            self._capture_diagnostic(error, capture, epoch)
            self._suspend(input_lost=True, epoch=epoch)
            return
        with self.lock:
            if (self.closed or self.muted or self._input_blocked() or self.input_available or self.capture is not capture
                    or self.epoch != epoch or self.source != source or self.clock() >= self.input_deadline
                    or not self.gate.ready.is_set()):
                return
            if self.gate.arm() is None:
                return
            self.input_available = True
            self.stage = 'listening'
            self._availability()
            self._availability_diagnostic('input_recovered', capture, recovered=True)
            if self.input_pause:
                self.input_pause['phase'] = 'resumed'
                self._pause_state()
                self.input_pause = None

    def _health_tick(self, next_graph=0):
        with self.lock:
            if self.closed or self.muted:
                return next_graph
            epoch, pause_revision = self.epoch, self.pause_revision
            frozen = self.frozen
        if self.clock() >= next_graph:
            graph_failed = False
            try:
                source, target = self.graph.recover(frozen)
            except Exception:
                source = target = None
                graph_failed = True
            with self.lock:
                if self.closed or self.muted or self.epoch != epoch or self.pause_revision != pause_revision:
                    return next_graph
                input_lost = source is None or source != self.source
                output_lost = target is None or target != self.target
                if graph_failed:
                    self.availability_observation = dict.fromkeys(self.availability_observation)
                    self._availability_diagnostic('graph_query_failed', self.capture)
                else:
                    self.availability_observation = {
                        'inputPresent': source is not None, 'outputPresent': target is not None,
                        'inputChanged': source != self.source if source is not None and self.source is not None else None,
                        'outputChanged': target != self.target if target is not None and self.target is not None else None}
                    if source is None:
                        self._availability_diagnostic('source_unresolved', self.capture)
                    elif self.availability_observation['inputChanged']:
                        self._availability_diagnostic('source_changed', self.capture)
                    if target is None:
                        self._availability_diagnostic('target_unresolved', self.capture)
                    elif self.availability_observation['outputChanged']:
                        self._availability_diagnostic('target_changed', self.capture)
                pause = self.input_pause
                hold = False
                if pause:
                    if (source, target) != pause['frozen']:
                        pause['phase'] = 'held'
                        hold = True
                    elif pause['phase'] == 'paused' and not pause['closing'] and self.clock() >= pause['deadline']:
                        pause['phase'] = 'warming'
                else:
                    self.frozen = tuple(actual if not expected.serial and actual is not None else expected
                                        for expected, actual in zip(frozen, (source, target)))
            self._suspend(input_lost=input_lost or hold, output_lost=output_lost)
            with self.lock:
                if pause is not None and self.input_pause is pause:
                    self._pause_state()
            if input_lost or output_lost or not self.input_available or not self.output_available:
                if self._try_fallback():
                    return self.clock() + 1
            if target is not None and not self.output_available:
                try:
                    self._resume_output(target)
                except Exception:
                    self._suspend(output_lost=True)
            if source is not None and not self.input_available:
                try:
                    had_capture = self.capture is not None
                    self._resume_input(source)
                    if had_capture or not self.input_pause:
                        self._arm_recovered_input(source)
                except Exception:
                    self._suspend(input_lost=True)
            next_graph = self.clock() + 1
        with self.lock:
            capture, epoch = self.capture, self.epoch
            sink, output_epoch = self.sink, self.output_epoch
        if sink:
            try:
                sink.health()
            except Exception:
                with self.lock:
                    if (not self.closed and not self.muted and self.sink is sink
                            and self.output_epoch == output_epoch):
                        self._availability_diagnostic('output_health_failed', self.capture)
                self._suspend(output_lost=True, output_epoch=output_epoch)
        if capture:
            try:
                capture.health()
                with self.lock:
                    expired = not self.input_available and self.clock() >= self.input_deadline
                if expired:
                    self._capture_diagnostic(CaptureFault('input_warmup_timeout', ''), capture, epoch)
                    self._suspend(input_lost=True, epoch=epoch)
            except Exception as error:
                self._capture_diagnostic(error, capture, epoch)
                self._suspend(input_lost=True, epoch=epoch)
        return next_graph

    def _health(self):
        next_graph = 0
        try:
            while not self.stopped.wait(0.1):
                next_graph = self._health_tick(next_graph)
        except Exception as error:
            self.fail(error)
        finally:
            # Recovery recorders inherit this creating thread's Linux PDEATHSIG lifetime.
            while not self.shutdown_complete.wait(0.1):
                if self.closed and self._retry_input_cleanup():
                    self.shutdown_complete.set()

    def _watchdog(self):
        while not self.stopped.wait(0.1):
            for active in self.busy.values():
                if active is not None and self.clock() - active[0] > active[1]:
                    self.fail(RuntimeError('Local inference exceeded its active computation budget'))
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

    def _retry_input_cleanup(self):
        with self.input_cleanup_lock:
            with self.lock:
                retired = list(self.retired_inputs)
            for resources in retired:
                confirmed = True
                for resource in resources:
                    if resource is not None:
                        try:
                            resource.close()
                        except Exception:
                            confirmed = False
                capture = resources[1]
                if capture is not None:
                    try:
                        child = getattr(capture, 'child', None)
                        if child is not None and child.process.poll() is None:
                            confirmed = False
                    except Exception:
                        confirmed = False
                if confirmed:
                    with self.lock:
                        self.retired_inputs.remove(resources)
            with self.lock:
                return not self.retired_inputs

    @staticmethod
    def _close(resources):
        for resource in resources:
            if resource is not None:
                try:
                    resource.close()
                except Exception:
                    pass

    def shutdown(self):
        resources = ()
        with self.lock:
            if not self.closed:
                self.closed = True
                self.input_pause = None
                self.pause_revision += 1
                self.ready = False
                self.input_available = self.output_available = False
                self.output_epoch += 1
                self.epoch += 1
                self.revision += 1
                self.stopped.set()
                self.speech_available.notify_all()
                self.pending.clear()
                if self.current_playback:
                    self.current_playback[1].set()
                if self.capture is not None or self.gate is not None or self.segments is not None:
                    self.retired_inputs.append((self.gate, self.capture, self.segments))
                resources = self.speaker, self.sink
                self.gate = self.capture = self.segments = self.speaker = self.sink = None
        self._close(resources)
        confirmed = self._retry_input_cleanup()
        for inbox in (self.jobs, self.speeches):
            while True:
                try:
                    inbox.get_nowait().clear()
                except queue.Empty:
                    break
        if confirmed:
            self.shutdown_complete.set()
