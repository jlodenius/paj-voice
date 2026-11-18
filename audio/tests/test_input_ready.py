import array
import unittest

from paj_voice_audio.input_ready import InputReady

class Receiver:
    def __init__(self):
        self.frames = []
        self.size = 0
        self.closed = False

    def feed(self, pcm, voiced, captured_at=None):
        if not self.closed:
            self.frames.append((pcm, voiced))
            self.size += len(pcm)

    def close(self):
        self.closed = True


class InputReadyTests(unittest.TestCase):
    def setUp(self):
        self.clock = [10.0]
        self.recording = Receiver()
        self.gate = InputReady(self.recording, clock=lambda: self.clock[0])

    def bucket(self, value=0, voiced=False):
        self.gate.feed(array.array("h", [value] * 4000).tobytes(), voiced)

    def healthy(self):
        for _ in range(3):
            self.bucket()

    def test_saturated_dc_and_decay_cannot_become_ready(self):
        for value in (-32768, -32768, -29000, -9600, -2000, -420):
            self.bucket(value)
            self.assertFalse(self.gate.ready.is_set())
        self.assertEqual(self.recording.size, 0)
        self.healthy()
        self.assertTrue(self.gate.ready.is_set())
        summary = self.gate.arm()
        self.assertGreater(summary["discardedClippedSamples"], 0)
        self.assertEqual(summary["maximumBucketAbsMean"], 1)
        self.assertEqual(self.recording.size, 0)

    def test_clean_input_still_requires_three_consecutive_quiet_buckets(self):
        self.bucket()
        self.bucket()
        self.assertFalse(self.gate.ready.is_set())
        self.bucket(1000)
        self.assertFalse(self.gate.ready.is_set())
        self.bucket()
        self.bucket()
        self.assertFalse(self.gate.ready.is_set())
        self.bucket()
        self.assertTrue(self.gate.ready.is_set())

    def test_speech_during_warmup_resets_quiet_requirement(self):
        self.bucket()
        self.bucket(voiced=True)
        self.assertFalse(self.gate.ready.is_set())
        self.healthy()
        self.assertTrue(self.gate.ready.is_set())

    def test_partial_bad_frame_prevents_arm_even_after_previous_readiness(self):
        self.healthy()
        self.gate.feed(array.array("h", [-32768] * 512).tobytes(), False)
        self.assertIsNone(self.gate.arm())
        self.assertFalse(self.gate.ready.is_set())
        self.assertEqual(self.recording.size, 0)
        for _ in range(4):
            self.bucket()
        self.assertIsNotNone(self.gate.arm())

    def test_readiness_lost_before_arm_waits_for_new_stable_windows(self):
        self.healthy()
        self.bucket(1000)
        self.assertIsNone(self.gate.arm())
        self.healthy()
        self.assertIsNotNone(self.gate.arm())
        self.assertEqual(self.recording.size, 0)

    def test_short_noise_frame_is_not_evaluated_as_a_full_quarter_second(self):
        self.healthy()
        self.gate.feed(array.array("h", [500] * 512).tobytes(), False)
        self.assertIsNotNone(self.gate.arm())
        self.assertEqual(self.recording.size, 0)

    def test_large_partial_offset_still_blocks_arming(self):
        self.healthy()
        self.gate.feed(array.array("h", [20000] * 512).tobytes(), False)
        self.assertIsNone(self.gate.arm())
        self.assertEqual(self.recording.size, 0)

    def test_post_ready_speech_is_not_cropped_and_old_queued_audio_is_dropped(self):
        self.healthy()
        self.gate.arm()
        self.gate.feed(b"\1\0" * 512, True, captured_at=9.9)
        self.assertEqual(self.recording.size, 0)
        phrase = b"\0\x08" * 512
        self.clock[0] += 0.1
        self.gate.feed(phrase, True, captured_at=10.1)
        self.assertEqual(self.recording.frames, [(phrase, True)])
        with self.assertRaises(RuntimeError):
            self.gate.arm()

    def test_diagnostics_distinguish_clip_offset_and_vad_without_storing_audio(self):
        self.bucket(-32768)
        self.bucket(1000)
        self.bucket(voiced=True)
        self.healthy()
        report = self.gate.snapshot()
        self.assertEqual(report["discardedSeconds"], 1.5)
        self.assertEqual(report["rejectedBuckets"], {"clipping": 1, "dcOffset": 2, "vadSpeech": 1})
        self.assertEqual(report["buckets"][-1]["stableQuietSeconds"], 0.75)
        self.assertTrue(report["ready"])
        self.assertFalse(any(isinstance(value, bytes) for bucket in report["buckets"] for value in bucket.values()))

    def test_diagnostics_capture_partial_readiness_loss_and_bound_history(self):
        self.healthy()
        self.gate.feed(array.array("h", [0] * 512).tobytes(), True)
        self.assertIsNone(self.gate.arm())
        report = self.gate.snapshot()
        self.assertEqual(report["armRetries"], 1)
        self.assertTrue(report["partialBucket"]["vadSpeech"])
        for _ in range(50):
            self.bucket()
        self.assertEqual(len(self.gate.snapshot()["buckets"]), 24)

    def test_close_blocks_late_frames_and_readiness(self):
        self.healthy()
        self.gate.close()
        self.assertFalse(self.gate.ready.is_set())
        with self.assertRaises(RuntimeError):
            self.gate.arm()
        self.gate.feed(b"\0\0", False)
        self.assertFalse(self.recording.frames)


if __name__ == "__main__":
    unittest.main()
