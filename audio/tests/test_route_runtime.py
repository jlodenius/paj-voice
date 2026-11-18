import contextlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch

from paj_voice_audio import open_mic
from paj_voice_audio.devices import Graph
from paj_voice_audio.input_ready import InputReady
from test_open_mic import Vector, wait_for
from test_routes import card, node


class Clock:
    def __init__(self):
        self.now = 0
        self.advancing = True

    def __call__(self):
        return self.now


class Policy:
    def __init__(self, clock):
        self.clock = clock
        self.profile = 'a2dp'
        self.due = None
        self.next_profile = None
        self.other_capture = False
        self.present = True
        self.churn = False

    def capture(self, bluetooth):
        if bluetooth:
            self.next_profile, delay = 'hfp', 0.5
        elif self.other_capture:
            return
        else:
            self.next_profile, delay = 'a2dp', 2
        self.due = self.clock() + delay

    def entries(self):
        if self.due is not None and self.clock() >= self.due:
            self.profile, self.due = self.next_profile, None
        entries = [card(1, 'alsa_card.desk'), node('desk-mic', 10, 'Audio/Source', 1)]
        if self.present:
            serial = int(self.clock() * 100) + 100 if self.churn else 30 if self.profile == 'a2dp' else 40
            entries += [card(2, 'bluez_card.headset'),
                        node(f'bluez_input.{self.profile}', serial + 1, 'Audio/Source', 2),
                        node(f'bluez_output.{self.profile}', serial + 2, 'Audio/Sink', 2)]
        return entries


class RouteRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.clock = Clock()
        self.policy = Policy(self.clock)
        self.captures, self.played, self.runtimes = [], [], []
        self.snapshots = []
        test = self

        class Capture:
            def __init__(self, executable, selected, vad, threshold, receiver, fail):
                self.selected, self.receiver, self.closed = selected, receiver, False
                self.started = False
                test.captures.append(self)

            def start(self):
                self.started = True
                test.policy.capture(self.selected.bluetooth)

            def health(self):
                if not self.closed and test.clock.advancing:
                    test.clock.now += 0.1
                    self.receiver.feed(b'\0\0' * 1600, False, captured_at=test.clock())

            def wait_ready(self, timeout=3):
                self.health()

            def close(self):
                if self.started and not self.closed and self.selected.bluetooth:
                    test.policy.capture(False)
                self.closed = True

        class Sink:
            def __init__(self, executable, selected, rate):
                self.selected, self.closed = selected, False

            def health(self):
                pass

            def close(self):
                self.closed = True

        class Speaker:
            def __init__(self, sink, emit):
                self.sink, self.closed = sink, False

            def play(self, pcm, ident=None):
                test.played.append((self.sink.selected.name, test.clock()))

            def cancel(self):
                pass

            def close(self):
                self.closed = True

        models = types.SimpleNamespace(rate=16000, transcribe=Mock(), synthesize=Mock(),
            np=types.SimpleNamespace(arange=lambda size: Vector(), sin=lambda value: Vector(),
                                     hanning=lambda size: Vector(), pi=3.14))
        for name, replacement in [('SpeechInference', lambda **kwargs: models),
                                  ('Capture', Capture), ('PipeSink', Sink), ('Speaker', Speaker),
                                  ('InputReady', lambda receiver: InputReady(receiver, clock=self.clock))]:
            self.stack.enter_context(patch.object(open_mic, name, replacement))
        self.stack.enter_context(patch.dict(sys.modules, {'pysilero_vad':
            types.SimpleNamespace(SileroVoiceActivityDetector=object)}))

    def runtime(self, bluetooth_input=False, blocked_bind=None):
        config = {'cacheDir': str(self.root / 'cache'),
                  'stt': {'model': '/fake/stt', 'computeType': 'int8'},
                  'tts': {'model': '/fake/tts', 'config': '/fake/config', 'volume': 0.4, 'lengthScale': 1},
                  'audio': {'input': 'bluez_input.saved' if bluetooth_input else 'desk-mic',
                            'output': 'bluez_output.saved',
                            'inputDevice': 'bluez_card.headset' if bluetooth_input else 'alsa_card.desk',
                            'outputDevice': 'bluez_card.headset'},
                  'turn': {'silenceMs': 800, 'maxSeconds': 12, 'speechThreshold': 0.001}}
        events, complete = [], threading.Event()
        start = self.clock()
        self.clock.advancing = True

        def run(command, **kwargs):
            self.snapshots.append((self.clock(), kwargs['timeout']))
            if self.policy.churn:
                self.clock.now += min(0.4, kwargs['timeout'])
            return types.SimpleNamespace(stdout=json.dumps(self.policy.entries()))

        graph = Graph(paths={name: 'FAKE' for name in ['pw-dump', 'pw-record', 'pw-play']},
                      run=run, clock=self.clock)
        if blocked_bind:
            original, calls = graph.bind, [0]
            def bind(*args, **kwargs):
                calls[0] += 1
                if calls[0] == 2:
                    blocked_bind[0].set()
                    blocked_bind[1].wait(2)
                return original(*args, **kwargs)
            graph.bind = bind

        def emit(event):
            events.append({**event, 'at': self.clock()})
            if event['type'] in ('ready', 'error'):
                self.clock.advancing = False

        runtime = open_mic.Runtime(emit, clock=self.clock)
        original_load = runtime._load
        def load(value):
            try:
                original_load(value)
            finally:
                complete.set()
        runtime._load = load
        self.runtimes.append(runtime)
        def cleanup():
            runtime.shutdown()
            self.assertTrue(complete.wait(2), 'Loader owner thread did not terminate')
        self.addCleanup(cleanup)
        with patch.object(open_mic, 'validate', return_value=config), patch.object(open_mic, 'Graph', return_value=graph):
            runtime.command({'type': 'configure', 'config': {}})
            if blocked_bind:
                self.assertTrue(blocked_bind[0].wait(1))
            else:
                wait_for(lambda: runtime.ready or runtime.closed)
        return runtime, events, graph, start, complete

    def test_desk_headset_desk_waits_for_delayed_output_restoration_before_ready(self):
        desk, events, _, _, done = self.runtime()
        self.assertTrue(desk.ready)
        self.assertGreaterEqual(events[-1]['at'], 2.5)
        desk.shutdown()
        self.assertTrue(done.wait(1))
        headset, events, _, started, done = self.runtime(bluetooth_input=True)
        self.assertTrue(headset.ready)
        self.assertEqual(self.policy.profile, 'hfp')
        self.assertGreaterEqual(events[-1]['at'] - started, 2.5)
        self.assertEqual(self.played[-1][0], 'bluez_output.hfp')
        headset.shutdown()
        self.assertTrue(done.wait(1))
        desk, events, graph, started, _ = self.runtime()
        self.assertTrue(desk.ready)
        self.assertEqual(self.policy.profile, 'a2dp')
        self.assertGreaterEqual(events[-1]['at'] - started, 2.5)
        self.assertEqual(sum(event['type'] == 'ready' for event in events), 1)
        self.assertEqual(self.played[-1][0], 'bluez_output.a2dp')
        graph.check()
        self.clock.now += 3
        graph.check()
        self.assertFalse(desk.closed)
        self.policy.present = False
        self.clock.now += 2
        wait_for(lambda: desk.closed)
        self.assertTrue(any(event['type'] == 'error' for event in events))
        self.assertTrue(all(capture.closed for capture in self.captures))

    def test_other_application_retaining_hfp_does_not_block_or_force_profile(self):
        self.policy.profile, self.policy.other_capture = 'hfp', True
        runtime, events, graph, start, _ = self.runtime()
        self.assertTrue(runtime.ready)
        self.assertGreaterEqual(events[-1]['at'] - start, 2.5)
        self.assertEqual(self.policy.profile, 'hfp')
        self.assertEqual(self.played[-1][0], 'bluez_output.hfp')
        self.assertEqual(len(self.captures), 1)
        graph.check()
        self.clock.now += 5
        graph.check()
        self.assertFalse(runtime.closed)

    def test_shutdown_and_mute_do_not_wait_for_graph_bind_or_start_late_capture(self):
        for action in ['shutdown', 'mute']:
            with self.subTest(action=action):
                entered, release = threading.Event(), threading.Event()
                runtime, events, _, _, complete = self.runtime(blocked_bind=(entered, release))
                returned = threading.Event()
                def cancel():
                    runtime.command({'type': action, **({'muted': True} if action == 'mute' else {})})
                    returned.set()
                thread = threading.Thread(target=cancel)
                thread.start()
                try:
                    self.assertTrue(returned.wait(0.2), 'Privacy cancellation blocked on pw-dump')
                finally:
                    release.set()
                    thread.join(1)
                self.assertTrue(complete.wait(1))
                self.assertFalse(self.captures)
                self.assertFalse(any(event['type'] == 'ready' for event in events))

    def test_repeated_profile_churn_exhausts_one_absolute_transition_deadline(self):
        self.policy.churn = True
        runtime, events, _, start, _ = self.runtime()
        self.assertTrue(runtime.closed)
        self.assertFalse(runtime.ready)
        self.assertFalse(any(event['type'] == 'ready' for event in events))
        self.assertRegex(next(event['message'] for event in events if event['type'] == 'error'), 'deadline')
        self.assertLessEqual(self.clock() - start, 12.5)
        self.assertTrue(all(capture.closed for capture in self.captures))
        self.assertLess(len(self.captures), 10)
        self.assertTrue(any(timeout < 3 for _, timeout in self.snapshots))
