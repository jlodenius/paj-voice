import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from paj_voice_audio.open_mic import validate
from paj_voice_audio.speech import SpeechOutput
from paj_voice_audio.voices import installed_voices


class VoicePreferencesTests(unittest.TestCase):
    def test_named_voice_resolves_only_packaged_assets_and_preserves_synthesis_controls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'stt').mkdir()
            for name in ('model.bin', 'config.json', 'tokenizer.json'):
                (root / 'stt' / name).touch()
            (root / 'model.onnx').touch()
            (root / 'model.json').write_text(json.dumps({'language': {'code': 'en_US'}}))
            (root / 'voices.json').write_text(json.dumps({'test_voice': {
                'label': 'Test voice', 'model': 'model.onnx', 'config': 'model.json'}}))
            settings = {'version': 1, 'cacheDir': str(root / 'cache'),
                        'tts': {'voice': 'test_voice', 'volume': 0.25, 'lengthScale': 0.5},
                        'audio': {'input': 'laptop', 'output': 'headphones', 'echoCancellation': 'none'}}
            with patch.dict(os.environ, {'PAJ_VOICE_SPEECH_BUNDLE': str(root)}):
                config = validate(settings)
                self.assertEqual(config['tts']['model'], str(root / 'model.onnx'))
                self.assertEqual(config['tts']['volume'], 0.25)
                self.assertEqual(config['tts']['lengthScale'], 0.5)
                with self.assertRaisesRegex(ValueError, 'not installed'):
                    validate({**settings, 'tts': {'voice': 'missing'}})
            catalog = installed_voices(root)
            self.assertEqual(catalog['test_voice']['label'], 'Test voice')
            (root / 'voices.json').write_text(json.dumps({'test_voice': {
                'label': 'Test voice', 'model': '../outside', 'config': 'model.json'}}))
            with self.assertRaises(ValueError):
                installed_voices(root)

    def test_implicit_voice_prefers_amy_then_falls_back_without_changing_explicit_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'stt').mkdir()
            for name in ('model.bin', 'config.json', 'tokenizer.json'):
                (root / 'stt' / name).touch()
            catalog = {}
            for ident in ('amy', 'ljspeech', 'custom'):
                model, metadata = f'{ident}.onnx', f'{ident}.json'
                (root / model).touch()
                (root / metadata).write_text(json.dumps({'language': {'code': 'en_US'}}))
                catalog[ident] = {'label': ident, 'model': model, 'config': metadata}
            index = root / 'voices.json'
            index.write_text(json.dumps(catalog))
            settings = {'version': 1, 'cacheDir': str(root / 'cache'),
                        'audio': {'input': 'laptop', 'output': 'headphones', 'echoCancellation': 'none'}}
            with patch.dict(os.environ, {'PAJ_VOICE_SPEECH_BUNDLE': str(root)}):
                default = validate(settings)['tts']
                self.assertEqual(default['model'], str(root / 'amy.onnx'))
                self.assertEqual(default['lengthScale'], 1 / 1.2)
                for ident in ('ljspeech', 'custom'):
                    selected = validate({**settings, 'tts': {'voice': ident, 'lengthScale': 1}})['tts']
                    self.assertEqual(selected['model'], str(root / f'{ident}.onnx'))
                    self.assertEqual(selected['lengthScale'], 1)
                (root / 'amy.onnx').unlink()
                fallback = validate(settings)['tts']
                self.assertEqual(fallback['model'], str(root / 'ljspeech.onnx'))
                self.assertEqual(fallback['lengthScale'], 1 / 1.2)
                with self.assertRaisesRegex(ValueError, 'Missing local speech asset'):
                    validate({**settings, 'tts': {'voice': 'amy'}})
                del catalog['amy']
                index.write_text(json.dumps(catalog))
                self.assertEqual(validate(settings)['tts']['model'], str(root / 'ljspeech.onnx'))
                with self.assertRaisesRegex(ValueError, 'not installed'):
                    validate({**settings, 'tts': {'voice': 'amy'}})
                del catalog['ljspeech']
                index.write_text(json.dumps(catalog))
                with self.assertRaisesRegex(ValueError, 'select an installed voice'):
                    validate(settings)

    def test_user_volume_and_speed_reach_piper_without_opening_audio(self):
        configs = []
        chunk = types.SimpleNamespace(sample_channels=1, sample_width=2,
                                      sample_rate=16000, audio_int16_bytes=b'\0\0')
        def synthesize(text, syn_config):
            configs.append(syn_config)
            return [chunk]
        models = SpeechOutput(types.SimpleNamespace(synthesize=synthesize), 16000, 0.25, 0.5)
        with patch.dict('sys.modules', {'piper': types.SimpleNamespace(
                SynthesisConfig=lambda **kwargs: kwargs)}):
            self.assertEqual(models.synthesize('A short answer.'), b'\0\0')
        self.assertEqual(configs, [{'volume': 0.25, 'length_scale': 0.5}])


if __name__ == '__main__':
    unittest.main()
