import threading
import time
import unittest

from paj_voice_audio.audio import Capture, Segments, Speaker


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now


class SegmentsTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.events = []
        self.pauses = []
        self.segments = Segments(self.events.append, lambda: self.pauses.append(True),
                                 lambda: 7, self.clock, silence=0.8, maximum=2)

    def feed(self, voiced, advance=0.1):
        self.clock.now += advance
        self.segments.feed(b"\0" * 3200, voiced)

    def test_preroll_and_one_onset_endpoint(self):
        for _ in range(20):
            self.feed(False)
        self.assertLessEqual(self.segments.preroll_bytes, 32000)
        self.feed(True)
        self.feed(True)
        self.feed(False, 0.9)
        self.assertEqual([event["type"] for event in self.events], ["onset", "endpoint"])
        self.assertEqual(self.events[0]["epoch"], 7)
        self.assertEqual(len(self.pauses), 1)
        self.assertGreaterEqual(len(self.events[-1]["pcm"]), 32000)

    def test_truncation_blocks_until_physical_endpoint(self):
        self.feed(True)
        self.feed(True, 2.1)
        for _ in range(5):
            self.feed(True)
        self.assertEqual(len(self.pauses), 1)
        retained = bytes(self.segments.current["pcm"])
        self.assertTrue(retained)
        self.feed(False, 0.9)
        self.assertEqual([event["type"] for event in self.events],
                         ["onset", "truncated", "endpoint"])
        self.assertTrue(self.events[-1]["truncated"])
        self.assertEqual(self.events[-1]["pcm"], retained)
        self.feed(True)
        self.assertEqual(len(self.pauses), 2)

    def test_default_accepts_long_speech_without_chunking(self):
        self.segments = Segments(self.events.append, lambda: self.pauses.append(True),
                                 lambda: 7, self.clock)
        for _ in range(650):
            self.feed(True)
        self.assertEqual([event["type"] for event in self.events], ["onset"])
        self.feed(False, 0.9)
        self.assertEqual([event["type"] for event in self.events], ["onset", "endpoint"])
        self.assertFalse(self.events[-1]["truncated"])
        self.assertEqual(len(self.events[-1]["pcm"]), 651 * 3200)

    def test_retained_prefix_includes_preroll_is_bounded_and_not_extended(self):
        for _ in range(10):
            self.feed(False)
        for _ in range(40):
            self.feed(True)
        retained = bytes(self.segments.current["pcm"])
        self.assertEqual(len(retained), 3 * 32000)
        self.assertEqual([event["type"] for event in self.events], ["onset", "truncated"])
        for _ in range(100):
            self.feed(True)
        self.assertEqual(bytes(self.segments.current["pcm"]), retained)
        self.feed(False, 0.9)
        self.assertEqual(self.events[-1]["pcm"], retained)
        self.assertTrue(self.events[-1]["truncated"])
        self.assertEqual(len(self.events), 3)

    def test_oversized_crossing_frame_is_sliced_to_the_retained_prefix_bound(self):
        self.feed(True)
        self.clock.now += 0.1
        self.segments.feed(b"\1\0" * 100000, True)
        retained = bytes(self.segments.current["pcm"])
        self.assertEqual(retained, b"\0" * 3200 + b"\1\0" * 46400)
        self.assertEqual([event["type"] for event in self.events], ["onset", "truncated"])
        self.feed(False, 0.9)
        self.assertEqual(self.events[-1]["pcm"], retained)

    def test_two_and_a_half_second_pause_keeps_natural_continuations_in_one_turn(self):
        self.segments.silence = 2.5
        self.segments.maximum = 120
        self.feed(True)
        self.feed(False, 2)
        self.feed(True, 0.1)
        self.assertEqual([event['type'] for event in self.events], ['onset'])
        self.feed(False, 2.4)
        self.assertEqual(len(self.events), 1)
        self.feed(False, 0.11)
        self.assertEqual([event['type'] for event in self.events], ['onset', 'endpoint'])
        self.assertFalse(self.events[-1]['truncated'])
        self.assertEqual(len(self.pauses), 1)

    def test_two_second_pause_keeps_short_continuations_and_endpoints_after_two_seconds(self):
        self.segments.silence = 2
        self.segments.maximum = 120
        self.feed(True)
        self.feed(False, 1.5)
        self.feed(True, 0.1)
        self.assertEqual([event['type'] for event in self.events], ['onset'])
        self.feed(False, 1.9)
        self.assertEqual(len(self.events), 1)
        self.feed(False, 0.11)
        self.assertEqual([event['type'] for event in self.events], ['onset', 'endpoint'])
        self.assertFalse(self.events[-1]['truncated'])
        self.assertEqual(len(self.pauses), 1)

    def test_clearing_prompt_preroll_does_not_mint_new_onset(self):
        self.feed(True)
        self.segments.clear_preroll()
        self.feed(True)
        self.assertEqual(len(self.pauses), 1)

    def test_capture_timestamp_is_not_replaced_with_processing_time(self):
        self.clock.now = 1
        self.segments.feed(b"\0\0", True, captured_at=0.5)
        self.assertEqual(self.events[0]["at"], 0.5)

    def test_invalid_capture_frames_and_timestamps_fail_closed(self):
        self.clock.now = 3
        for frame, captured in ((b"", 3), (b"x", 3), (b"\0\0", 4), (b"\0\0", 0)):
            with self.assertRaises(ValueError):
                self.segments.feed(frame, True, captured_at=captured)
        self.assertFalse(self.events)

    def test_close_wipes_memory_and_stops_events(self):
        self.feed(True)
        self.segments.close()
        self.feed(True)
        self.assertEqual(len(self.events), 1)
        self.assertIsNone(self.segments.current)
        self.assertFalse(self.segments.preroll)


class CaptureTests(unittest.TestCase):
    def test_adapter_preserves_frame_receipt_timestamp_without_opening_audio(self):
        received = time.monotonic() - 0.1
        frames = []
        failures = []

        class Vad:
            def __call__(self, pcm):
                return 1

        class Receiver:
            def feed(self, pcm, voiced, captured_at):
                frames.append((pcm, voiced, captured_at))
                capture.closed.set()

        capture = Capture("unused", None, Vad, 0, Receiver(), failures.append)
        capture.frames.put((received, b"\0" * 1024))
        capture._process()
        self.assertFalse(failures)
        self.assertEqual(frames, [(b"\0" * 1024, True, received)])
        self.assertIsNone(capture.child)


class Sink:
    rate = 100

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.aborted = 0
        self.closed = False

    def write(self, pcm, current):
        self.started.set()
        while not self.release.wait(0.005):
            if not current():
                return False
        return current()

    def drain(self, current):
        pass

    def abort(self):
        self.aborted += 1

    def close(self):
        self.closed = True


class SpeakerTests(unittest.TestCase):
    def test_reports_only_owned_completion_after_drain(self):
        sink, events = Sink(), []
        done = threading.Event()

        def emit(event):
            events.append(event)
            if event['type'] == 'played':
                done.set()

        speaker = Speaker(sink, emit)
        try:
            speaker.play(b'\0' * 200, ident='owned')
            self.assertTrue(sink.started.wait(1))
            sink.release.set()
            self.assertTrue(done.wait(1))
            self.assertEqual(events, [{'type': 'played', 'id': 'owned'}])
        finally:
            speaker.close()
        self.assertTrue(sink.closed)
        self.assertFalse(speaker.thread.is_alive())

    def test_cancel_aborts_and_discards_without_a_completed_event(self):
        sink, events = Sink(), []
        speaker = Speaker(sink, events.append)
        try:
            speaker.play(b'\0' * 200, ident='old')
            self.assertTrue(sink.started.wait(1))
            speaker.cancel()
            self.assertIsNone(speaker.active)
            self.assertGreater(sink.aborted, 0)
            sink.release.set()
        finally:
            speaker.close()
        self.assertEqual(events, [])
        self.assertFalse(speaker.thread.is_alive())

    def test_sink_close_failure_still_joins_playback_thread(self):
        sink = Sink()
        speaker = Speaker(sink, lambda event: None)

        def broken_close():
            sink.closed = True
            raise RuntimeError('sink close failed')

        sink.close = broken_close
        with self.assertRaisesRegex(RuntimeError, 'sink close failed'):
            speaker.close()
        self.assertTrue(sink.closed)
        self.assertFalse(speaker.thread.is_alive())


if __name__ == "__main__":
    unittest.main()
