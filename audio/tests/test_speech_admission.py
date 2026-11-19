import types
import unittest
from unittest.mock import Mock

from paj_voice_audio.speech import SpeechInference


class Samples:
    def astype(self, _dtype):
        return self

    def __truediv__(self, _scale):
        return self


class SpeechAdmissionTests(unittest.TestCase):
    def inference(self, text, *, no_speech=0.01, logprob=-0.1):
        inference = SpeechInference.__new__(SpeechInference)
        inference.np = types.SimpleNamespace(frombuffer=lambda *args, **kwargs: Samples(), float32=object())
        segment = types.SimpleNamespace(text=text, no_speech_prob=no_speech, avg_logprob=logprob)
        inference.whisper = types.SimpleNamespace(transcribe=Mock(return_value=(iter([segment]), None)))
        return inference

    def test_short_noise_cannot_expand_into_an_actionable_repeated_acknowledgement(self):
        inference = self.inference(" Okay." * 25)
        result = inference.transcribe(b"\0\0" * (16000 * 4), speech_seconds=1)
        self.assertEqual(result.text, "")
        self.assertEqual(result.rejected_reason, "implausible_repetition")

    def test_unreliable_non_speech_decoder_output_is_rejected_not_rewritten(self):
        inference = self.inference("Please delete the project.", no_speech=0.95, logprob=-1.4)
        result = inference.transcribe(b"\0\0" * 16000, speech_seconds=0.25)
        self.assertEqual(result.text, "")
        self.assertEqual(result.rejected_reason, "non_speech")

    def test_short_answers_and_plausible_intentional_repetition_are_preserved_verbatim(self):
        for text, seconds in [('Yes.', 0.15), ('No.', 0.15), ('Okay.', 0.3),
                              ('Yes, yes, yes!', 0.7), (' Okay.' * 25, 6),
                              (' Check the logs.' * 8, 5)]:
            with self.subTest(text=text[:30]):
                inference = self.inference(text, no_speech=0.95, logprob=-0.1)
                result = inference.transcribe(b'\0\0' * int(16000 * (seconds + 3)),
                                              speech_seconds=seconds)
                self.assertEqual(result.text, text.strip())
                self.assertIsNone(result.rejected_reason)

    def test_long_dictation_is_not_rejected_merely_for_repeating_a_phrase(self):
        for seconds in (25, 45, 120):
            with self.subTest(seconds=seconds):
                text = ' Check the logs.' * seconds
                result = self.inference(text).transcribe(b'\0\0' * (16000 * seconds),
                                                        speech_seconds=seconds)
                self.assertEqual(result.text, text.strip())
                self.assertIsNone(result.rejected_reason)

    def test_repeated_multiword_decoder_loop_on_short_noise_is_rejected(self):
        result = self.inference(' Check the logs.' * 8).transcribe(b'\0\0' * (16000 * 4),
                                                                speech_seconds=1)
        self.assertEqual(result.text, '')
        self.assertEqual(result.rejected_reason, 'implausible_repetition')

    def test_repetition_rate_boundary_preserves_plausible_text_and_rejects_expansion(self):
        for count, rejected in [(8, False), (9, True)]:
            with self.subTest(count=count):
                text = ' Okay.' * count
                result = self.inference(text).transcribe(b'\0\0' * (16000 * 4), speech_seconds=0.75)
                self.assertEqual(result.text, '' if rejected else text.strip())
                self.assertEqual(result.rejected_reason, 'implausible_repetition' if rejected else None)

    def test_punctuation_only_noise_is_not_an_actionable_transcript(self):
        result = self.inference('... ! ...').transcribe(b'\0\0' * 16000, speech_seconds=0.2)
        self.assertEqual(result.text, '')
        self.assertEqual(result.rejected_reason, 'non_speech')


if __name__ == '__main__':
    unittest.main()
