import array
import queue
import threading
import types
import unittest
from unittest.mock import patch

from paj_voice_audio import audio, devices
from paj_voice_audio.speech import SpeechInference, Transcription
import test_open_mic

wait_for = test_open_mic.wait_for


class SpeakerSafetyTests(unittest.TestCase):
    def fixture(self, **kwargs):
        for target in ('subprocess.run', 'subprocess.Popen'):
            guard = patch(target, side_effect=AssertionError('Unexpected real process'))
            guard.start()
            self.addCleanup(guard.stop)
        for target, name in ((audio.Capture, '__init__'), (devices.PipeSink, '__init__'),
                             (devices.Graph, 'snapshot'), (SpeechInference, '__init__')):
            guard = patch.object(target, name, side_effect=AssertionError('Unexpected real resource'))
            guard.start()
            self.addCleanup(guard.stop)
        return test_open_mic.OpenMicTests.fixture(self, **kwargs)

    def capture(self, runtime, pcm, voiced, captured_at=None):
        closed = threading.Event()
        capture = audio.Capture.__new__(audio.Capture)
        capture.closed = closed
        capture.frames = queue.Queue()
        capture.frames.put((runtime.clock() if captured_at is None else captured_at, pcm))
        capture.health = lambda: None
        capture.threshold = 0.001
        capture.vad = lambda frame: float(voiced)
        capture.first_pcm = threading.Event()
        def feed(frame, detected, captured_at):
            runtime.gate.feed(frame, detected, captured_at=captured_at)
            closed.set()
        capture.turns = types.SimpleNamespace(feed=feed)
        def fail(error):
            closed.set()
            raise error
        capture.fail = fail
        with patch.object(audio, 'time', types.SimpleNamespace(monotonic=runtime.clock)):
            capture._process()

    def test_startup_cue_echo_is_blocked_on_explicit_speakers_and_fallback(self):
        speech = array.array('h', [1000, -1000] * 256).tobytes()
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                holder, attach, echoed = {}, threading.Event(), threading.Event()
                self.addCleanup(attach.set)
                def write(pcm, current):
                    if not attach.wait(1):
                        raise AssertionError('Synthetic cue fixture did not attach')
                    self.capture(holder['runtime'], speech, True)
                    echoed.set()
                    return current()
                def prepare(config, graph, models):
                    config['audio']['speakerMode'] = not fallback
                    models.transcribe.return_value = Transcription('steering', 1)
                    if fallback:
                        config['audio']['fallback'] = {'name': 'Synthetic', 'input': 'backup-mic',
                                                      'output': 'backup-output'}
                        def bind(source, *args, **kwargs):
                            if source != 'backup-mic':
                                raise RuntimeError('Synthetic preferred route absent')
                            return (devices.Node('backup-mic', '40', 'Audio/Source'),
                                    devices.Node('backup-output', '41', 'Audio/Sink'))
                        graph.bind = bind
                runtime, events, _, _, models, *_ = self.fixture(native_playback=True,
                                                                 write=write, prepare=prepare)
                holder['runtime'] = runtime
                attach.set()
                self.assertTrue(echoed.wait(1))
                wait_for(lambda: not runtime.owned_playback)
                self.assertEqual(runtime.using_fallback, fallback)
                self.assertFalse(runtime.listening)
                self.assertFalse(any(event['type'] == 'addressed' for event in events))
                models.transcribe.assert_not_called()
                runtime.shutdown()

    def test_ready_cue_requires_full_fresh_quiet_after_tail(self):
        runtime, events, *_ = self.fixture(native_playback=True,
            prepare=lambda config, *_: config['audio'].update(speakerMode=True))
        wait_for(lambda: runtime.acoustic_until > 0 and not runtime.owned_playback)
        now = [runtime.acoustic_until + 0.01]
        runtime.clock = runtime.segments.clock = lambda: now[0]
        quiet = b'\0\0' * 512
        self.capture(runtime, quiet, False)
        self.assertFalse(runtime.listening)
        now[0] += 0.79
        self.capture(runtime, quiet, False)
        self.assertFalse(runtime.listening)
        now[0] += 0.02
        self.capture(runtime, quiet, False)
        self.assertTrue(runtime.listening)
        self.assertFalse(any(event['type'] == 'addressed' for event in events))

    def test_input_recovery_does_not_bypass_outstanding_fresh_quiet_guard(self):
        runtime, events, *_ = self.fixture(native_playback=True,
            prepare=lambda config, *_: config['audio'].update(speakerMode=True))
        wait_for(lambda: runtime.acoustic_until > 0 and not runtime.owned_playback)
        now = [runtime.acoustic_until + 0.01]
        runtime.clock = lambda: now[0]
        source = runtime.source
        runtime._suspend(input_lost=True)
        runtime._resume_input(source)
        runtime.segments.clock = runtime.clock
        runtime._arm_recovered_input(source)
        self.assertTrue(runtime.input_available)
        self.assertFalse(runtime.listening)
        quiet = b'\0\0' * 512
        self.capture(runtime, quiet, False)
        self.assertFalse(runtime.listening)
        now[0] += 0.81
        self.capture(runtime, quiet, False)
        self.assertTrue(runtime.listening)
        self.assertFalse(any(event['type'] == 'addressed' for event in events))

    def test_delayed_pcm_from_quiet_rearm_window_cannot_become_a_command(self):
        runtime, events, *_ = self.fixture(native_playback=True,
            prepare=lambda config, *_: config['audio'].update(speakerMode=True))
        wait_for(lambda: runtime.acoustic_until > 0 and not runtime.owned_playback)
        now = [runtime.acoustic_until + 0.01]
        runtime.clock = runtime.segments.clock = lambda: now[0]
        quiet = b'\0\0' * 512
        self.capture(runtime, quiet, False)
        delayed = now[0] + 0.1
        now[0] += 0.9
        self.capture(runtime, quiet, False)
        self.assertTrue(runtime.listening)
        speech = array.array('h', [1000, -1000] * 256).tobytes()
        self.capture(runtime, speech, True, captured_at=delayed)
        self.assertFalse(any(event['type'] == 'addressed' for event in events))
        self.assertIsNone(runtime.segments.current)

    def test_playback_start_fences_inflight_recognition_before_another_capture_frame(self):
        runtime, events, _, _, models, *_ = self.fixture(native_playback=True)
        wait_for(lambda: runtime.speaker.active is None)
        runtime.config['audio']['speakerMode'] = True
        now = [runtime.clock() + 0.01]
        runtime.clock = runtime.segments.clock = lambda: now[0]
        before_playing, allow_playing = threading.Event(), threading.Event()
        decoding, finish_decode = threading.Event(), threading.Event()
        self.addCleanup(allow_playing.set)
        self.addCleanup(finish_decode.set)
        def abort():
            before_playing.set()
            allow_playing.wait(2)
        def transcribe(*args, **kwargs):
            decoding.set()
            finish_decode.wait(2)
            return Transcription('steering', 1)
        runtime.sink.abort = abort
        models.transcribe.side_effect = transcribe
        runtime.command({'type': 'speak', 'id': 'answer', 'text': 'steering', 'key': 'answer'})
        self.assertTrue(before_playing.wait(1))
        speech = array.array('h', [1000, -1000] * 256).tobytes()
        self.capture(runtime, speech, True)
        now[0] += 0.9
        self.capture(runtime, b'\0\0' * 512, False)
        self.assertTrue(decoding.wait(1))
        allow_playing.set()
        wait_for(lambda: any(event['type'] == 'playback_state' and event['id'] == 'answer'
                             and event['playing'] for event in events))
        self.assertFalse(runtime.pending)
        finish_decode.set()
        wait_for(lambda: runtime.busy['recognition'] is None)
        self.assertFalse(any(event['type'] == 'utterance' for event in events))
        cancelled = [event for event in events if event['type'] == 'cancelled']
        self.assertEqual(len(cancelled), 1)
        self.assertEqual(cancelled[0]['reason'], 'capture_paused')
        self.assertIsNone(runtime.segments.current)

    def test_capture_admitted_before_playback_cannot_deliver_a_late_onset(self):
        self.delayed_onset(after_quiet=False)

    def test_capture_admitted_before_playback_stays_stale_after_quiet_rearm(self):
        self.delayed_onset(after_quiet=True)

    def delayed_onset(self, after_quiet):
        runtime, events, _, _, models, *_ = self.fixture(native_playback=True)
        wait_for(lambda: runtime.speaker.active is None)
        runtime.config['audio']['speakerMode'] = True
        now = [runtime.clock() + 0.01]
        runtime.clock = runtime.segments.clock = lambda: now[0]
        admitted, deliver = threading.Event(), threading.Event()
        audible, finish = threading.Event(), threading.Event()
        self.addCleanup(deliver.set)
        self.addCleanup(finish.set)
        segments = runtime.segments
        def feed(pcm, voiced, captured_at):
            admitted.set()
            deliver.wait(2)
            segments.feed(pcm, voiced, captured_at=captured_at)
        runtime.gate.receiver.receiver = types.SimpleNamespace(feed=feed, close=segments.close)
        def write(pcm, current, *, rate):
            audible.set()
            finish.wait(2)
            return current()
        runtime.sink.write = write
        speech = array.array('h', [1000, -1000] * 256).tobytes()
        worker = threading.Thread(target=lambda: self.capture(runtime, speech, True))
        worker.start()
        self.assertTrue(admitted.wait(1))
        runtime.command({'type': 'speak', 'id': 'narration', 'text': 'steering'})
        self.assertTrue(audible.wait(1))
        if after_quiet:
            finish.set()
            wait_for(lambda: not runtime.owned_playback)
            now[0] = runtime.acoustic_until + 0.01
            runtime._capture_allowed(b'\0\0' * 512, False, now[0])
            now[0] += 0.81
            runtime._capture_allowed(b'\0\0' * 512, False, now[0])
            self.assertTrue(runtime.listening)
        deliver.set()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertFalse(any(event['type'] == 'addressed' for event in events))
        self.assertFalse(runtime.pending)
        self.assertFalse(runtime.input_active)
        if not after_quiet:
            self.assertIsNotNone(runtime.speaker.active)
        models.transcribe.assert_not_called()
        if after_quiet:
            runtime.gate.receiver.receiver = segments
            models.transcribe.return_value = Transcription('steering', 1)
            now[0] += 0.01
            self.capture(runtime, speech, True)
            now[0] += 0.9
            self.capture(runtime, b'\0\0' * 512, False)
            wait_for(lambda: any(event['type'] == 'utterance' for event in events))
            self.assertEqual([event['text'] for event in events if event['type'] == 'utterance'],
                             ['steering'])

    def test_steering_feedback_is_blocked_for_every_output_key_but_not_headphone_barge_in(self):
        keys = ['receipt', 'answer', 'progress-status', 'idle-reminder', 'route-notice',
                'paj-arrival', 'completion', 'fallback', 'availability', 'limit-review',
                'terminal-prompt', None]
        speech = array.array('h', [1000, -1000] * 256).tobytes()
        quiet = b'\0\0' * 512
        for speakers in (True, False):
            with self.subTest(speakers=speakers):
                holder = {}
                echoed = threading.Event()
                def write(pcm, current):
                    if 'runtime' in holder:
                        runtime = holder['runtime']
                        self.capture(runtime, speech, True)
                        holder['now'][0] += 0.9
                        self.capture(runtime, quiet, False)
                        echoed.set()
                    return current()
                runtime, events, _, _, models, *_ = self.fixture(native_playback=True, write=write,
                    prepare=lambda config, *_: config['audio'].update(speakerMode=speakers))
                wait_for(lambda: runtime.speaker.active is None and not runtime.owned_playback)
                now = [max(runtime.clock(), runtime.acoustic_until) + 0.01]
                runtime.clock = runtime.segments.clock = lambda: now[0]
                def rearm():
                    now[0] = max(now[0], runtime.acoustic_until) + 0.01
                    self.capture(runtime, quiet, False)
                    if speakers:
                        self.assertFalse(runtime.listening)
                    now[0] += 0.81
                    self.capture(runtime, quiet, False)
                    self.assertTrue(runtime.listening)
                    now[0] += 0.01
                if speakers:
                    rearm()
                holder.update(runtime=runtime, now=now)
                models.transcribe.return_value = Transcription('steering', 1)
                models.synthesize.return_value = speech
                for index, key in enumerate(keys):
                    echoed.clear()
                    ident = f'output-{index}'
                    runtime.command({'type': 'speak', 'id': ident, 'text': 'steering', 'key': key})
                    self.assertTrue(echoed.wait(1))
                    wait_for(lambda: runtime.current_playback is None and not runtime.owned_playback)
                    if speakers:
                        self.assertFalse(any(event['type'] == 'addressed' for event in events))
                        models.transcribe.assert_not_called()
                        captured = now[0]
                        now[0] = runtime.acoustic_until + 0.01
                        self.capture(runtime, speech, True, captured_at=captured)
                        self.assertFalse(runtime.listening)
                        rearm()
                    else:
                        wait_for(lambda: len([event for event in events
                                              if event['type'] == 'utterance']) == index + 1)
                now[0] += 0.1
                self.capture(runtime, speech, True)
                now[0] += 0.9
                self.capture(runtime, quiet, False)
                expected = 1 if speakers else len(keys) + 1
                wait_for(lambda: len([event for event in events
                                     if event['type'] == 'utterance']) == expected)
                utterances = [event for event in events if event['type'] == 'utterance']
                self.assertTrue(all(event['text'] == 'steering' for event in utterances))
                self.assertEqual(models.transcribe.call_count, expected)
                self.assertLessEqual(len(runtime.keys), 256)
                self.assertLessEqual(runtime.jobs.qsize(), 2)
                runtime.shutdown()


if __name__ == '__main__':
    unittest.main()
