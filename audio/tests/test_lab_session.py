import unittest

from paj_voice_audio.lab_session import (
    AdmissionSession,
    CAPTURE_SECONDS,
    MAX_TEXT,
    PROMPT_SECONDS,
    QUESTION,
    RECOGNITION_SECONDS,
)


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakePlayback:
    def __init__(self):
        self.paused = True
        self.resumed = False
        self.prompts = []
        self.admitted = []

    def apply(self, effects):
        for effect in effects:
            if effect["type"] == "resume":
                self.resumed = True
                self.paused = False
            elif effect["type"] == "prompt":
                self.prompts.append(effect)
            elif effect["type"] == "admit":
                self.admitted.append(effect["text"])


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.session = AdmissionSession(self.clock)
        self.session.arm()

    def turn(self, text="original instruction", decision="uncertain"):
        token = self.session.onset(self.session.epoch)
        self.assertIsNotNone(token)
        self.assertEqual(self.session.end(token), [])
        return self.session.submit(token, text, decision)

    def prompt(self):
        effects = self.turn()
        self.assertEqual(len(effects), 1)
        self.assertEqual(effects[0]["type"], "prompt")
        self.assertEqual(effects[0]["text"], QUESTION)
        return effects[0]

    def drain(self, prompt):
        self.assertEqual(
            self.session.prompt_complete(prompt["id"], prompt["epoch"], True), []
        )
        self.clock.advance(0.01)

    def assert_discard(self, effects, reason=None):
        self.assertEqual([effect["type"] for effect in effects], ["discard", "resume"])
        if reason is not None:
            self.assertEqual(effects[0]["reason"], reason)
        self.assertEqual(self.session.phase, "listening")
        self.assertIsNone(self.session._held)

    def test_off_and_old_capture_epoch_cannot_start(self):
        session = AdmissionSession(self.clock)
        self.assertIsNone(session.onset(session.epoch))
        old = self.session.epoch
        self.session.reset()
        self.assertIsNone(self.session.onset(old))
        self.assertIsNotNone(self.session.onset(self.session.epoch))

    def test_accept_once_preserves_original_text_and_does_not_resume(self):
        text = "  Please check the tests.  "
        token = self.session.onset(self.session.epoch)
        epoch = self.session.epoch
        self.session.end(token)
        self.assertEqual(self.session.submit(token, text, "accept"), [
            {"type": "admit", "text": text}
        ])
        self.assertEqual(self.session.submit(token, text, "accept"), [])
        self.assertGreater(self.session.epoch, epoch)

    def test_reject_and_unknown_decisions_fail_closed(self):
        for decision in ("reject", "ACCEPT", "invalid", None):
            with self.subTest(decision=decision):
                self.assert_discard(self.turn(decision=decision), "rejected")

    def test_uncertain_never_contains_held_text_or_admits_before_drain(self):
        prompt = self.prompt()
        self.assertNotIn("original instruction", str(prompt))
        self.assertNotIn("original instruction", repr(self.session))
        self.assertEqual(self.session.phase, "prompt")
        self.assertEqual(self.session.prompt_complete(999, prompt["epoch"], True), [])
        self.assertEqual(self.session.phase, "prompt")

    def test_exact_affirmatives_admit_held_original_not_answer(self):
        for answer in ("yes", "YES!", "  Of course. ", "That was for you!", "Yes?!"):
            with self.subTest(answer=answer):
                self.session.arm()
                prompt = self.prompt()
                self.drain(prompt)
                self.assertEqual(self.turn(answer, "reject"), [
                    {"type": "admit", "text": "original instruction"}
                ])

    def test_every_other_confirmation_discards_without_reclassification(self):
        for answer in (
            "no", "yes but do not send it", '"yes"', "“yes”", "'yes'",
            "I said yes", QUESTION, "send another command", "yesterday", "y e s",
            "yes yes", "", " ", "yes\nnot really", "of courses",
        ):
            with self.subTest(answer=answer):
                self.session.arm()
                prompt = self.prompt()
                self.drain(prompt)
                effects = self.turn(answer, "accept")
                self.assert_discard(effects)
                self.assertFalse(any(effect["type"] == "prompt" for effect in effects))

    def test_delayed_prompt_speech_cannot_become_confirmation_after_drain(self):
        prompt = self.prompt()
        self.clock.advance(0.5)
        captured_at = self.clock()
        self.clock.advance(0.5)
        self.drain(prompt)
        token = self.session.onset(self.session.epoch, captured_at=captured_at)
        self.assertIsNotNone(token)
        self.assertEqual(self.session.phase, "confirming")
        self.session.end(token)
        self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.assertEqual(self.turn("yes"), [
            {"type": "admit", "text": "original instruction"}
        ])

    def test_delayed_onset_at_drain_boundary_never_authorizes(self):
        prompt = self.prompt()
        self.session.prompt_complete(prompt["id"], prompt["epoch"], True)
        captured_at = self.clock()
        self.clock.advance(1)
        token = self.session.onset(self.session.epoch, captured_at)
        self.session.end(token)
        self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.assertEqual(self.session.phase, "confirming")

    def test_invalid_future_and_pre_epoch_timestamps_are_rejected(self):
        old_stamp = self.clock()
        self.clock.advance(1)
        self.session.reset()
        for stamp in (
            old_stamp, self.clock() + 0.001, float("nan"),
            float("inf"), float("-inf"), "invalid",
        ):
            with self.subTest(stamp=stamp):
                self.assertIsNone(self.session.onset(self.session.epoch, stamp))
                self.assertEqual(self.session.phase, "listening")
        self.assertIsNotNone(self.session.onset(self.session.epoch, self.clock()))

    def test_timestamp_before_latest_admission_epoch_cannot_start_new_turn(self):
        old_stamp = self.clock()
        token = self.session.onset(self.session.epoch, old_stamp)
        self.session.end(token)
        self.clock.advance(1)
        self.session.submit(token, "original", "accept")
        self.assertIsNone(self.session.onset(self.session.epoch, old_stamp))

    def test_delayed_capture_deadline_uses_original_timestamp(self):
        captured_at = self.clock()
        self.clock.advance(20)
        token = self.session.onset(self.session.epoch, captured_at)
        self.assertIsNotNone(token)
        self.clock.advance(10)
        self.assert_discard(self.session.end(token), "timeout")
        self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.assertIsNone(self.session.onset(self.session.epoch, captured_at))

    def test_explicit_confirmation_timestamp_allows_bounded_delayed_asr(self):
        self.drain(self.prompt())
        self.clock.advance(5)
        captured_at = self.clock()
        self.clock.advance(0.5)
        token = self.session.onset(self.session.epoch, captured_at)
        self.assertIsNotNone(token)
        self.clock.advance(10)
        self.session.end(token)
        self.clock.advance(9)
        self.assertEqual(self.session.submit(token, "yes", "reject"), [
            {"type": "admit", "text": "original instruction"}
        ])

    def test_off_and_failure_reset_never_resume_paused_playback(self):
        for action in (self.session.off, self.session.reset, self.session.arm):
            for phase in ("capturing", "recognizing", "prompt", "confirming"):
                with self.subTest(action=action.__name__, phase=phase):
                    self.session.arm()
                    if phase in ("capturing", "recognizing"):
                        token = self.session.onset(self.session.epoch)
                        if phase == "recognizing":
                            self.session.end(token)
                    else:
                        prompt = self.prompt()
                        if phase == "confirming":
                            self.drain(prompt)
                    playback = FakePlayback()
                    effects = action()
                    playback.apply(effects)
                    self.assertEqual([effect["type"] for effect in effects], ["discard"])
                    self.assertFalse(playback.resumed)
                    self.assertIsNone(self.session._held)

    def test_endpoint_required_and_duplicate_endpoint_does_not_extend_deadline(self):
        token = self.session.onset(self.session.epoch)
        self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.session.end(token)
        self.clock.advance(RECOGNITION_SECONDS - 1)
        self.session.end(token)
        self.clock.advance(1)
        self.assert_discard(self.session.submit(token, "yes", "accept"), "timeout")

    def test_overlapping_turn_cannot_mint_authority(self):
        token = self.session.onset(self.session.epoch)
        self.assertIsNone(self.session.onset(self.session.epoch))
        self.assertEqual(self.session.end(object()), [])
        self.assertEqual(self.session.submit(object(), "attack", "accept"), [])
        self.session.end(token)
        self.assertIsNone(self.session.onset(self.session.epoch))
        self.assertEqual(self.session.submit(token, "original", "accept"), [
            {"type": "admit", "text": "original"}
        ])

    def test_own_prompt_capture_stays_blocked_through_tail(self):
        prompt = self.prompt()
        token = self.session.onset(self.session.epoch)
        self.assertIsNotNone(token)
        self.drain(prompt)
        self.assertIsNone(self.session.onset(self.session.epoch))
        self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.assertEqual(self.session.end(token), [])
        self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.assertEqual(self.turn("yes", "reject"), [
            {"type": "admit", "text": "original instruction"}
        ])

    def test_onset_exactly_at_prompt_drain_is_not_confirmation(self):
        prompt = self.prompt()
        self.session.prompt_complete(prompt["id"], prompt["epoch"], True)
        token = self.session.onset(self.session.epoch)
        self.clock.advance(0.1)
        self.session.end(token)
        self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.assertEqual(self.session.phase, "confirming")

    def test_duplicate_and_foreign_prompt_completion_cannot_extend_or_rearm(self):
        prompt = self.prompt()
        self.assertEqual(self.session.prompt_complete(prompt["id"], -1, True), [])
        self.drain(prompt)
        self.clock.advance(5)
        self.assertEqual(self.session.prompt_complete(prompt["id"], prompt["epoch"], True), [])
        self.clock.advance(1)
        self.assert_discard(self.session.tick(), "timeout")
        self.assertEqual(self.session.prompt_complete(prompt["id"], prompt["epoch"], True), [])
        self.assertEqual(self.session.phase, "listening")

    def test_prompt_failure_or_timeout_wipes_held_text(self):
        for failure in (True, False):
            with self.subTest(failure=failure):
                self.session.arm()
                prompt = self.prompt()
                if failure:
                    effects = self.session.prompt_complete(prompt["id"], prompt["epoch"], False)
                else:
                    self.clock.advance(PROMPT_SECONDS)
                    effects = self.session.tick()
                self.assert_discard(effects)
                self.assertEqual(self.session.prompt_complete(prompt["id"], prompt["epoch"], True), [])

    def test_silence_and_late_onset_timeout(self):
        prompt = self.prompt()
        self.drain(prompt)
        epoch = self.session.epoch
        self.clock.advance(6)
        self.assertIsNone(self.session.onset(epoch))
        self.assert_discard(self.session.tick(), "timeout")
        self.assertIsNone(self.session.onset(epoch))

    def test_timely_confirmation_onset_survives_late_endpoint_and_stt(self):
        prompt = self.prompt()
        self.drain(prompt)
        self.clock.advance(5.8)
        token = self.session.onset(self.session.epoch)
        self.clock.advance(20)
        self.assertEqual(self.session.tick(), [])
        self.session.end(token)
        self.clock.advance(9.9)
        self.assertEqual(self.session.submit(token, "yes", "uncertain"), [
            {"type": "admit", "text": "original instruction"}
        ])

    def test_capture_and_recognition_budgets_are_bounded(self):
        for confirmation in (False, True):
            for endpoint in (False, True):
                with self.subTest(confirmation=confirmation, endpoint=endpoint):
                    self.session.arm()
                    if confirmation:
                        self.drain(self.prompt())
                    token = self.session.onset(self.session.epoch)
                    if endpoint:
                        self.session.end(token)
                    self.clock.advance(RECOGNITION_SECONDS if endpoint else CAPTURE_SECONDS)
                    self.assert_discard(self.session.tick(), "timeout")
                    self.assertEqual(self.session.submit(token, "yes", "accept"), [])

    def test_off_reset_and_rearm_invalidate_all_owned_callbacks(self):
        for action in (self.session.off, self.session.reset, self.session.arm):
            with self.subTest(action=action.__name__):
                self.session.arm()
                prompt = self.prompt()
                blocked = self.session.onset(self.session.epoch)
                epoch = self.session.epoch
                effects = action()
                self.assertEqual([effect["type"] for effect in effects], ["discard"])
                self.assertIsNone(self.session._held)
                self.assertGreater(self.session.epoch, epoch)
                self.assertEqual(self.session.end(blocked), [])
                self.assertEqual(self.session.submit(blocked, "yes", "accept"), [])
                self.assertEqual(self.session.prompt_complete(prompt["id"], prompt["epoch"], True), [])
                self.assertIsNone(self.session.onset(epoch))

    def test_delayed_candidate_and_confirmation_results_after_off_are_inert(self):
        for confirmation in (False, True):
            with self.subTest(confirmation=confirmation):
                self.session.arm()
                if confirmation:
                    self.drain(self.prompt())
                token = self.session.onset(self.session.epoch)
                self.session.end(token)
                self.session.off()
                self.session.arm()
                self.assertEqual(self.session.submit(token, "yes", "accept"), [])
                self.assertIsNone(self.session._held)

    def test_old_prompt_cannot_complete_new_prompt(self):
        first = self.prompt()
        self.session.reset()
        second = self.prompt()
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(self.session.prompt_complete(first["id"], second["epoch"], True), [])
        self.assertEqual(self.session.phase, "prompt")
        self.drain(second)
        self.assertEqual(self.turn("no", "accept")[0]["type"], "discard")

    def test_prompt_playback_with_multiple_speech_endpoints_never_admits(self):
        prompt = self.prompt()
        for _ in range(3):
            token = self.session.onset(self.session.epoch)
            self.assertIsNotNone(token)
            self.session.end(token)
            self.assertEqual(self.session.submit(token, "yes", "accept"), [])
        self.assertEqual(self.session.phase, "prompt")
        self.drain(prompt)
        self.assertEqual(self.turn("yes"), [
            {"type": "admit", "text": "original instruction"}
        ])

    def test_invalid_and_bounded_text_never_leak_in_effects(self):
        for text in (None, "", " ", "secret" * MAX_TEXT, 3):
            with self.subTest(kind=type(text).__name__):
                effects = self.turn(text, "accept")
                self.assert_discard(effects, "invalid_text")
                self.assertNotIn("secret", str(effects))
        self.assertEqual(self.turn("a" * MAX_TEXT, "accept"), [
            {"type": "admit", "text": "a" * MAX_TEXT}
        ])

    def test_paused_playback_resumes_only_on_discard(self):
        playback = FakePlayback()
        playback.apply(self.turn(decision="reject"))
        self.assertTrue(playback.resumed)
        playback = FakePlayback()
        playback.apply(self.turn(decision="accept"))
        self.assertFalse(playback.resumed)
        playback = FakePlayback()
        prompt = self.prompt()
        playback.apply([prompt])
        self.assertTrue(playback.paused)
        self.assertEqual(playback.admitted, [])
        self.drain(prompt)
        playback.apply(self.turn("yes"))
        self.assertFalse(playback.resumed)
        self.assertEqual(playback.admitted, ["original instruction"])

    def test_invalid_confirmation_window_is_rejected(self):
        for duration in (0, -1, float("inf"), float("nan")):
            with self.subTest(duration=duration):
                with self.assertRaises(ValueError):
                    AdmissionSession(self.clock, duration)


if __name__ == "__main__":
    unittest.main()
