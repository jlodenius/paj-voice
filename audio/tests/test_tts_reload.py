import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from paj_voice_audio.open_mic import Runtime
from paj_voice_audio.speech import SpeechOutput, Transcription
from test_open_mic import wait_for


class TtsReloadTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.model = self.root / 'amy.onnx'
        self.metadata = self.root / 'amy.json'
        self.model.touch()
        self.metadata.write_text(json.dumps({'language': {'code': 'en_US'}}))
        (self.root / 'voices.json').write_text(json.dumps({'amy': {
            'label': 'Amy', 'model': self.model.name, 'config': self.metadata.name}}))
        self.enterContext(patch.dict(os.environ, {'PAJ_VOICE_SPEECH_BUNDLE': str(self.root)}))
        self.events = []
        self.runtime = Runtime(self.events.append)
        self.addCleanup(self.runtime.shutdown)
        self.runtime.configured = self.runtime.ready = True
        self.runtime.input_available = self.runtime.output_available = True
        self.runtime.config = {'audio': {}}
        self.capture = self.runtime.capture = Mock(name='capture')
        self.speaker = self.runtime.speaker = Mock(name='speaker')
        self.old_voice = self.voice(22050, b'\x01\x00')
        self.new_voice = self.voice(16000, b'\x02\x00')
        self.models = self.runtime.models = SimpleNamespace(
            output=SpeechOutput(self.old_voice, 22050, 0.4, 1),
            transcribe=Mock(return_value=Transcription('still listening', 1)))
        self.old = self.models.output
        self.load = Mock(return_value=self.new_voice)
        self.enterContext(patch.dict('sys.modules', {'piper': SimpleNamespace(
            PiperVoice=SimpleNamespace(load=self.load), SynthesisConfig=lambda **kwargs: kwargs)}))

    @staticmethod
    def voice(rate, pcm):
        chunk = SimpleNamespace(sample_channels=1, sample_width=2, sample_rate=rate,
                                audio_int16_bytes=pcm)
        return SimpleNamespace(config=SimpleNamespace(sample_rate=rate),
                               synthesize=Mock(return_value=[chunk]))

    def command(self, ident='reload', **overrides):
        tts = {'voice': 'amy', 'volume': 0.2, 'lengthScale': 1.5}
        self.runtime.command({'type': 'reload_tts', 'id': ident, 'tts': {**tts, **overrides}})

    def ack(self, ident='reload', applied=True):
        wait_for(lambda: any(e.get('id') == ident for e in self.events))
        self.assertEqual([e for e in self.events if e.get('id') == ident], [
            {'type': 'tts_reloaded', 'id': ident, 'applied': applied}])

    def block(self, mock):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def blocked(*args, **kwargs):
            entered.set()
            if not release.wait(2):
                raise RuntimeError('Fake operation was never released')
            return mock.return_value

        mock.side_effect = blocked
        return entered, release

    def start_worker(self, worker):
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        def stop():
            self.runtime.shutdown()
            thread.join(1)

        self.addCleanup(stop)

    def test_invalid_settings_and_uninstalled_voice_do_not_load_or_change_output(self):
        for index, overrides in enumerate((
            {'volume': True}, {'volume': '0.2'}, {'volume': -0.1}, {'volume': 1.01},
            {'volume': 10 ** 1000}, {'lengthScale': float('nan')}, {'lengthScale': float('inf')},
            {'lengthScale': 0.49}, {'lengthScale': 2.01}, {'voice': '../path'}, {'voice': 'uninstalled'},
            {'model': str(self.model)},
        )):
            ident = f'invalid-{index}'
            self.command(ident, **overrides)
            self.ack(ident, applied=False)
        self.runtime.command({'type': 'reload_tts', 'id': 'incomplete', 'tts': {'voice': 'amy'}})
        self.ack('incomplete', applied=False)
        self.command('invalid id')
        self.assertFalse(any(e.get('id') == 'invalid id' for e in self.events))
        self.load.assert_not_called()
        self.assertIs(self.models.output, self.old)
        self.assertFalse(self.runtime.closed)

    def test_reload_resolves_implicit_voice_and_retains_requested_speed_on_fallback(self):
        tts = {'volume': 0.4, 'lengthScale': 1 / 1.2}
        self.runtime.command({'type': 'reload_tts', 'id': 'default', 'tts': tts})
        self.ack('default')
        self.load.assert_called_with(str(self.model), config_path=str(self.metadata), use_cuda=False)
        self.assertEqual(self.models.output.length_scale, 1 / 1.2)

        renamed_model = self.model.rename(self.root / 'lj.onnx')
        (self.root / 'voices.json').write_text(json.dumps({'ljspeech': {
            'label': 'LJSpeech', 'model': renamed_model.name, 'config': self.metadata.name}}))
        self.runtime.command({'type': 'reload_tts', 'id': 'fallback', 'tts': tts})
        self.ack('fallback')
        self.load.assert_called_with(str(renamed_model), config_path=str(self.metadata), use_cuda=False)
        self.assertEqual(self.models.output.length_scale, 1 / 1.2)

    def test_candidate_failures_leave_old_output_and_allow_retry(self):
        self.load.side_effect = RuntimeError('Bad ONNX model')
        self.command('broken')
        self.ack('broken', applied=False)
        self.assertIs(self.models.output, self.old)
        self.load.side_effect = None
        self.new_voice.config.sample_rate = 96000
        self.command('bad-rate')
        self.ack('bad-rate', applied=False)
        self.assertIs(self.models.output, self.old)
        self.new_voice.config.sample_rate = 16000
        self.command(volume=0, lengthScale=2)
        self.ack()
        self.assertEqual(self.models.output.synthesize('Updated'), b'\x02\x00')
        self.new_voice.synthesize.assert_called_once_with('Updated', syn_config={
            'volume': 0, 'length_scale': 2})
        self.load.assert_called_with(str(self.model), config_path=str(self.metadata), use_cuda=False)

    def test_expiry_rejects_once_and_fences_late_candidate(self):
        entered, release = self.block(self.load)
        timer = Mock()
        with patch('paj_voice_audio.open_mic.threading.Timer', return_value=timer) as create_timer:
            self.command()
            self.assertTrue(entered.wait(1))
            seconds, expire = create_timer.call_args.args
            self.assertEqual(seconds, 30)
            expire()
            self.ack(applied=False)
            self.command('while-loading')
            self.ack('while-loading', applied=False)
            release.set()
            wait_for(lambda: not self.runtime.tts_reload_inflight)
            expire()
            self.ack(applied=False)
            self.assertIs(self.models.output, self.old)

    def test_one_blocked_candidate_does_not_block_commands_or_recognition(self):
        self.start_worker(self.runtime._recognize)
        entered, release = self.block(self.load)
        returned = threading.Event()

        def command():
            self.command()
            returned.set()

        self.start_worker(command)
        self.assertTrue(entered.wait(1))
        self.assertTrue(returned.wait(1))
        self.command('busy')
        self.ack('busy', applied=False)
        self.runtime.pending.add('heard')
        self.runtime.jobs.put_nowait({'id': 'heard', 'pcm': b'\0\0', 'epoch': self.runtime.epoch,
                                      'truncated': False, 'speech_seconds': 0.1})
        wait_for(lambda: {'type': 'utterance', 'id': 'heard', 'text': 'still listening'} in self.events)
        self.assertIs(self.models.output, self.old)
        release.set()
        self.ack()
        self.load.assert_called_once()
        self.assertEqual(self.capture.mock_calls, [])
        self.assertEqual(self.speaker.mock_calls, [])

    def test_active_synthesis_keeps_snapshot_but_queued_speech_uses_new_output(self):
        self.start_worker(self.runtime._synthesize)
        entered, release = self.block(self.old_voice.synthesize)
        self.runtime.command({'type': 'speak', 'id': 'old', 'text': 'First'})
        self.assertTrue(entered.wait(1))
        self.runtime.command({'type': 'speak', 'id': 'new', 'text': 'Second'})
        self.command()
        self.ack()
        self.assertEqual(self.speaker.mock_calls, [])
        self.new_voice.synthesize.assert_not_called()
        release.set()
        wait_for(lambda: {'type': 'speech_start', 'id': 'old'} in self.events)
        self.speaker.play.assert_called_once_with(b'\x01\x00', ident='old', rate=22050)
        self.command('while-playing')
        self.ack('while-playing')
        self.speaker.cancel.assert_not_called()
        self.speaker.close.assert_not_called()
        self.assertNotIn('speech_end', [e['type'] for e in self.events])
        self.runtime._speaker_event({'type': 'played', 'id': 'old'})
        wait_for(lambda: {'type': 'speech_start', 'id': 'new'} in self.events)
        self.speaker.play.assert_called_with(b'\x02\x00', ident='new', rate=16000)
        self.old_voice.synthesize.assert_called_once_with('First', syn_config={
            'volume': 0.4, 'length_scale': 1})
        self.new_voice.synthesize.assert_called_once_with('Second', syn_config={
            'volume': 0.2, 'length_scale': 1.5})

    def test_route_teardown_fences_pending_publication(self):
        entered, release = self.block(self.load)
        self.command()
        self.assertTrue(entered.wait(1))
        self.runtime._suspend(output_lost=True)
        release.set()
        self.ack(applied=False)
        self.assertIs(self.models.output, self.old)
        self.assertTrue(self.runtime.input_available)
        self.capture.close.assert_not_called()

    def test_shutdown_fences_publication_without_waiting_for_loader(self):
        entered, release = self.block(self.load)
        self.command()
        self.assertTrue(entered.wait(1))
        self.runtime.command({'type': 'shutdown'})
        self.assertTrue(self.runtime.shutdown_complete.is_set())
        release.set()
        wait_for(lambda: not self.runtime.tts_reload_inflight)
        self.assertIs(self.models.output, self.old)
        self.assertNotIn('tts_reloaded', [e['type'] for e in self.events])


if __name__ == '__main__':
    unittest.main()
