import threading
import types
import unittest
from unittest.mock import Mock

from paj_voice_audio import open_mic
from paj_voice_audio.devices import Node
import test_open_mic


class FallbackTests(unittest.TestCase):
    fixture = test_open_mic.OpenMicTests.fixture
    def test_pair_activation_is_sticky_and_fences_old_input(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        old_epoch = runtime.epoch
        old_output_epoch = runtime.output_epoch
        old_segments = runtime.segments
        runtime.gate.receiver.feed(b'\0\0' * 512, True)
        self.assertIsNotNone(old_segments.current)
        pending = set(runtime.pending)
        source = Node('builtin-mic', '40', 'Audio/Source', 'builtin')
        target = Node('builtin-speakers', '41', 'Audio/Sink', 'builtin')
        runtime.config['audio']['fallback'] = {'name': 'Built-in', 'input': source.name,
                                             'output': target.name}
        graph.bind = Mock(return_value=(source, target))
        self.assertTrue(runtime._try_fallback())
        self.assertTrue(runtime.using_fallback)
        self.assertEqual(runtime.frozen, (source, target))
        runtime._speaker_event({'type': 'fault', 'message': 'old transport'}, old_output_epoch)
        self.assertTrue(runtime.output_available)
        self.assertGreater(runtime.epoch, old_epoch)
        self.assertIsNone(old_segments.current)
        self.assertFalse(runtime.pending)
        self.assertTrue(all(any(event['type'] == 'cancelled' and event['id'] == ident for event in events)
                            for ident in pending))
        runtime._segment({'type': 'onset', 'id': 99}, old_epoch)
        self.assertFalse(any(event.get('id') == f'e{old_epoch}-t99' for event in events))
        graph.bind.reset_mock()
        self.assertFalse(runtime._try_fallback())
        graph.bind.assert_not_called()
        self.assertEqual(runtime.config['audio']['input'], 'laptop')

    def test_identical_healthy_input_retains_its_valid_capture(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        source = runtime.source
        target = Node('builtin-speakers', '41', 'Audio/Sink', 'builtin')
        runtime.config['audio']['fallback'] = {'name': 'Speakers', 'input': source.name, 'output': target.name}
        graph.bind = Mock(return_value=(source, target))
        capture, epoch = runtime.capture, runtime.epoch
        self.assertTrue(runtime._try_fallback())
        self.assertIs(runtime.capture, capture)
        self.assertEqual(runtime.epoch, epoch)
        self.assertEqual(len(captures), 1)

    def test_absent_pair_does_not_replace_available_preferred(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        runtime.config['audio']['fallback'] = {'name': 'Built-in', 'input': 'mic', 'output': 'speakers'}
        source = runtime.source
        graph.bind = Mock(side_effect=RuntimeError('not both available'))
        self.assertFalse(runtime._try_fallback())
        self.assertFalse(runtime.using_fallback)
        self.assertIs(runtime.source, source)
        self.assertTrue(runtime.input_available)

    def test_echo_guard_discards_readout_tail_and_whole_interruption(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        runtime.config['audio']['fallback'] = {'name': 'Fallback', 'input': 'laptop',
                                              'output': 'headphones', 'speakerMode': False}
        now = [100.0]
        runtime.clock = lambda: now[0]
        runtime.using_fallback = True
        self.assertTrue(runtime.speaker_mode)
        runtime._speaker_event({'type': 'playing', 'id': 'readout'})
        self.assertFalse(runtime.listening)
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, True, 100.0))
        runtime._speaker_event({'type': 'idle', 'id': 'readout'})
        now[0] += 0.6
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, True, now[0]))
        now[0] += 0.1
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        now[0] += 0.9
        self.assertTrue(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        self.assertTrue(runtime.listening)
        self.assertEqual([event['listening'] for event in events if event['type'] == 'capture_state'],
                         [False, True])

    def test_initial_fallback_guards_the_unchanged_startup_cue(self):
        source = Node('builtin-mic', '40', 'Audio/Source', 'builtin')
        target = Node('builtin-speakers', '41', 'Audio/Sink', 'builtin')

        def prepare(config, graph, models):
            config['audio']['fallback'] = {'name': 'Built-in', 'input': source.name, 'output': target.name}
            def bind(input_name, *args, **kwargs):
                if input_name != source.name:
                    raise RuntimeError('preferred absent')
                return source, target
            graph.bind = bind

        runtime, events, captures, played, models, graph, _ = self.fixture(prepare=prepare)
        self.assertTrue(runtime.using_fallback)
        self.assertFalse(runtime.listening)
        self.assertEqual(played, ['ready'])
        ready = next(event for event in events if event['type'] == 'ready')
        self.assertTrue(ready['fallback'])
        self.assertFalse(ready['listening'])
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, True, None))

    def test_initial_incomplete_pairs_keep_available_preferred_and_can_fall_back_later(self):
        source = Node('builtin-mic', '40', 'Audio/Source', 'builtin')
        target = Node('builtin-speakers', '41', 'Audio/Sink', 'builtin')
        preferred = Node('headphones', '2', 'Audio/Sink')
        def prepare(config, graph, models):
            config['audio']['fallback'] = {'name': 'Built-in', 'input': source.name, 'output': target.name}
            graph.bind = Mock(side_effect=RuntimeError('both pairs incomplete'))
            graph.available = Mock(return_value=(None, preferred))
            graph.recover = Mock(return_value=(None, preferred))
        runtime, events, captures, played, models, graph, _ = self.fixture(prepare=prepare)
        self.assertFalse(runtime.using_fallback)
        self.assertFalse(runtime.input_available)
        self.assertTrue(runtime.output_available)
        self.assertEqual(runtime.target, preferred)
        self.assertFalse(any(event['type'] == 'error' for event in events))
        graph.bind = Mock(return_value=(source, target))
        graph.recover = Mock(side_effect=lambda frozen: frozen if frozen[0].serial else (None, preferred))
        test_open_mic.wait_for(lambda: runtime.using_fallback and runtime.input_available)
        self.assertEqual(played, ['ready'])
        self.assertEqual(runtime.frozen, (source, target))

    def test_transport_loss_activates_fallback_and_drops_queued_output(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        source = Node('builtin-mic', '40', 'Audio/Source', 'builtin')
        target = Node('builtin-speakers', '41', 'Audio/Sink', 'builtin')
        runtime.config['audio']['fallback'] = {'name': 'Built-in', 'input': source.name, 'output': target.name}
        graph.bind = Mock(return_value=(source, target))
        with runtime.lock:
            runtime.speeches.put_nowait({'id': 'old-queued', 'text': 'do not replay', 'revision': runtime.revision})
            runtime._suspend(output_lost=True)
        self.assertTrue(runtime._try_fallback())
        self.assertTrue(runtime.speeches.empty())
        self.assertNotIn('old-queued', played)
        self.assertTrue(any(event == {'type': 'speech_end', 'id': 'old-queued', 'completed': False}
                            for event in events))

    def test_half_duplex_ignores_pcm_then_accepts_only_a_fresh_request(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        now = [runtime.clock() + 0.1]
        runtime.clock = runtime.segments.clock = lambda: now[0]
        runtime.using_fallback = True
        receiver = runtime.gate.receiver
        runtime._speaker_event({'type': 'playing', 'id': 'readout'})
        for _ in range(4):
            receiver.feed(b'\0\0' * 512, True, captured_at=now[0])
            now[0] += 0.1
        runtime._speaker_event({'type': 'idle', 'id': 'readout'})
        for _ in range(12):
            receiver.feed(b'\0\0' * 512, True, captured_at=now[0])
            now[0] += 0.1
        self.assertFalse(any(event['type'] == 'addressed' for event in events))
        for _ in range(12):
            receiver.feed(b'\0\0' * 512, False, captured_at=now[0])
            now[0] += 0.1
        self.assertTrue(runtime.listening)
        receiver.feed(b'\0\0' * 512, True, captured_at=now[0])
        now[0] += 0.9
        receiver.feed(b'\0\0' * 512, False, captured_at=now[0])
        test_open_mic.wait_for(lambda: any(event['type'] == 'utterance' for event in events))
        self.assertEqual(models.transcribe.call_count, 1)

    def test_fallback_bind_blocked_then_mute_cannot_reopen_endpoints(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        runtime.config['audio']['fallback'] = {'name': 'Built-in', 'input': 'mic', 'output': 'speakers'}
        entered, release = threading.Event(), threading.Event()
        def bind(*args):
            entered.set()
            release.wait(2)
            return Node('mic', '40', 'Audio/Source'), Node('speakers', '41', 'Audio/Sink')
        graph.bind = bind
        worker = threading.Thread(target=runtime._try_fallback)
        worker.start()
        self.assertTrue(entered.wait(1))
        runtime._mute()
        release.set()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertFalse(runtime.using_fallback)
        self.assertIsNone(runtime.capture)
        self.assertFalse(runtime.input_available)

    def test_preferred_return_does_not_switch_away_from_frozen_fallback(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        source = Node('builtin-mic', '40', 'Audio/Source', 'builtin')
        target = Node('builtin-speakers', '41', 'Audio/Sink', 'builtin')
        runtime.config['audio']['fallback'] = {'name': 'Built-in', 'input': source.name, 'output': target.name}
        graph.bind = Mock(return_value=(source, target))
        self.assertTrue(runtime._try_fallback())
        test_open_mic.wait_for(lambda: runtime.input_available)
        graph.bind.reset_mock()
        calls = graph.recover.call_count
        test_open_mic.wait_for(lambda: graph.recover.call_count > calls)
        self.assertEqual(graph.recover.call_args.args, ((source, target),))
        graph.bind.assert_not_called()
        self.assertTrue(runtime.using_fallback)
        epoch = runtime.epoch
        runtime._suspend(input_lost=True)
        test_open_mic.wait_for(lambda: runtime.input_available)
        self.assertGreater(runtime.epoch, epoch)
        self.assertEqual(played, ['ready'])
        graph.bind.assert_not_called()

    def test_actual_playback_activity_covers_owned_pcm_and_cancel_drain(self):
        from paj_voice_audio.audio import Speaker
        events, writes = [], []
        now = [100.0]
        runtime = open_mic.Runtime(events.append, clock=lambda: now[0])
        runtime.ready = runtime.input_available = runtime.output_available = True
        runtime.using_fallback = True
        runtime.config = {'turn': {'silenceMs': 800}}
        entered, release = threading.Event(), threading.Event()
        def write(pcm, current, *, rate):
            writes.append(runtime._capture_allowed(pcm, True, now[0]))
            entered.set()
            release.wait(1)
            return current()
        sink = types.SimpleNamespace(rate=16000, abort=Mock(), close=Mock(),
                                     write=write, drain=Mock())
        speaker = Speaker(sink, runtime._speaker_event)
        runtime.speaker = speaker
        speaker.activity = runtime._speaker_event
        self.addCleanup(runtime.shutdown)
        self.addCleanup(release.set)
        speaker.play(b'\0\0' * 1600, ident='owned')
        self.assertTrue(entered.wait(1))
        self.assertEqual(writes, [False])
        self.assertFalse(runtime.listening)
        runtime._silence()
        release.set()
        test_open_mic.wait_for(lambda: not runtime.owned_playback)
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        now[0] += 0.6
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        now[0] += 0.9
        self.assertTrue(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        self.assertFalse(any(event['type'] == 'addressed' for event in events))

    def test_transport_cleanup_stays_gated_until_output_is_actually_closed(self):
        now = [100.0]
        runtime = open_mic.Runtime(lambda event: None, clock=lambda: now[0])
        runtime.ready = runtime.input_available = runtime.output_available = True
        runtime.using_fallback = runtime.owned_playback = True
        runtime.listening = False
        runtime.config = {'turn': {'silenceMs': 800}}
        entered, release = threading.Event(), threading.Event()
        def close():
            entered.set()
            release.wait(1)
        runtime.speaker = types.SimpleNamespace(close=close)
        self.addCleanup(runtime.shutdown)
        self.addCleanup(release.set)
        worker = threading.Thread(target=lambda: runtime._suspend(output_lost=True))
        worker.start()
        self.assertTrue(entered.wait(1))
        now[0] += 2
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        release.set()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        now[0] += 0.6
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        now[0] += 0.9
        self.assertTrue(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))

    def test_startup_model_fault_is_not_replaced_by_fallback(self):
        def prepare(config, graph, models):
            config['audio']['fallback'] = {'name': 'Built-in', 'input': 'builtin-mic', 'output': 'builtin-speakers'}
            graph.bind = Mock(wraps=graph.bind)
            models.np.arange = Mock(side_effect=RuntimeError('model failed'))
        runtime, events, captures, played, models, graph, release = self.fixture(hold_load=True, prepare=prepare)
        release.set()
        test_open_mic.wait_for(lambda: runtime.closed)
        self.assertFalse(runtime.using_fallback)
        self.assertEqual(graph.bind.call_count, 1)
        self.assertTrue(any(event['type'] == 'error' and event['stage'] == 'models' for event in events))

    def test_preferred_speaker_mode_guards_startup_without_configured_fallback(self):
        def prepare(config, graph, models):
            config['audio']['speakerMode'] = True
        runtime, events, captures, played, models, graph, _ = self.fixture(prepare=prepare)
        ready = next(event for event in events if event['type'] == 'ready')
        self.assertFalse(runtime.using_fallback)
        self.assertTrue(ready['speakerMode'])
        self.assertFalse(ready['listening'])
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, True, None))
        runtime._availability()
        self.assertTrue(events[-1]['speakerMode'])

    def test_delayed_owned_pcm_is_discarded_after_guard_reopens(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        now = [runtime.clock() + 0.1]
        start = now[0]
        runtime.clock = runtime.segments.clock = lambda: now[0]
        runtime.using_fallback = True
        runtime._speaker_event({'type': 'playing', 'id': 'readout', 'generation': 1})
        now[0] += 1
        runtime._speaker_event({'type': 'idle', 'id': 'readout', 'generation': 1})
        now[0] += 1
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        now[0] += 0.9
        self.assertTrue(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, True, start + 0.5))
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, True, start + 1.3))
        runtime.gate.receiver.feed(b'\0\0' * 512, True, captured_at=start + 0.5)
        runtime.gate.receiver.feed(b'\0\0' * 512, True, captured_at=start + 1.3)
        self.assertFalse(any(event['type'] == 'addressed' for event in events))
        models.transcribe.assert_not_called()
        now[0] += 0.01
        self.assertTrue(runtime._capture_allowed(b'\0\0' * 512, False, now[0]))

    def test_old_cancelled_activity_cannot_release_current_answer_guard(self):
        runtime, events, captures, played, models, graph, _ = self.fixture()
        runtime.using_fallback = True
        runtime._speaker_event({'type': 'playing', 'id': 'same-id', 'generation': 1})
        runtime._speaker_event({'type': 'playing', 'id': 'same-id', 'generation': 2})
        runtime._speaker_event({'type': 'idle', 'id': 'same-id', 'generation': 1})
        self.assertTrue(runtime.owned_playback)
        self.assertFalse(runtime._capture_allowed(b'\0\0' * 512, True, None))
        runtime._speaker_event({'type': 'idle', 'id': 'same-id', 'generation': 2})
        self.assertFalse(runtime.owned_playback)

    def test_headset_capture_remains_full_duplex(self):
        runtime, events, captures, played, models, graph, _ = self.fixture(
            prepare=lambda config, graph, models: config['audio'].update(speakerMode=False))
        self.assertFalse(next(event for event in events if event['type'] == 'ready')['speakerMode'])
        runtime._speaker_event({'type': 'playing', 'id': 'readout'})
        self.assertTrue(runtime._capture_allowed(b'\0\0' * 512, True, None))
        self.assertTrue(runtime.listening)


if __name__ == '__main__':
    unittest.main()
