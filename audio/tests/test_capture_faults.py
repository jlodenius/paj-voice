import io
import queue
import time
import types
import unittest
from unittest.mock import Mock, patch

from paj_voice_audio import audio, devices


class CaptureFaultTests(unittest.TestCase):
    def setUp(self):
        for target in ('subprocess.run', 'subprocess.Popen'):
            guard = patch(target, side_effect=AssertionError('Real process forbidden'))
            guard.start()
            self.addCleanup(guard.stop)

    def capture(self, native=False):
        vad = types.SimpleNamespace(chunk_bytes=lambda: 1024)
        capture_type = audio.Capture if native else devices.PipeCapture
        capture = capture_type('/synthetic', devices.Node('synthetic', '1', 'Audio/Source'),
            lambda: vad, 0.001, Mock(), Mock(), launch=Mock())
        capture.child = Mock()
        capture.child.process.poll.return_value = 0
        self.addCleanup(capture.close)
        return capture

    def test_eof_classification_survives_reader_to_health_handoff(self):
        capture = self.capture()
        with patch.object(devices.os, 'read', return_value=b''):
            capture._read()
        with self.assertRaises(devices.CaptureFault) as raised:
            capture.health()
        self.assertEqual(raised.exception.reason, 'capture_eof')

    def test_capture_overflow_is_typed_without_parsing_exception_messages(self):
        capture = self.capture()
        capture.frames = queue.Queue(maxsize=1)
        capture._enqueue(b'\0\0' * 512)
        with self.assertRaises(devices.CaptureFault) as raised:
            capture._enqueue(b'\0\0' * 512)
        self.assertEqual(raised.exception.reason, 'capture_overflow')

    def test_xrun_and_process_exit_have_fixed_source_classification(self):
        for diagnostic, code, reason in ((b'xrun private device sentinel', None, 'capture_discontinuity'),
                                         (b'', 9, 'capture_process_exit')):
            with self.subTest(reason=reason):
                child = devices.Child.__new__(devices.Child)
                child.closed = False
                child.fault = None
                child.fault_reason = 'capture_health_failed'
                child.process = types.SimpleNamespace(stderr=io.BytesIO(diagnostic), poll=lambda: code)
                child._stderr()
                with self.assertRaises(devices.CaptureFault) as raised:
                    child.health()
                self.assertEqual(raised.exception.reason, reason)
                self.assertNotIn('private device sentinel', str(raised.exception))

    def test_stale_queue_and_stall_are_distinct_source_faults(self):
        capture = self.capture()
        capture.frames.put((time.monotonic() - 3, b'\0\0' * 512))
        capture._process()
        error = capture.fail.call_args.args[0]
        self.assertIsInstance(error, devices.CaptureFault)
        self.assertEqual(error.reason, 'capture_stale_queue')
        capture.last_pcm = time.monotonic() - 3
        with self.assertRaises(devices.CaptureFault) as raised:
            capture.health()
        self.assertEqual(raised.exception.reason, 'capture_stall')

    def test_no_pcm_readiness_timeout_is_typed_at_source(self):
        capture = self.capture()
        capture.first_pcm = Mock()
        capture.first_pcm.wait.return_value = False
        capture.health = Mock()
        with patch.object(devices.time, 'monotonic', side_effect=[100.0, 101.0]):
            with self.assertRaises(devices.CaptureFault) as raised:
                capture.wait_ready(timeout=0.1)
        self.assertEqual(raised.exception.reason, 'input_warmup_timeout')

    def test_unknown_processing_exception_gets_generic_fixed_processing_reason(self):
        capture = self.capture()
        capture.vad = Mock(side_effect=ValueError('private processing sentinel'))
        capture.frames.put((time.monotonic(), b'\0\0' * 512))
        capture._process()
        error = capture.fail.call_args.args[0]
        self.assertIsInstance(error, devices.CaptureFault)
        self.assertEqual(error.reason, 'capture_processing_failed')

    def test_actual_native_capture_types_stale_queue_and_processing_errors(self):
        for stale, reason, message in ((True, 'capture_stale_queue', 'Stale capture; trial stopped'),
                                       (False, 'capture_processing_failed', 'private processing sentinel')):
            with self.subTest(reason=reason):
                capture = self.capture(native=True)
                capture.vad = Mock(side_effect=ValueError('private processing sentinel'))
                capture.frames.put((time.monotonic() - (3 if stale else 0), b'\0\0' * 512))
                capture._process()
                error = capture.fail.call_args.args[0]
                self.assertIsInstance(error, devices.CaptureFault)
                self.assertEqual(error.reason, reason)
                self.assertEqual(str(error), message)
                capture.turns.feed.assert_not_called()


if __name__ == '__main__':
    unittest.main()
