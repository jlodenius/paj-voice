import math
import time
import unittest
from unittest.mock import Mock, patch

from paj_voice_audio import audio, devices, open_mic, speech
import test_open_mic


class AvailabilityDiagnosticTests(unittest.TestCase):
    def fixture(self):
        for target in ('subprocess.run', 'subprocess.Popen'):
            guard = patch(target, side_effect=AssertionError('Real process forbidden'))
            guard.start()
            self.addCleanup(guard.stop)
        for target, name in ((audio.Capture, '__init__'), (devices.PipeSink, '__init__'),
                             (devices.Graph, 'snapshot'), (speech.SpeechInference, '__init__')):
            guard = patch.object(target, name, side_effect=AssertionError('Real resource forbidden'))
            guard.start()
            self.addCleanup(guard.stop)
        result = test_open_mic.OpenMicTests.fixture(self, clock=lambda: 100.0)
        self.now = 100.0
        result[0].clock = lambda: self.now
        return result

    def diagnostics(self, events):
        result = [event for event in events if event['type'] == 'availability_diagnostic']
        for event in result:
            self.assertEqual(set(event), {'type', 'v', 'reason', 'inputPresent', 'outputPresent',
                                         'inputChanged', 'outputChanged', 'pcmAgeMs', 'recoveryCount'})
            self.assertEqual(event['v'], 1)
            self.assertIn(event['reason'], {
                'graph_query_failed', 'source_unresolved', 'source_changed', 'target_unresolved',
                'target_changed', 'capture_eof', 'capture_stall', 'capture_stale_queue',
                'capture_overflow', 'capture_discontinuity', 'capture_process_exit',
                'capture_dc_corruption', 'capture_processing_failed', 'capture_health_failed',
                'input_warmup_timeout', 'input_recovered', 'output_recovered', 'output_health_failed'})
            for key in ('inputPresent', 'outputPresent', 'inputChanged', 'outputChanged'):
                self.assertTrue(event[key] is None or type(event[key]) is bool)
            self.assertTrue(event['pcmAgeMs'] is None or
                            type(event['pcmAgeMs']) is int and 0 <= event['pcmAgeMs'] <= 60000)
            self.assertIs(type(event['recoveryCount']), int)
            self.assertTrue(0 <= event['recoveryCount'] <= 2147483647)
        return result

    def test_graph_failure_is_unknown_then_same_selected_pair_recovers(self):
        runtime, events, captures, _, _, graph, _ = self.fixture()
        frozen = runtime.frozen
        graph.recover.side_effect = RuntimeError('private diagnostic sentinel')
        runtime._health_tick()
        diagnostics = self.diagnostics(events)
        self.assertEqual(diagnostics, [{
            'type': 'availability_diagnostic', 'v': 1, 'reason': 'graph_query_failed',
            'inputPresent': None, 'outputPresent': None, 'inputChanged': None,
            'outputChanged': None, 'pcmAgeMs': None, 'recoveryCount': 0}])
        self.assertFalse(runtime.input_available)
        self.assertFalse(runtime.output_available)
        graph.recover.side_effect = None
        graph.recover.return_value = frozen
        runtime._health_tick()
        self.assertTrue(runtime.input_available)
        self.assertTrue(runtime.output_available)
        recovered = self.diagnostics(events)[1:]
        self.assertEqual([event['reason'] for event in recovered],
                         ['output_recovered', 'input_recovered'])
        self.assertEqual([event['recoveryCount'] for event in recovered], [1, 2])
        for event in recovered:
            self.assertEqual([event[key] for key in
                              ('inputPresent', 'outputPresent', 'inputChanged', 'outputChanged')],
                             [True, True, False, False])
        self.assertEqual(len(captures), 2)
        self.assertNotIn('private diagnostic sentinel', str(self.diagnostics(events)))

    def test_capture_health_fault_with_same_pair_is_not_reported_as_endpoint_loss(self):
        runtime, events, captures, _, _, graph, _ = self.fixture()
        capture = runtime.capture
        capture.last_pcm = 99.75
        capture.health = Mock(side_effect=RuntimeError('private device exception'))
        runtime._health_tick()
        self.assertFalse(runtime.input_available)
        self.assertTrue(runtime.output_available)
        self.assertEqual(self.diagnostics(events), [{
            'type': 'availability_diagnostic', 'v': 1, 'reason': 'capture_health_failed',
            'inputPresent': True, 'outputPresent': True, 'inputChanged': False,
            'outputChanged': False, 'pcmAgeMs': 250, 'recoveryCount': 0}])
        runtime._health_tick()
        recovered = self.diagnostics(events)[-1]
        self.assertEqual(recovered['reason'], 'input_recovered')
        self.assertEqual(recovered['recoveryCount'], 1)
        self.assertTrue(runtime.input_available)
        self.assertEqual(len(captures), 2)
        self.assertNotIn('private device exception', str(self.diagnostics(events)))

    def test_target_only_loss_keeps_capture_and_reports_unresolved_not_physical_absence(self):
        runtime, events, captures, _, _, graph, _ = self.fixture()
        source, target = runtime.frozen
        capture, epoch = runtime.capture, runtime.epoch
        graph.recover.side_effect = None
        graph.recover.return_value = (source, None)
        runtime._health_tick()
        self.assertTrue(runtime.input_available)
        self.assertFalse(runtime.output_available)
        self.assertIs(runtime.capture, capture)
        self.assertEqual(runtime.epoch, epoch)
        self.assertEqual(self.diagnostics(events), [{
            'type': 'availability_diagnostic', 'v': 1, 'reason': 'target_unresolved',
            'inputPresent': True, 'outputPresent': False, 'inputChanged': False,
            'outputChanged': None, 'pcmAgeMs': None, 'recoveryCount': 0}])
        graph.recover.return_value = (source, target)
        runtime._health_tick()
        diagnostic = self.diagnostics(events)[-1]
        self.assertEqual(diagnostic['reason'], 'output_recovered')
        self.assertEqual(diagnostic['recoveryCount'], 1)
        self.assertEqual(len(captures), 1)
        self.assertIs(runtime.capture, capture)

    def test_dc_corruption_is_classified_at_capture_source_before_teardown(self):
        runtime, events, _, _, _, graph, _ = self.fixture()
        runtime._health_tick()
        capture = runtime.capture
        with self.assertRaises(devices.CaptureFault) as raised:
            runtime.gate.feed(b'\xff\x7f' * 512, False)
        capture.fail(raised.exception)
        diagnostic = self.diagnostics(events)[-1]
        self.assertEqual(diagnostic['reason'], 'capture_dc_corruption')
        self.assertEqual(diagnostic['inputPresent'], True)
        self.assertEqual(diagnostic['outputPresent'], True)
        self.assertFalse(runtime.input_available)
        self.assertTrue(runtime.output_available)
        self.assertTrue(capture.closed)

    def test_capture_callback_keeps_last_known_binding_without_a_new_graph_query(self):
        runtime, events, _, _, _, graph, _ = self.fixture()
        capture = runtime.capture
        capture.fail(devices.CaptureFault('capture_eof', 'private sentinel'))
        event = self.diagnostics(events)[-1]
        self.assertEqual(event['reason'], 'capture_eof')
        self.assertEqual([event[key] for key in
                          ('inputPresent', 'outputPresent', 'inputChanged', 'outputChanged')],
                         [True, True, False, False])
        graph.recover.assert_not_called()

    def test_pcm_age_and_global_recovery_counter_are_bounded_across_new_captures(self):
        runtime, events, _, _, _, graph, _ = self.fixture()
        for index, (last_pcm, age) in enumerate(((99.75, 250), (200.0, 0), (-1e308, 60000),
                                                (math.nan, None), (math.inf, None), (None, None))):
            capture = runtime.capture
            capture.last_pcm = last_pcm
            capture.fail(devices.CaptureFault('capture_health_failed', 'private sentinel'))
            event = self.diagnostics(events)[-1]
            self.assertEqual(event['pcmAgeMs'], age)
            self.assertEqual(event['recoveryCount'], index)
            runtime._health_tick()
            self.assertEqual(self.diagnostics(events)[-1]['recoveryCount'], index + 1)
        runtime.recovery_count = 2147483647
        runtime.capture.fail(devices.CaptureFault('capture_health_failed', ''))
        runtime._health_tick()
        self.assertEqual(self.diagnostics(events)[-1]['recoveryCount'], 2147483647)

    def test_warmup_timeout_is_diagnostic_before_existing_fail_closed_shutdown(self):
        runtime, events, _, _, _, graph, _ = self.fixture()
        source = runtime.source
        runtime._suspend(input_lost=True)
        runtime._resume_input(source)
        runtime.ready = False
        runtime.gate.ready.clear()
        def health():
            self.now += 6
        runtime.capture.health = health
        runtime._warmup(runtime.capture, runtime.gate, runtime.epoch)
        self.assertTrue(runtime.closed)
        diagnostic = self.diagnostics(events)[-1]
        self.assertEqual(diagnostic['reason'], 'input_warmup_timeout')
        self.assertEqual(diagnostic['recoveryCount'], 0)

    def test_resolved_replacements_and_unresolved_sources_have_distinct_flags(self):
        for reason in ('source_unresolved', 'source_changed', 'target_changed'):
            with self.subTest(reason=reason):
                runtime, events, _, _, _, graph, _ = self.fixture()
                source, target = runtime.frozen
                if reason == 'source_unresolved':
                    source = None
                elif reason == 'source_changed':
                    source = devices.Node(source.name, '100', source.kind)
                else:
                    target = devices.Node(target.name, '101', target.kind)
                graph.recover.side_effect = None
                graph.recover.return_value = (source, target)
                runtime._health_tick()
                event = self.diagnostics(events)[0]
                self.assertEqual(event['reason'], reason)
                self.assertEqual(event['inputPresent'], source is not None)
                self.assertEqual(event['inputChanged'],
                                 None if source is None else reason == 'source_changed')
                self.assertEqual(event['outputPresent'], True)
                self.assertEqual(event['outputChanged'], reason == 'target_changed')
                runtime.shutdown()

    def test_obsolete_muted_and_stopped_capture_callbacks_add_no_diagnostics(self):
        runtime, events, _, _, _, graph, _ = self.fixture()
        capture = runtime.capture
        error = RuntimeError('private sentinel capture_eof')
        error.reason = 'capture_eof'
        capture.fail(error)
        self.assertEqual(self.diagnostics(events)[-1]['reason'], 'capture_health_failed')
        runtime._health_tick()
        count = len(self.diagnostics(events))
        capture.fail(devices.CaptureFault('capture_process_exit', 'private sentinel'))
        self.assertEqual(len(self.diagnostics(events)), count)
        current = runtime.capture
        runtime._mute()
        current.fail(error)
        self.assertEqual(len(self.diagnostics(events)), count)
        runtime.shutdown()
        current.fail(error)
        self.assertEqual(len(self.diagnostics(events)), count)

    def test_successful_configured_fallback_binding_updates_previously_unknown_flags(self):
        runtime, events, _, _, _, graph, _ = self.fixture()
        runtime.config['audio']['fallback'] = {'name': 'Synthetic', 'input': 'backup-in',
                                              'output': 'backup-out'}
        graph.bind = Mock(return_value=(devices.Node('backup-in', '40', 'Audio/Source'),
                                       devices.Node('backup-out', '41', 'Audio/Sink')))
        graph.recover.side_effect = RuntimeError('private graph sentinel')
        runtime._health_tick()
        diagnostics = self.diagnostics(events)
        self.assertEqual(diagnostics[0]['reason'], 'graph_query_failed')
        self.assertTrue(runtime.using_fallback)
        self.assertEqual([event['reason'] for event in diagnostics[1:]],
                         ['output_recovered', 'input_recovered'])
        for event in diagnostics[1:]:
            self.assertEqual([event[key] for key in
                              ('inputPresent', 'outputPresent', 'inputChanged', 'outputChanged')],
                             [True, True, False, False])

    def test_current_sink_health_failure_is_distinct_from_capture_and_endpoint_loss(self):
        runtime, events, captures, _, _, graph, _ = self.fixture()
        runtime._health_tick()
        capture, sink, epoch = runtime.capture, runtime.sink, runtime.output_epoch
        sink.health = Mock(side_effect=devices.CaptureFault('capture_process_exit', 'private sink sentinel'))
        runtime._health_tick(next_graph=101)
        self.assertIs(runtime.capture, capture)
        self.assertTrue(runtime.input_available)
        self.assertFalse(runtime.output_available)
        self.assertTrue(sink.closed)
        self.assertGreater(runtime.output_epoch, epoch)
        self.assertEqual(self.diagnostics(events), [{
            'type': 'availability_diagnostic', 'v': 1, 'reason': 'output_health_failed',
            'inputPresent': True, 'outputPresent': True, 'inputChanged': False,
            'outputChanged': False, 'pcmAgeMs': None, 'recoveryCount': 0}])
        runtime._health_tick()
        self.assertTrue(runtime.output_available)
        self.assertEqual(self.diagnostics(events)[-1]['reason'], 'output_recovered')
        self.assertEqual(self.diagnostics(events)[-1]['recoveryCount'], 1)
        self.assertEqual(len(captures), 1)

    def test_diagnostic_emit_failure_cannot_change_graph_or_capture_privacy_recovery(self):
        for fault in ('graph', 'capture'):
            baseline = None
            for failing_observer in (None, BrokenPipeError, ValueError):
                with self.subTest(fault=fault, failing_observer=failing_observer):
                    runtime, events, _, _, _, graph, _ = self.fixture()
                    source, target = runtime.frozen
                    capture, sink = runtime.capture, runtime.sink
                    runtime.gate.feed(b'\0\0' * 512, True)
                    self.assertTrue(runtime.pending)
                    def emit(event):
                        if failing_observer and event['type'] == 'availability_diagnostic':
                            raise failing_observer('synthetic diagnostic observer failure')
                        events.append(event)
                    runtime.emit = emit
                    if fault == 'graph':
                        graph.recover.side_effect = OSError('synthetic query failure')
                    else:
                        capture.health = Mock(side_effect=OSError('synthetic capture failure'))
                    runtime._health_tick()
                    self.assertTrue(capture.closed)
                    self.assertFalse(runtime.pending)
                    self.assertFalse(runtime.input_available)
                    self.assertEqual(runtime.output_available, fault != 'graph')
                    self.assertEqual(sink.closed, fault == 'graph')
                    graph.recover.side_effect = None
                    graph.recover.return_value = (source, target)
                    runtime._health_tick()
                    self.assertTrue(runtime.input_available)
                    self.assertTrue(runtime.output_available)
                    self.assertIsNot(runtime.capture, capture)
                    self.assertEqual(runtime.recovery_count, 2 if fault == 'graph' else 1)
                    controls = [event for event in events if event['type'] != 'availability_diagnostic']
                    if baseline is None:
                        baseline = controls
                    else:
                        self.assertEqual(controls, baseline)
                    runtime.shutdown()

    def test_age_extraction_and_invalid_clock_are_only_observational(self):
        for fault in ('age_getter', 'clock_raises', 'clock_invalid', 'clock_infinite', 'clock_nan'):
            with self.subTest(fault=fault):
                runtime, events, _, _, _, graph, _ = self.fixture()
                capture = runtime.capture
                runtime.gate.feed(b'\0\0' * 512, True)
                capture.last_pcm = 99.75
                def raises(*args):
                    raise OSError('synthetic age observer failure')
                if fault == 'clock_raises':
                    runtime.clock = raises
                elif fault.startswith('clock_'):
                    value = {'clock_invalid': None, 'clock_infinite': math.inf,
                             'clock_nan': math.nan}[fault]
                    runtime.clock = lambda: value
                error = devices.CaptureFault('capture_eof', 'synthetic EOF')
                if fault == 'age_getter':
                    with patch.object(type(capture), 'last_pcm', property(raises), create=True):
                        capture.fail(error)
                else:
                    capture.fail(error)
                self.assertTrue(capture.closed)
                self.assertFalse(runtime.input_available)
                self.assertFalse(runtime.pending)
                self.assertTrue(runtime.output_available)
                self.assertEqual(self.diagnostics(events)[-1]['pcmAgeMs'], None)
                self.assertEqual(self.diagnostics(events)[-1]['reason'], 'capture_eof')
                runtime.clock = lambda: self.now
                runtime._health_tick()
                self.assertTrue(runtime.input_available)
                self.assertEqual(runtime.recovery_count, 1)
                runtime.shutdown()

    def test_actual_native_processing_fault_reaches_runtime_diagnostic_and_recovery(self):
        for reason in ('capture_stale_queue', 'capture_processing_failed', 'capture_dc_corruption'):
            with self.subTest(reason=reason):
                runtime, events, _, _, _, graph, _ = self.fixture()
                previous = runtime.capture
                native = audio.Capture.__new__(audio.Capture)
                vad = Mock(return_value=1)
                if reason == 'capture_processing_failed':
                    vad.side_effect = ValueError('private native processing sentinel')
                devices.PipeCapture.__init__(native, '/synthetic', runtime.source, lambda: vad,
                    0.001, runtime.gate, previous.fail, launch=Mock())
                native.child = Mock()
                native.child.process.poll.return_value = 0
                previous.close()
                runtime.capture = native
                age = 3 if reason == 'capture_stale_queue' else 0
                pcm = b'\xff\x7f' * 512 if reason == 'capture_dc_corruption' else b'\0\0' * 512
                native.frames.put((time.monotonic() - age, pcm))
                native._process()
                self.assertTrue(native.closed.is_set())
                self.assertFalse(runtime.input_available)
                self.assertTrue(runtime.output_available)
                event = self.diagnostics(events)[-1]
                self.assertEqual(event['reason'], reason)
                self.assertEqual(event['inputPresent'], True)
                self.assertEqual(event['outputPresent'], True)
                self.assertNotIn('private native processing sentinel', str(self.diagnostics(events)))
                runtime._health_tick()
                self.assertTrue(runtime.input_available)
                self.assertEqual(runtime.recovery_count, 1)
                runtime.shutdown()

    def test_obsolete_muted_and_closed_sink_faults_cannot_emit_output_failure(self):
        for state in ('replaced', 'muted', 'closed'):
            with self.subTest(state=state):
                runtime, events, _, _, _, graph, _ = self.fixture()
                runtime._health_tick()
                sink, target = runtime.sink, runtime.target
                def health():
                    if state == 'replaced':
                        runtime._suspend(output_lost=True)
                        runtime._resume_output(target)
                    elif state == 'muted':
                        runtime._mute()
                    else:
                        runtime.shutdown()
                    raise OSError('private obsolete sink sentinel')
                sink.health = health
                runtime._health_tick(next_graph=101)
                self.assertFalse(any(event['reason'] == 'output_health_failed'
                                     for event in self.diagnostics(events)))
                if state == 'replaced':
                    self.assertTrue(runtime.output_available)
                    self.assertIsNot(runtime.sink, sink)
                elif state == 'muted':
                    self.assertTrue(runtime.muted)
                else:
                    self.assertTrue(runtime.closed)
                runtime.shutdown()


if __name__ == '__main__':
    unittest.main()
