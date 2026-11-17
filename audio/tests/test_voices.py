import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from paj_voice_audio.open_mic import validate
from paj_voice_audio.speech import SpeechInference
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

    def test_user_volume_and_speed_reach_piper_without_opening_audio(self):
        configs = []
        chunk = types.SimpleNamespace(sample_channels=1, sample_width=2,
                                      sample_rate=16000, audio_int16_bytes=b'\0\0')
        def synthesize(text, syn_config):
            configs.append(syn_config)
            return [chunk]
        models = SpeechInference.__new__(SpeechInference)
        models.voice = types.SimpleNamespace(synthesize=synthesize)
        models.rate, models.volume, models.length_scale = 16000, 0.25, 0.5
        with patch.dict('sys.modules', {'piper': types.SimpleNamespace(
                SynthesisConfig=lambda **kwargs: kwargs)}):
            self.assertEqual(models.synthesize('A short answer.'), b'\0\0')
        self.assertEqual(configs, [{'volume': 0.25, 'length_scale': 0.5}])


if __name__ == '__main__':
    unittest.main()
