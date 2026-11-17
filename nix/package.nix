{
  lib,
  stdenvNoCC,
  makeWrapper,
  pipewire,
  nodejs,
  python3,
  voiceModels ? {},
}: let
  speech = import ./continuous.nix {
    inherit voiceModels;
    pkgs = import (import ./lab-source.nix) {
      system = stdenvNoCC.hostPlatform.system;
      config = {
        allowUnfree = false;
        cudaSupport = false;
      };
    };
  };
  python = speech.python;
in
  stdenvNoCC.mkDerivation {
    pname = "paj-voice";
    version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
    src = lib.cleanSourceWith {
      src = ../.;
      filter = name: type: let
        base = builtins.baseNameOf name;
      in
        lib.cleanSourceFilter name type
        && !(builtins.elem base ["__pycache__" ".venv" ".cache" "node_modules" "build" "dist" "result"])
        && !(lib.hasPrefix "result-" base)
        && !(lib.hasSuffix ".pyc" name);
    };
    nativeBuildInputs = [makeWrapper];
    nativeCheckInputs = [nodejs python3];
    passthru = {
      inherit python;
      models = speech.models;
    };
    dontConfigure = true;
    dontBuild = true;
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      export HOME="$TMPDIR/home"
      export PYTHONDONTWRITEBYTECODE=1
      export PYTHONPATH="$PWD/audio"
      mkdir -p "$HOME"
      node --test --test-concurrency=2 tests/*.test.js
      python3 -m unittest discover -s audio/tests -v
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/share/paj-voice" "$out/bin"
      cp -r extensions src audio examples package.json pyproject.toml README.md LICENSE "$out/share/paj-voice/"
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
