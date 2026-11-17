import threading
import time
import unittest

from paj_voice_audio.lab_audio import LabCapture, Segments, Speaker


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
        self.assertEqual(self.segments.current["pcm"], bytearray())
        self.feed(False, 0.9)
        self.assertEqual([event["type"] for event in self.events],
                         ["onset", "truncated", "endpoint"])
        self.assertTrue(self.events[-1]["truncated"])
        self.assertFalse(self.events[-1]["pcm"])
        self.feed(True)
        self.assertEqual(len(self.pauses), 2)

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

        capture = LabCapture("unused", None, Vad, 0, Receiver(), failures.append)
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
    def test_pause_resume_preserves_demo_and_reports_only_owned_completion(self):
        sink, events = Sink(), []
        done = threading.Event()

        def emit(event):
            events.append(event)
            if event["type"] == "played":
                done.set()

        speaker = Speaker(sink, emit)
        try:
            speaker.play(b"\0" * 200, "demo")
            self.assertTrue(sink.started.wait(1))
            speaker.pause()
            self.assertIsNone(speaker.active)
            self.assertIsNotNone(speaker.saved)
            self.assertEqual(events[0]["type"], "paused")
            speaker.resume()
            sink.release.set()
            self.assertTrue(done.wait(1))
            self.assertEqual(events[-1]["kind"], "demo")
        finally:
            speaker.close()
        self.assertTrue(sink.closed)
        self.assertFalse(speaker.thread.is_alive())

    def test_question_is_not_interrupted_by_its_own_capture(self):
        sink = Sink()
        speaker = Speaker(sink, lambda event: None)
        try:
            speaker.play(b"\0" * 100, "prompt", "owned", 9)
            self.assertTrue(sink.started.wait(1))
            speaker.pause()
            self.assertEqual(speaker.active["id"], "owned")
            self.assertIsNone(speaker.saved)
        finally:
            speaker.close()

    def test_sink_close_failure_still_joins_playback_thread(self):
        sink = Sink()
        speaker = Speaker(sink, lambda event: None)

        def broken_close():
            sink.closed = True
            raise RuntimeError("sink close failed")

        sink.close = broken_close
        with self.assertRaisesRegex(RuntimeError, "sink close failed"):
            speaker.close()
        self.assertTrue(sink.closed)
        self.assertFalse(speaker.thread.is_alive())

    def test_discard_prevents_later_resume(self):
        sink = Sink()
        speaker = Speaker(sink, lambda event: None)
        try:
            speaker.play(b"\0" * 100, "demo")
            self.assertTrue(sink.started.wait(1))
            speaker.pause()
            speaker.discard()
            speaker.resume()
            self.assertIsNone(speaker.active)
            self.assertIsNone(speaker.saved)
        finally:
            speaker.close()


if __name__ == "__main__":
    unittest.main()
