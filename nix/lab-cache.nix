''
  paj_voice_project="''${PAJ_VOICE_PROJECT_DIR:-$PWD}"
  if [ ! -f "$paj_voice_project/audio/paj_voice_audio/lab.py" ] \
    || [ ! -f "$paj_voice_project/package.json" ]; then
    printf '%s\n' 'Run from the paj-voice project root or set PAJ_VOICE_PROJECT_DIR to that directory.' >&2
    exit 2
  fi
  if ! paj_voice_project="$(cd -- "$paj_voice_project" && pwd -P)"; then
    printf '%s\n' 'Cannot resolve the paj-voice project directory.' >&2
    exit 2
  fi
  export PAJ_VOICE_PROJECT_DIR="$paj_voice_project"
  export XDG_CACHE_HOME="$PAJ_VOICE_PROJECT_DIR/.cache"
  export HF_HOME="$PAJ_VOICE_PROJECT_DIR/.cache/huggingface"
  unset paj_voice_project
''
