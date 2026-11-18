import array
import contextlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

from paj_voice_audio import open_mic
from paj_voice_audio.devices import Child, Node


class Vector:
    def __len__(self):
        return 1600

    def __mul__(self, value):
        return self

    __rmul__ = __mul__
    __truediv__ = __mul__

    def astype(self, value):
        return self

    def tobytes(self):
        return b"\0\0" * 1600


def wait_for(predicate):
    deadline = time.monotonic() + 4
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("Timed out waiting for fake runtime")
        time.sleep(0.005)


class OpenMicTests(unittest.TestCase):
    def fixture(self, hold_load=False, capture_process=False, bluetooth=False, transition=False, prepare=None):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        events, captures, played = [], [], []
        executable = root / 'dummy-recorder'
        executable.write_text(f'#!{sys.executable}\nimport time\nprint("READY", flush=True)\ntime.sleep(30)\n')
        executable.chmod(0o700)
        load_entered, release_load = threading.Event(), threading.Event()
        config = {"cacheDir": str(root / "cache"), "stt": {"model": "/fake/stt", "computeType": "int8"},
                  "tts": {"model": "/fake/voice", "config": "/fake/voice.json", "volume": 0.4, "lengthScale": 1},
                  "audio": {"input": "laptop", "output": "headphones"},
                  "turn": {"silenceMs": 800, "maxSeconds": 120, "speechThreshold": 0.001}}
        graph = types.SimpleNamespace(paths={"pw-record": "FAKE", "pw-play": "FAKE"},
                                      bind=lambda *args, **kwargs: (Node('laptop', '1', 'Audio/Source', bluetooth=bluetooth),
                                                                    Node('headphones', '2', 'Audio/Sink', bluetooth=bluetooth)),
                                      check=Mock(), profile_transition=Mock(return_value=transition))
        graph.recover = Mock(side_effect=lambda frozen: frozen)
        if bluetooth:
            config['audio'].update(input='bluez_input.old', output='bluez_output.old',
                                   inputDevice='bluez_card.chosen', outputDevice='bluez_card.chosen')
        if transition:
            checks = iter([True])
            def check(**kwargs):
                if next(checks, False):
                    raise RuntimeError('Expected same-device profile replacement')
            graph.check.side_effect = check
        models = types.SimpleNamespace(rate=16000, transcribe=Mock(return_value=("a request", 1)),
                                       synthesize=Mock(return_value=b"\0\0" * 1600),
                                       np=types.SimpleNamespace(arange=lambda size: Vector(), sin=lambda value: Vector(),
                                                                hanning=lambda size: Vector(), pi=3.14))

        def load(**kwargs):
            load_entered.set()
            if hold_load:
                release_load.wait(2)
            return models

        class Capture:
            def __init__(self, executable, node, vad, threshold, receiver, fail):
                self.receiver, self.closed = receiver, False
                self.fail = fail
                self.child = None
                captures.append(self)

            def start(self):
                if capture_process:
                    self.child = Child(str(executable), Node('dummy', '999', 'Audio/Source'), 16000, True)
                    if self.child.process.stdout.readline() != b'READY\n':
                        raise RuntimeError('Dummy child did not reach its lifetime guard')
                for _ in range(3):
                    self.receiver.feed(b"\0\0" * 4000, False)

            def wait_ready(self, timeout=3):
                pass

            def health(self):
                pass

            def close(self):
                self.closed = True
                if self.child:
                    self.child.stop()

        class Sink:
            def __init__(self, *args):
                self.closed = False

            def health(self):
                pass

            def close(self):
                self.closed = True

        class Speaker:
            def __init__(self, sink, emit):
                self.paused = self.closed = False

            def play(self, pcm, ident=None):
                if self.closed:
                    raise AssertionError("Playback after close")
                played.append(ident)

            def cancel(self):
                self.paused = True

            def close(self):
                self.closed = True

        for name, replacement in (("validate", lambda value: config), ("Graph", lambda: graph),
                                  ("SpeechInference", load), ("Capture", Capture),
                                  ("PipeSink", Sink), ("Speaker", Speaker)):
            stack.enter_context(patch.object(open_mic, name, replacement))
        stack.enter_context(patch.dict(sys.modules, {"pysilero_vad":
                            types.SimpleNamespace(SileroVoiceActivityDetector=object)}))
        if prepare:
            prepare(config, graph, models)
        runtime = open_mic.Runtime(events.append)
        self.addCleanup(runtime.shutdown)
        self.addCleanup(release_load.set)
        runtime.command({"type": "configure", "config": {}})
        self.assertTrue(load_entered.wait(1))
        if not hold_load:
            wait_for(lambda: runtime.ready and ("ready" in played or runtime.target is None))
        return runtime, events, captures, played, models, graph, release_load

    def utterance(self, runtime, ident, pcm=b"\0\0" * 512):
        runtime._interrupt(runtime.epoch)
        runtime._segment({"type": "onset", "id": ident}, runtime.epoch)
        runtime._segment({"type": "endpoint", "id": ident, "pcm": pcm, "truncated": False}, runtime.epoch)

    def feed_speech(self, runtime, seconds):
        now = [0]
        runtime.segments.clock = lambda: now[0]
        for _ in range(seconds * 10):
            now[0] += 0.1
            runtime.segments.feed(b"\0\0" * 1600, True)
        return now

    def test_long_normal_speech_is_one_complete_actionable_utterance(self):
        for seconds in (25, 45, 120):
            with self.subTest(seconds=seconds):
                runtime, events, _, _, models, *_ = self.fixture()
                now = self.feed_speech(runtime, seconds)
                models.transcribe.assert_not_called()
                self.assertFalse(any(event["type"] == "limit" for event in events))
                now[0] += 0.9
                runtime.segments.feed(b"\0\0" * 1600, False)
                wait_for(lambda: any(event["type"] == "utterance" for event in events))
                models.transcribe.assert_called_once()
                self.assertEqual(len(models.transcribe.call_args.args[0]), (seconds * 10 + 1) * 3200)
                self.assertEqual(sum(event["type"] == "utterance" for event in events), 1)
                runtime.shutdown()

    def test_limit_is_immediate_and_prefix_is_review_only_at_physical_endpoint(self):
        runtime, events, _, _, models, *_ = self.fixture()
        now = self.feed_speech(runtime, 130)
        limits = [event for event in events if event["type"] == "limit"]
        self.assertEqual(len(limits), 1)
        models.transcribe.assert_not_called()
        retained = bytes(runtime.segments.current["pcm"])
        self.assertTrue(retained)
        self.assertLessEqual(len(retained), 121 * 32000)
        now[0] += 0.9
        runtime.segments.feed(b"\0\0" * 1600, False)
        wait_for(lambda: any(event["type"] == "review" for event in events))
        models.transcribe.assert_called_once_with(retained)
        self.assertFalse(any(event["type"] == "utterance" for event in events))
        self.assertEqual(next(event for event in events if event["type"] == "review"),
                         {"type": "review", "id": limits[0]["id"], "text": "a request"})
        self.assertFalse(runtime.pending)

    def test_truncated_empty_transcript_is_cancelled_empty(self):
        runtime, events, _, _, models, *_ = self.fixture()
        models.transcribe.return_value = ("  ", 1)
        runtime._segment({"type": "onset", "id": 1}, runtime.epoch)
        runtime._segment({"type": "truncated", "id": 1}, runtime.epoch)
        runtime._segment({"type": "endpoint", "id": 1, "pcm": b"\0\0", "truncated": True}, runtime.epoch)
        wait_for(lambda: any(event["type"] == "cancelled" for event in events))
        self.assertEqual(next(event["reason"] for event in events if event["type"] == "cancelled"), "empty")
        self.assertFalse(any(event["type"] in ("review", "utterance") for event in events))

    def test_mute_and_shutdown_fence_inflight_review(self):
        for action in ("mute", "shutdown"):
            with self.subTest(action=action):
                runtime, events, _, _, models, *_ = self.fixture()
                entered, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                def transcribe(pcm):
                    entered.set()
                    release.wait(2)
                    return "do not submit", 1
                models.transcribe.side_effect = transcribe
                epoch = runtime.epoch
                runtime._segment({"type": "onset", "id": 1}, epoch)
                runtime._segment({"type": "endpoint", "id": 1, "pcm": b"\0\0", "truncated": True}, epoch)
                self.assertTrue(entered.wait(1))
                runtime.command({"type": action, "muted": True})
                runtime._segment({"type": "truncated", "id": 1}, epoch)
                release.set()
                wait_for(lambda: runtime.busy["recognition"] is None)
                self.assertFalse(any(event["type"] in ("review", "utterance", "limit") for event in events))
                self.assertFalse(runtime.pending)

    def test_model_lock_wait_does_not_count_toward_either_watchdog(self):
        for kind in ("recognition", "synthesis"):
            with self.subTest(kind=kind):
                runtime, events, _, _, models, *_ = self.fixture()
                now = [time.monotonic()]
                runtime.clock = lambda: now[0]
                entered, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                def compute(value):
                    entered.set()
                    release.wait(2)
                    return ("result", 1) if kind == "recognition" else b"\0\0"
                model = models.transcribe if kind == "recognition" else models.synthesize
                model.side_effect = compute
                with runtime.model_lock:
                    if kind == "recognition":
                        self.utterance(runtime, 1)
                        wait_for(runtime.jobs.empty)
                    else:
                        runtime.command({"type": "speak", "id": "wait", "text": "Wait safely."})
                        wait_for(runtime.speeches.empty)
                    now[0] += 30
                    time.sleep(0.15)
                    self.assertIsNone(runtime.busy[kind])
                    self.assertFalse(runtime.closed)
                    model.assert_not_called()
                self.assertTrue(entered.wait(1))
                self.assertEqual(runtime.busy[kind], (now[0], 10))
                now[0] += 11
                wait_for(lambda: runtime.closed)
                self.assertTrue(any(event["type"] == "error" and "budget" in event["message"]
                                    for event in events))
                release.set()

    def test_long_recognition_budget_scales_with_audio_and_still_times_out(self):
        for seconds, budget in ((30, 60), (121, 240)):
            with self.subTest(seconds=seconds):
                runtime, events, _, _, models, *_ = self.fixture()
                now = [time.monotonic()]
                runtime.clock = lambda: now[0]
                entered, release = threading.Event(), threading.Event()
                self.addCleanup(release.set)
                def transcribe(pcm):
                    entered.set()
                    release.wait(2)
                    return "too late", 1
                models.transcribe.side_effect = transcribe
                self.utterance(runtime, 1, b"\0\0" * (16000 * seconds))
                self.assertTrue(entered.wait(1))
                self.assertEqual(runtime.busy["recognition"], (now[0], budget))
                now[0] += 11
                time.sleep(0.15)
                self.assertFalse(runtime.closed)
                now[0] += budget
                wait_for(lambda: runtime.closed)
                release.set()
                self.assertTrue(any(event["type"] == "error" for event in events))
                self.assertFalse(any(event["type"] in ("utterance", "review") for event in events))

    def test_empty_pcm_is_cancelled_without_recognition(self):
        runtime, events, _, _, models, *_ = self.fixture()
        self.utterance(runtime, 1, b"")
        models.transcribe.assert_not_called()
        self.assertEqual(next(event["reason"] for event in events if event["type"] == "cancelled"), "empty")
        self.assertFalse(runtime.pending)

    def test_real_recognition_and_synthesis_errors_remain_fatal(self):
        for kind in ['recognition', 'synthesis']:
            with self.subTest(kind=kind):
                runtime, events, _, _, models, graph, _ = self.fixture()
                if kind == 'recognition':
                    graph.recover.side_effect = None
                    graph.recover.return_value = (runtime.frozen[0], None)
                    wait_for(lambda: not runtime.output_available)
                    models.transcribe.side_effect = RuntimeError('Real model failure')
                    self.utterance(runtime, 1)
                else:
                    models.synthesize.side_effect = RuntimeError('Real model failure')
                    runtime.command({'type': 'speak', 'id': 'fail', 'text': 'Fail loudly.'})
                wait_for(lambda: runtime.closed)
                self.assertTrue(any(e['type'] == 'error' and 'Real model failure' in e['message'] for e in events))

    def test_watchdog_runs_even_when_recovery_graph_inspection_is_blocked(self):
        runtime, events, _, _, models, graph, _ = self.fixture()
        graph_entered, graph_release = threading.Event(), threading.Event()
        model_entered, model_release = threading.Event(), threading.Event()
        self.addCleanup(graph_release.set)
        self.addCleanup(model_release.set)
        now = [time.monotonic()]
        runtime.clock = lambda: now[0]
        def transcribe(pcm):
            model_entered.set()
            model_release.wait(4)
            return 'Too late', 1
        def recover(frozen):
            graph_entered.set()
            graph_release.wait(4)
            return frozen
        models.transcribe.side_effect = transcribe
        graph.recover.side_effect = recover
        self.utterance(runtime, 1)
        self.assertTrue(model_entered.wait(1))
        now[0] += 2
        self.assertTrue(graph_entered.wait(1))
        now[0] += 11
        wait_for(lambda: runtime.closed)
        self.assertTrue(any(e['type'] == 'error' and 'budget' in e['message'] for e in events))

    def test_output_loss_keeps_input_and_pending_then_rebinds_without_replay(self):
        runtime, events, captures, played, _, graph, _ = self.fixture()
        epoch = runtime.epoch
        runtime._interrupt(epoch)
        runtime._segment({'type': 'onset', 'id': 1}, epoch)
        pending = set(runtime.pending)
        source, target = runtime.frozen
        graph.recover.side_effect = None
        graph.recover.return_value = (source, None)
        wait_for(lambda: not runtime.output_available)
        self.assertTrue(runtime.input_available and runtime.ready)
        self.assertFalse(captures[0].closed)
        self.assertEqual(runtime.pending, pending)
        runtime._segment({'type': 'endpoint', 'id': 1, 'pcm': b'\0\0', 'truncated': False}, epoch)
        wait_for(lambda: any(e['type'] == 'utterance' for e in events))
        runtime.command({'type': 'speak', 'id': 'lost', 'text': 'Never replay.'})
        graph.recover.return_value = (source, target)
        wait_for(lambda: runtime.output_available)
        self.assertNotIn('lost', played)
        self.assertEqual(runtime.epoch, epoch)
        self.assertEqual([e for e in events if e['type'] == 'availability'], [
            {'type': 'availability', 'input': True, 'output': False, 'fallback': False,
             'listening': True, 'speakerMode': False},
            {'type': 'availability', 'input': True, 'output': True, 'fallback': False,
             'listening': True, 'speakerMode': False}])

    def test_input_loss_cancels_partial_and_recovery_uses_fresh_epoch_and_gate(self):
        runtime, events, captures, _, _, graph, _ = self.fixture()
        epoch, gate = runtime.epoch, runtime.gate
        runtime._interrupt(epoch)
        runtime._segment({'type': 'onset', 'id': 1}, epoch)
        source, target = runtime.frozen
        graph.recover.side_effect = None
        graph.recover.return_value = (None, target)
        wait_for(lambda: not runtime.input_available)
        self.assertTrue(runtime.ready and runtime.output_available)
        self.assertFalse(runtime.pending)
        self.assertTrue(captures[0].closed)
        self.assertTrue(any(e['type'] == 'cancelled' and e['reason'] == 'input_disconnected' for e in events))
        runtime._segment({'type': 'endpoint', 'id': 1, 'pcm': b'\0\0', 'truncated': False}, epoch)
        self.assertFalse(any(e['type'] == 'utterance' for e in events))
        graph.recover.return_value = (source, target)
        wait_for(lambda: runtime.input_available)
        self.assertIsNot(runtime.gate, gate)
        self.assertGreater(runtime.epoch, epoch)
        runtime._capture_fault(RuntimeError('Old recorder'), epoch)
        self.assertTrue(runtime.input_available)
        self.utterance(runtime, 1)
        wait_for(lambda: any(e['type'] == 'utterance' for e in events))
        self.assertEqual(sum(e['type'] == 'ready' for e in events), 1)

    def test_bluetooth_capture_accepts_same_device_transition_only_during_intentional_start(self):
        runtime, events, captures, played, _, graph, _ = self.fixture(bluetooth=True, transition=True)
        self.assertEqual(len(captures), 2)
        self.assertTrue(captures[0].closed)
        self.assertFalse(captures[1].closed)
        self.assertEqual(sum(event['type'] == 'ready' for event in events), 1)
        old_epoch = runtime.epoch - 1
        runtime._capture_fault(RuntimeError('Obsolete capture error'), old_epoch)
        self.assertFalse(runtime.closed)
        graph.recover.side_effect = RuntimeError('Disconnected after readiness')
        wait_for(lambda: not runtime.input_available)
        self.assertFalse(runtime.closed)
        self.assertTrue(runtime.ready)
        self.assertEqual(len(captures), 2)
        self.assertTrue(all(capture.closed for capture in captures))

    def test_output_loss_discards_inflight_and_queued_speech_even_if_synthesis_finishes_after_return(self):
        runtime, events, _, played, models, graph, _ = self.fixture()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def synthesize(text):
            if text == 'Old speech.':
                entered.set()
                release.wait(4)
            return b'\0\0' * 100
        models.synthesize.side_effect = synthesize
        runtime.command({'type': 'speak', 'id': 'old', 'text': 'Old speech.'})
        self.assertTrue(entered.wait(1))
        runtime.command({'type': 'speak', 'id': 'queued', 'text': 'Queued speech.'})
        source, target = runtime.frozen
        old_output_epoch = runtime.output_epoch
        graph.recover.side_effect = None
        graph.recover.return_value = (source, None)
        wait_for(lambda: not runtime.output_available)
        wait_for(lambda: any(e['type'] == 'speech_end' and e['id'] == 'old' for e in events))
        self.assertFalse(release.is_set())
        graph.recover.return_value = (source, target)
        wait_for(lambda: runtime.output_available)
        runtime._speaker_event({'type': 'fault', 'message': 'Old output'}, old_output_epoch)
        self.assertTrue(runtime.output_available)
        release.set()
        wait_for(lambda: any(e['type'] == 'speech_end' and e['id'] == 'old' for e in events))
        self.assertNotIn('old', played)
        self.assertNotIn('queued', played)
        for ident in ['old', 'queued']:
            self.assertEqual([e for e in events if e['type'] == 'speech_end' and e['id'] == ident],
                             [{'type': 'speech_end', 'id': ident, 'completed': False}])
        runtime.command({'type': 'speak', 'id': 'future', 'text': 'New speech.'})
        wait_for(lambda: 'future' in played)

    def test_slow_input_warmup_does_not_block_independent_output_recovery(self):
        runtime, events, captures, _, _, graph, _ = self.fixture()
        source, target = runtime.frozen
        graph.recover.side_effect = None
        graph.recover.return_value = (None, None)
        wait_for(lambda: not runtime.input_available and not runtime.output_available)
        with patch.object(type(captures[0]), 'start', lambda capture: None):
            graph.recover.return_value = (source, None)
            wait_for(lambda: len(captures) == 2)
            self.assertFalse(runtime.input_available)
            graph.recover.return_value = (source, target)
            wait_for(lambda: runtime.output_available)
            self.assertFalse(runtime.input_available)
            self.assertFalse(runtime.closed)
            self.assertEqual(len(captures), 2)

    def test_input_recovery_never_replaces_valid_answer_or_stalls_future_speech(self):
        runtime, events, _, played, models, graph, _ = self.fixture()
        source, target = runtime.frozen
        graph.recover.side_effect = None
        graph.recover.return_value = (None, target)
        wait_for(lambda: not runtime.input_available)
        runtime.command({'type': 'speak', 'id': 'answer', 'text': 'Keep this answer playing.'})
        wait_for(lambda: 'answer' in played)
        answer_done = runtime.current_playback[1]
        graph.recover.return_value = (source, target)
        wait_for(lambda: runtime.input_available)
        self.assertEqual(played, ['ready', 'answer'])
        self.assertFalse(answer_done.is_set())
        self.assertEqual(runtime.current_playback[0], 'answer')
        runtime._speaker_event({'type': 'played', 'id': 'ready'})
        runtime.command({'type': 'speak', 'id': 'next', 'text': 'Play this answer next.'})
        self.assertFalse(answer_done.is_set())
        runtime._speaker_event({'type': 'played', 'id': 'answer'})
        wait_for(lambda: 'next' in played)
        self.assertTrue(answer_done.is_set())
        self.assertEqual(models.synthesize.call_count, 2)
        self.assertEqual([e for e in events if e['type'] == 'speech_end' and e['id'] == 'answer'],
                         [{'type': 'speech_end', 'id': 'answer', 'completed': True}])

    def test_input_can_recover_without_output_and_recovery_creator_stays_alive(self):
        runtime, events, captures, played, _, graph, _ = self.fixture(capture_process=True)
        source, target = runtime.frozen
        old_output_epoch = runtime.output_epoch
        old_epoch = runtime.epoch
        graph.recover.side_effect = None
        graph.recover.return_value = (None, None)
        wait_for(lambda: not runtime.input_available and not runtime.output_available)
        graph.recover.return_value = (source, None)
        wait_for(lambda: runtime.input_available)
        self.assertFalse(runtime.output_available)
        self.assertEqual(played, ['ready'])
        self.assertEqual(len(captures), 2)
        time.sleep(0.15)
        self.assertIsNone(captures[-1].child.process.poll())
        runtime._speaker_event({'type': 'fault', 'message': 'Old sink'}, old_output_epoch)
        runtime._capture_fault(RuntimeError('Old capture'), old_epoch)
        self.assertTrue(runtime.input_available)
        graph.recover.return_value = (source, target)
        wait_for(lambda: runtime.output_available)
        self.assertEqual(played, ['ready'])
        runtime.shutdown()
        self.assertIsNotNone(captures[-1].child.process.poll())

    def test_bluetooth_start_fault_without_expected_graph_transition_never_retries(self):
        runtime, events, captures, _, _, graph, release = self.fixture(hold_load=True, bluetooth=True)
        graph.check.side_effect = RuntimeError('Capture device lost')
        graph.profile_transition.return_value = False
        release.set()
        wait_for(lambda: runtime.closed)
        self.assertEqual(len(captures), 1)
        self.assertTrue(captures[0].closed)
        self.assertFalse(any(event['type'] == 'ready' for event in events))

    def test_recurring_flat_dc_stops_input_without_filtering_normal_speech(self):
        receiver = Mock()
        healthy = open_mic.HealthyInput(receiver)
        speech = array.array("h", [32767, -32768] * 256).tobytes()
        healthy.feed(speech, True, captured_at=1)
        receiver.feed.assert_called_once_with(speech, True, captured_at=1)
        with self.assertRaisesRegex(RuntimeError, "flat clipping/DC"):
            healthy.feed(array.array("h", [-32768] * 512).tobytes(), False, captured_at=2)
        self.assertEqual(receiver.feed.call_count, 1)

    def test_packaged_models_and_open_mic_schema_have_no_wake_or_hint_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "stt").mkdir()
            (root / "tts").mkdir()
            for name in ("model.bin", "config.json", "tokenizer.json"):
                (root / "stt" / name).touch()
            (root / "tts/model.onnx").touch()
            (root / "tts/model.onnx.json").write_text(json.dumps({"language": {"code": "en_US"}}))
            base = {"version": 1, "cacheDir": str(root / "cache"),
                    "audio": {"input": "laptop", "output": "headphones", "echoCancellation": "none"}}
            with patch.dict("os.environ", {"PAJ_VOICE_SPEECH_BUNDLE": str(root)}):
                config = open_mic.validate(base)
                self.assertEqual(config["stt"]["model"], str(root / "stt"))
                self.assertEqual(config["turn"]["maxSeconds"], 120)
                fallback = {'name': 'Built-in', 'input': 'builtin-mic', 'output': 'builtin-speakers',
                            'inputDevice': 'alsa_card.builtin', 'outputDevice': 'alsa_card.builtin'}
                selected = {**base, 'audio': {**base['audio'], 'fallback': fallback}}
                self.assertEqual(open_mic.validate(selected)['audio']['fallback'], fallback)
                marked = {**selected, 'audio': {**selected['audio'], 'speakerMode': True,
                                               'fallback': {**fallback, 'speakerMode': True}}}
                self.assertTrue(open_mic.validate(marked)['audio']['fallback']['speakerMode'])
                for invalid in (None, [], {}, {**fallback, 'name': ''}, {**fallback, 'name': 'bad\nname'},
                                {**fallback, 'input': 'default'}, {**fallback, 'input': 'sink.monitor'},
                                {**fallback, 'output': 'auto'}, {**fallback, 'inputDevice': 17},
                                {**fallback, 'outputDevice': 'bad\nidentity'}, {**fallback, 'other': True},
                                {**fallback, 'speakerMode': 'true'}):
                    with self.assertRaises(ValueError):
                        open_mic.validate({**base, 'audio': {**base['audio'], 'fallback': invalid}})
                for maximum in (5, 30, 120):
                    self.assertEqual(open_mic.validate({**base, "turn": {"maxSeconds": maximum}})
                                     ["turn"]["maxSeconds"], maximum)
                for maximum in (4.9, 120.1, True):
                    with self.assertRaises(ValueError):
                        open_mic.validate({**base, "turn": {"maxSeconds": maximum}})
                for change in ({"addressPhrases": ["paj"]}, {"stt": {"hotwords": "pie"}},
                               {"turn": {"prefixIntervalMs": 500}}):
                    with self.assertRaises(ValueError):
                        open_mic.validate({**base, **change})
                (root / "stt/tokenizer.json").unlink()
                with self.assertRaises(ValueError):
                    open_mic.validate(base)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux child lifetime semantics')
    def test_capture_child_survives_loader_ready_boundary_until_shutdown(self):
        runtime, events, captures, *_ = self.fixture(capture_process=True)
        child = captures[0].child
        time.sleep(0.15)
        self.assertIsNone(child.process.poll(), 'Recorder died when its creating loader thread returned')
        runtime.shutdown()
        self.assertIsNotNone(child.process.poll())

    def test_ready_requires_warmup_then_capture_stays_open_without_a_trial_timer(self):
        runtime, events, captures, played, *_ = self.fixture()
        self.assertEqual(len(captures), 1)
        ready = next(event for event in events if event["type"] == "ready")
        self.assertEqual(ready["mode"], "open-mic")
        self.assertEqual(ready["warmup"]["stableQuietSeconds"], 0.75)
        self.assertEqual(played, ["ready"])
        self.assertFalse(captures[0].closed)
        runtime.shutdown()
        self.assertTrue(captures[0].closed)

    def test_bare_commands_and_decode_additions_are_preserved_without_wake_words(self):
        runtime, events, _, _, models, *_ = self.fixture()
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        count = [0]

        def transcribe(pcm):
            count[0] += 1
            if count[0] == 1:
                started.set()
                release.wait(1)
                return "inspect the tests", 1
            return "focus on the failing ones", 1

        models.transcribe.side_effect = transcribe
        self.utterance(runtime, 1)
        self.assertTrue(started.wait(1))
        self.utterance(runtime, 2)
        self.assertTrue(runtime.speaker.paused)
        release.set()
        wait_for(lambda: len([e for e in events if e["type"] == "utterance"]) == 2)
        self.assertEqual([e["text"] for e in events if e["type"] == "utterance"],
                         ["inspect the tests", "focus on the failing ones"])
        self.assertFalse(runtime.pending)

    def test_new_speech_discards_inflight_synthesis_without_cancelling_capture(self):
        runtime, events, captures, played, models, *_ = self.fixture()
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def synthesize(text):
            started.set()
            release.wait(1)
            return b"\0\0" * 1024

        models.synthesize.side_effect = synthesize
        runtime.command({"type": "speak", "id": "old", "text": "An old answer."})
        self.assertTrue(started.wait(1))
        runtime._interrupt(runtime.epoch)
        runtime._segment({"type": "onset", "id": 1}, runtime.epoch)
        release.set()
        wait_for(lambda: any(e["type"] == "speech_end" and e["id"] == "old" for e in events))
        self.assertNotIn("old", played)
        self.assertFalse(captures[0].closed)
        ended = next(e for e in events if e["type"] == "speech_end" and e["id"] == "old")
        self.assertIs(ended.get("completed"), False)

    def test_normal_speech_waits_for_prior_playback_instead_of_cutting_it_off(self):
        runtime, events, _, played, *_ = self.fixture()
        runtime.command({"type": "speak", "id": "one", "text": "First sentence."})
        wait_for(lambda: "one" in played)
        runtime.command({"type": "speak", "id": "two", "text": "Second sentence."})
        time.sleep(0.03)
        self.assertNotIn("two", played)
        runtime._speaker_event({"type": "played", "id": "one"})
        ended = next(e for e in events if e["type"] == "speech_end" and e["id"] == "one")
        self.assertIs(ended.get("completed"), True)
        wait_for(lambda: "two" in played)

    def test_keyed_updates_coalesce_queued_and_inflight_speech(self):
        runtime, events, _, played, models, *_ = self.fixture()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def synthesize(text):
            if text == "Old progress.":
                entered.set()
                release.wait(1)
            return b"\0\0" * 1024

        models.synthesize.side_effect = synthesize
        runtime.command({"type": "speak", "id": "old", "text": "Old progress.", "key": "progress"})
        self.assertTrue(entered.wait(1))
        runtime.command({"type": "speak", "id": "interim", "text": "Interim progress.", "key": "progress"})
        runtime.command({"type": "speak", "id": "latest", "text": "Current progress.", "key": "progress"})
        release.set()
        wait_for(lambda: "latest" in played)
        self.assertNotIn("old", played)
        self.assertNotIn("interim", played)

    def test_shutdown_or_mute_during_model_loading_never_opens_a_late_microphone(self):
        for action in ("shutdown", "mute"):
            with self.subTest(action=action):
                runtime, events, captures, _, _, _, release = self.fixture(hold_load=True)
                runtime.command({"type": action, **({"muted": True} if action == "mute" else {})})
                release.set()
                time.sleep(0.03)
                self.assertFalse(captures)
                self.assertFalse(any(event["type"] == "ready" for event in events))
                runtime.shutdown()

    def test_mute_failure_and_eof_style_shutdown_close_all_owned_audio(self):
        runtime, events, captures, *_ = self.fixture()
        speaker, sink = runtime.speaker, runtime.sink
        runtime.command({"type": "mute", "muted": True})
        self.assertTrue(captures[0].closed)
        self.assertFalse(runtime.ready)
        runtime.fail(RuntimeError("fake device loss"))
        runtime.fail(RuntimeError("again"))
        self.assertTrue(runtime.closed)
        self.assertTrue(speaker.closed and sink.closed)
        self.assertEqual(sum(e["type"] == "error" for e in events), 1)


if __name__ == "__main__":
    unittest.main()
