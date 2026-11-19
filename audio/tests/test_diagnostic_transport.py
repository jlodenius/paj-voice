import io
import json
import threading
import unittest

from paj_voice_audio.cli import Protocol
from paj_voice_audio.devices import CaptureFault
import test_availability_diagnostics


class BlockingOutput:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.lines = []
        self.written = threading.Condition()

    def write(self, line):
        with self.written:
            self.lines.append(line)
            self.written.notify_all()
        self.entered.set()
        if not self.release.wait(4):
            raise OSError('Synthetic output gate timed out')

    def flush(self):
        pass

    def wait_frames(self, count):
        with self.written:
            return self.written.wait_for(lambda: len(self.lines) >= count, timeout=1)


class DiagnosticTransportTests(unittest.TestCase):
    fixture = test_availability_diagnostics.AvailabilityDiagnosticTests.fixture

    def blocked_protocol(self):
        output = BlockingOutput()
        protocol = Protocol(output)
        self.addCleanup(protocol.close)
        self.addCleanup(output.release.set)
        protocol.emit({'type': 'retained', 'id': 'in-flight'})
        self.assertTrue(output.entered.wait(1))
        return protocol, output

    def test_diagnostic_cannot_take_last_control_slot_before_capture_teardown(self):
        baseline = None
        for diagnostics in (False, True):
            with self.subTest(diagnostics=diagnostics):
                runtime, _, _, _, _, _, _ = self.fixture()
                protocol, output = self.blocked_protocol()
                capture, gate = runtime.capture, runtime.gate
                self.addCleanup(capture.close)
                self.addCleanup(gate.close)
                for index in range(127):
                    protocol.emit({'type': 'retained', 'id': index})
                def emit(event):
                    if diagnostics or event['type'] != 'availability_diagnostic':
                        protocol.emit(event)
                runtime.emit = emit
                capture.fail(CaptureFault('capture_eof', 'Synthetic EOF'))
                self.assertTrue(capture.closed)
                self.assertIsNone(runtime.capture)
                self.assertFalse(runtime.input_available)
                self.assertTrue(runtime.output_available)
                self.assertEqual(protocol.queue.qsize(), 128)
                output.release.set()
                protocol.close()
                self.assertFalse(protocol.thread.is_alive())
                frames = [json.loads(line) for line in output.lines]
                controls = [frame for frame in frames if frame['type'] != 'availability_diagnostic']
                self.assertEqual(controls[-1]['type'], 'availability')
                if baseline is None:
                    baseline = controls
                else:
                    self.assertEqual(controls, baseline)
                runtime.shutdown()

    def test_diagnostic_overflow_cannot_block_or_reduce_critical_capacity(self):
        protocol, output = self.blocked_protocol()
        finished = threading.Event()
        errors = []
        def fill():
            try:
                for index in range(1000):
                    protocol.emit({'type': 'availability_diagnostic', 'id': index})
                for index in range(128):
                    protocol.emit({'type': 'critical', 'id': index})
                for index in range(1000):
                    protocol.emit({'type': 'availability_diagnostic', 'id': index})
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()
        emitter = threading.Thread(target=fill, daemon=True)
        emitter.start()
        self.assertTrue(finished.wait(1))
        emitter.join(1)
        self.assertFalse(emitter.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(protocol.queue.maxsize, 128)
        self.assertEqual(protocol.queue.qsize(), 128)
        self.assertEqual(protocol.diagnostics.maxsize, 32)
        self.assertEqual(protocol.diagnostics.qsize(), 32)
        self.assertFalse(protocol.failed.is_set())
        with self.assertRaisesRegex(RuntimeError, '^Parent protocol output queue full$'):
            protocol.emit({'type': 'critical', 'id': 'overflow'})
        self.assertEqual(protocol.queue.qsize(), 128)
        output.release.set()
        protocol.close()
        controls = [json.loads(line) for line in output.lines
                    if json.loads(line)['type'] != 'availability_diagnostic']
        self.assertEqual([frame['id'] for frame in controls], ['in-flight', *range(128)])
        self.assertFalse(protocol.thread.is_alive())

    def test_writer_prioritizes_critical_fifo_then_diagnostic_fifo(self):
        protocol, output = self.blocked_protocol()
        for index in ('first', 'second'):
            protocol.emit({'type': 'availability_diagnostic', 'id': index})
        for index in ('control-first', 'control-second'):
            protocol.emit({'type': 'critical', 'id': index})
        output.release.set()
        self.assertTrue(output.wait_frames(5))
        protocol.close()
        self.assertEqual([json.loads(line)['id'] for line in output.lines],
                         ['in-flight', 'control-first', 'control-second', 'first', 'second'])

    def test_idle_writer_is_notified_for_each_queue_without_lost_wakeups(self):
        output = BlockingOutput()
        output.release.set()
        protocol = Protocol(output)
        self.addCleanup(protocol.close)
        for index in range(256):
            kind = 'availability_diagnostic' if index % 2 else 'critical'
            protocol.emit({'type': kind, 'id': index})
            self.assertTrue(output.wait_frames(index + 1))
        protocol.close()
        self.assertFalse(protocol.thread.is_alive())
        self.assertEqual([json.loads(line)['id'] for line in output.lines], list(range(256)))

    def test_close_is_bounded_when_writer_is_blocked_and_drops_only_diagnostics(self):
        protocol, output = self.blocked_protocol()
        for index in range(32):
            protocol.emit({'type': 'availability_diagnostic', 'id': index})
        for index in range(128):
            protocol.emit({'type': 'critical', 'id': index})
        closer = threading.Thread(target=protocol.close, daemon=True)
        closer.start()
        closer.join(1.5)
        self.assertFalse(closer.is_alive())
        self.assertTrue(protocol.thread.is_alive())
        self.assertEqual(protocol.diagnostics.qsize(), 0)
        self.assertEqual(protocol.queue.qsize(), 128)
        protocol.emit({'type': 'availability_diagnostic', 'id': 'after-close'})
        self.assertEqual(protocol.diagnostics.qsize(), 0)
        output.release.set()
        protocol.close()
        self.assertFalse(protocol.thread.is_alive())
        self.assertEqual([json.loads(line)['id'] for line in output.lines],
                         ['in-flight', *range(128)])

    def test_failed_writer_drops_availability_only_and_keeps_critical_failure(self):
        for error_type, kind in ((OSError, 'ready'), (ValueError, 'ready'),
                                 (OSError, 'availability_diagnostic'),
                                 (ValueError, 'availability_diagnostic')):
            with self.subTest(error_type=error_type, kind=kind):
                class Output:
                    def write(self, line):
                        raise error_type('Synthetic writer failure')
                    def flush(self):
                        pass
                protocol = Protocol(Output())
                self.addCleanup(protocol.close)
                protocol.emit({'type': kind})
                self.assertTrue(protocol.failed.wait(1))
                protocol.emit({'type': 'availability_diagnostic'})
                with self.assertRaisesRegex(RuntimeError, '^Parent protocol output closed$'):
                    protocol.emit({'type': 'availability'})
                protocol.close()
                self.assertFalse(protocol.thread.is_alive())
                self.assertEqual(protocol.diagnostics.qsize(), 0)

    def test_only_availability_diagnostics_are_droppable_and_line_errors_stay_critical(self):
        protocol, output = self.blocked_protocol()
        protocol.emit({'type': 'availability_diagnostic', 'payload': 'x' * 65536})
        protocol.emit({'type': 'availability_diagnostic', 'payload': object()})
        self.assertEqual(protocol.diagnostics.qsize(), 0)
        with self.assertRaisesRegex(RuntimeError, '^Parent protocol event exceeds line limit$'):
            protocol.emit({'type': 'diagnostic', 'payload': 'x' * 65536})
        with self.assertRaises(TypeError):
            protocol.emit({'type': 'error', 'payload': object()})
        for index in range(128):
            protocol.emit({'type': 'diagnostic', 'id': index})
        with self.assertRaisesRegex(RuntimeError, 'queue full'):
            protocol.emit({'type': 'diagnostic', 'id': 'overflow'})
        self.assertFalse(protocol.failed.is_set())

    def test_close_wakes_an_idle_writer_without_output(self):
        output = io.StringIO()
        protocol = Protocol(output)
        protocol.close()
        self.assertFalse(protocol.thread.is_alive())
        self.assertEqual(output.getvalue(), '')
        protocol.emit({'type': 'availability_diagnostic'})
        self.assertEqual(protocol.diagnostics.qsize(), 0)

    def test_racing_producers_preserve_every_critical_frame_and_allow_shutdown(self):
        output = BlockingOutput()
        output.release.set()
        protocol = Protocol(output)
        self.addCleanup(protocol.close)
        errors = []
        start = threading.Event()
        def produce(kind, count):
            start.wait(1)
            try:
                for index in range(count):
                    protocol.emit({'type': kind, 'id': index})
            except Exception as error:
                errors.append(error)
        producers = [threading.Thread(target=produce, args=('critical', 128), daemon=True),
                     threading.Thread(target=produce, args=('availability_diagnostic', 1024), daemon=True)]
        for producer in producers:
            producer.start()
        start.set()
        for producer in producers:
            producer.join(1)
            self.assertFalse(producer.is_alive())
        self.assertEqual(errors, [])
        protocol.close()
        self.assertFalse(protocol.thread.is_alive())
        controls = [json.loads(line)['id'] for line in output.lines
                    if json.loads(line)['type'] == 'critical']
        self.assertEqual(controls, list(range(128)))
        self.assertFalse(protocol.failed.is_set())
        self.assertLessEqual(protocol.diagnostics.qsize(), 32)


if __name__ == '__main__':
    unittest.main()
