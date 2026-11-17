import json
from pathlib import Path
import re


def installed_voices(root):
    root = Path(root)
    source = root / 'voices.json'
    if source.stat().st_size > 65536:
        raise ValueError('Packaged voice catalogue is too large')
    catalog = json.loads(source.read_text())
    if not isinstance(catalog, dict) or not 1 <= len(catalog) <= 32:
        raise ValueError('Invalid packaged voice catalogue')
    result = {}
    for ident, entry in catalog.items():
        if (not isinstance(ident, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', ident)
                or not isinstance(entry, dict) or set(entry) != {'label', 'model', 'config'}):
            raise ValueError('Invalid packaged voice entry')
        label = entry['label']
        if (not isinstance(label, str) or not label.strip() or len(label) > 160
                or any(ord(ch) < 32 or 127 <= ord(ch) <= 159 for ch in label)):
            raise ValueError('Invalid packaged voice label')
        paths = {}
        for key in ('model', 'config'):
            path = entry[key]
            if not isinstance(path, str) or not path or '..' in Path(path).parts:
                raise ValueError('Invalid packaged voice path')
            paths[key] = str(Path(path) if Path(path).is_absolute() else root / path)
        result[ident] = {'label': label, **paths}
    return result
