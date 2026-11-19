{
  lib,
  stdenv,
  pkg-config,
  makeWrapper,
  fetchNpmDeps,
  npmHooks,
  pipewire,
  nodejs,
  python3,
  voiceModels ? {},
}: let
  speech = import ./speech.nix {
    inherit voiceModels;
    pkgs = import ./pkgs.nix {system = stdenv.hostPlatform.system;};
  };
  python = speech.python;
  source = lib.cleanSourceWith {
    src = ../.;
    filter = name: type: let
      base = builtins.baseNameOf name;
    in
      lib.cleanSourceFilter name type
      && !(builtins.elem base ["__pycache__" ".venv" ".cache" "node_modules" "build" "dist" "result"])
      && !(lib.hasPrefix "result-" base)
      && !(lib.hasSuffix ".pyc" name);
  };
in
  stdenv.mkDerivation {
    pname = "paj-voice";
    version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
    src = source;
    npmDeps = fetchNpmDeps {
      src = source;
      hash = "sha256-CcSp1qqxEb0v2QYyj2XOKGz0HfrIOddSIbwTqtl6GXg=";
    };
    npmFlags = ["--ignore-scripts"];
    nativeBuildInputs = [makeWrapper nodejs npmHooks.npmConfigHook pkg-config];
    buildInputs = [pipewire];
    nativeCheckInputs = [python3];
    passthru = {
      inherit python;
      models = speech.models;
    };
    configurePhase = ''
      runHook preConfigure
      runHook postConfigure
    '';
    buildPhase = ''
      runHook preBuild
      node scripts/build.ts
      $CC -Wall -Wextra -Werror -O2 audio/focus-control.c \
        $(pkg-config --cflags --libs libpipewire-0.3) -lm -o paj-voice-focus-control
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      export HOME="$TMPDIR/home"
      export PYTHONDONTWRITEBYTECODE=1
      export PYTHONPATH="$PWD/audio"
      mkdir -p "$HOME"
      ./paj-voice-focus-control --self-test
      $CC -Wall -Wextra -Werror -O2 audio/tests/focus-control-events.c \
        $(pkg-config --cflags --libs libpipewire-0.3) -lm -o focus-control-events
      ./focus-control-events
      npm run typecheck
      node --test --test-concurrency=2 tests/*.test.js
      python3 -m unittest discover -s audio/tests -v
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/share/paj-voice/audio" "$out/bin" "$out/libexec"
      cp -r extensions dist examples docs package.json README.md LICENSE "$out/share/paj-voice/"
      cp -r audio/paj_voice_audio "$out/share/paj-voice/audio/"
      install -m755 paj-voice-focus-control "$out/bin/paj-voice-focus-control"
      ln -s ${pipewire}/bin/pw-dump "$out/libexec/paj-voice-pw-dump"
      ln -s ${speech.models} "$out/share/paj-voice/models"
      makeWrapper ${python}/bin/python "$out/bin/paj-voice-audio" \
        --add-flags "-P -m paj_voice_audio" \
        --set PYTHONPATH "$out/share/paj-voice/audio" \
        --prefix PATH : ${lib.makeBinPath [pipewire]} \
        --set PAJ_VOICE_SPEECH_BUNDLE "${speech.models}" \
        --set PYTHONNOUSERSITE 1 \
        --set PYTHONDONTWRITEBYTECODE 1 \
        --set HF_HUB_OFFLINE 1 \
        --set TRANSFORMERS_OFFLINE 1 \
        --set HF_HUB_DISABLE_TELEMETRY 1 \
        --set DO_NOT_TRACK 1 \
        --set TOKENIZERS_PARALLELISM false \
        --set OMP_NUM_THREADS 2 \
        --set OPENBLAS_NUM_THREADS 2 \
        --set MKL_NUM_THREADS 2
      runHook postInstall
    '';
    meta = {
      description = "Explicitly armed continuous open-mic voice conversations with Pi";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
      mainProgram = "paj-voice-audio";
    };
  }
