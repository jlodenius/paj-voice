import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from paj_voice_audio.audio import Speaker
from paj_voice_audio.devices import Node, PipeSink
from paj_voice_audio.speech import SpeechInference


class OutputPipe:
    """Offline transport model, not a measurement of PipeWire or Bluetooth startup."""

    def __init__(self, discard=0):
        read_fd, write_fd = os.pipe()
        os.set_blocking(write_fd, False)
        self.stdin = os.fdopen(write_fd, "wb", buffering=0)
        self.eof = threading.Event()
        self.written = bytearray()
        self.audible = bytearray()
        self.discard = discard
        self.stopped = False
        self.process = SimpleNamespace(stdin=self.stdin, poll=self.poll)
        self.thread = threading.Thread(target=self.read, args=(read_fd,))
        self.thread.start()

    def read(self, fd):
        try:
            while True:
                data = os.read(fd, 514)
                if not data:
                    break
                self.written.extend(data)
                lost = min(self.discard, len(data))
                self.discard -= lost
                self.audible.extend(data[lost:])
        finally:
            os.close(fd)
            self.eof.set()

    def poll(self):
        return 0 if self.eof.is_set() else None

    def health(self, allow_exit=False):
        if self.poll() is not None and not allow_exit:
            raise RuntimeError("Output exited")

    def stop(self):
        self.stopped = True
        self.stdin.close()
        self.thread.join(timeout=1)


class PlaybackTests(unittest.TestCase):
    rate = 22050

    def sink(self, discard=0):
        outputs = []

        def launch(*args):
            output = OutputPipe(discard)
            outputs.append(output)
            return output

        sink = PipeSink("unused", Node("selected", "42", "Audio/Sink"), self.rate,
                        launch=launch)
        self.addCleanup(sink.close)
        return sink, outputs

    def pcm(self):
        return b"\x12\x34\x56\x78" * 5000 + b"\x7f\x01"

    def play(self, sink, pcm):
        done = threading.Event()
        events = []

        def emit(event):
            events.append(event)
            done.set()

        speaker = Speaker(sink, emit)
        self.addCleanup(speaker.close)
        speaker.play(pcm, ident="receipt")
        self.assertTrue(done.wait(2), events)
        self.assertEqual(events, [{"type": "played", "id": "receipt"}])
        self.assertIsNone(sink.child)
        return speaker

    def assert_original(self, transport, original):
        written = bytes(transport.written)
        self.assertTrue(written.endswith(original))
        self.assertEqual(written[:-len(original)], bytes(self.rate * 300 // 1000 * 2))
        self.assertTrue(transport.stopped)
        self.assertFalse(transport.thread.is_alive())

    def test_synthesis_chunks_survive_speaker_write_and_eof_exactly(self):
        original = self.pcm()
        chunks = [original[:14], original[14:5000], original[5000:]]
        inference = SpeechInference.__new__(SpeechInference)
        inference.rate = self.rate
        inference.volume, inference.length_scale = 0.4, 1
        inference.voice = SimpleNamespace(synthesize=lambda *args, **kwargs: [
            SimpleNamespace(sample_channels=1, sample_width=2, sample_rate=self.rate,
                            audio_int16_bytes=chunk) for chunk in chunks
        ])
        with patch.dict("sys.modules", {"piper": SimpleNamespace(SynthesisConfig=lambda **kw: kw)}):
            synthesized = inference.synthesize("Got it.")
        self.assertEqual(synthesized, original)
        sink, outputs = self.sink()
        self.play(sink, synthesized)
        self.assertEqual(len(outputs), 1)
        self.assert_original(outputs[0], original)

    def test_partial_writes_and_multiple_chunks_prime_only_once(self):
        sink, outputs = self.sink()
        original = self.pcm()
        write = os.write
        with patch("paj_voice_audio.devices.os.write",
                   side_effect=lambda fd, data: write(fd, data[:7])):
            self.play(sink, original)
        self.assertEqual(len(outputs), 1)
        self.assert_original(outputs[0], original)

    def test_cancel_during_lead_in_discards_speech_and_next_stream_starts_fresh(self):
        sink, outputs = self.sink()
        write = os.write
        current = [True]

        def cancel(fd, data):
            count = write(fd, data)
            current[0] = False
            sink.abort()
            return count

        with patch("paj_voice_audio.devices.os.write", side_effect=cancel):
            self.assertFalse(sink.write(b"\x12\x34" * 200, lambda: current[0]))
        self.assertIsNone(sink.child)
        self.assertFalse(sink.draining)
        self.assertEqual(bytes(outputs[0].written), bytes(4096))
        self.assertTrue(outputs[0].stopped)
        replacement = b"\x56\x78" * 300
        self.assertTrue(sink.write(replacement, lambda: True))
        sink.drain(lambda: True)
        self.assert_original(outputs[1], replacement)

    def test_cancel_at_drain_eof_does_not_touch_replacement_stream(self):
        sink, outputs = self.sink()
        self.assertTrue(sink.write(self.pcm(), lambda: True))

        def cancel():
            sink.abort()
            return False

        sink.drain(cancel)
        self.assertIsNone(sink.child)
        self.assertFalse(sink.draining)
        self.assertTrue(outputs[0].stopped)
        replacement = b"\x7e\x01" * 400
        self.assertTrue(sink.write(replacement, lambda: True))
        sink.drain(lambda: True)
        self.assert_original(outputs[1], replacement)

    def test_route_close_during_lead_in_never_opens_another_stream(self):
        sink, outputs = self.sink()
        write = os.write

        def close(fd, data):
            count = write(fd, data)
            sink.close()
            return count

        with patch("paj_voice_audio.devices.os.write", side_effect=close):
            self.assertFalse(sink.write(self.pcm(), lambda: True))
        self.assertFalse(sink.write(self.pcm(), lambda: True))
        self.assertEqual(len(outputs), 1)
        self.assertEqual(bytes(outputs[0].written), bytes(4096))
        self.assertTrue(outputs[0].stopped)
        self.assertFalse(outputs[0].thread.is_alive())

    def test_empty_audio_does_not_launch_or_prime(self):
        sink, outputs = self.sink()
        self.assertTrue(sink.write(b"", lambda: True))
        sink.drain(lambda: True)
        self.assertEqual(outputs, [])

    def test_cold_transport_model_preserves_original_onset(self):
        sink, outputs = self.sink(discard=self.rate * 2 // 5)
        original = self.pcm()
        self.play(sink, original)
        self.assertTrue(bytes(outputs[0].audible).endswith(original),
                        "cold fake transport discarded original speech onset")
        self.assert_original(outputs[0], original)


if __name__ == "__main__":
    unittest.main()
