{pkgs ? import ./lab-pkgs.nix}: let
  manifest = builtins.fromJSON (builtins.readFile ../models/lab-manifest.json);
  assets = builtins.filter (entry:
    pkgs.lib.hasPrefix "stt/" entry.path || pkgs.lib.hasPrefix "tts/" entry.path)
  manifest.assets;
  models = pkgs.runCommand "paj-voice-speech-models" {} ''
    mkdir -p "$out"
    ${pkgs.lib.concatMapStringsSep "\n" (entry: let
        source = pkgs.fetchurl {
          inherit (entry) url;
          sha256 = entry.sha256;
          name = "paj-voice-" + builtins.replaceStrings ["/"] ["-"] entry.path;
          curlOptsList = ["--no-insecure" "--cacert" "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"];
        };
      in ''
        mkdir -p "$out/$(dirname '${entry.path}')"
        ln -s ${source} "$out/${entry.path}"
      '')
      assets}
    cp ${pkgs.writeText "speech-source.json" (builtins.toJSON {
      inherit (manifest.models) stt tts;
    })} "$out/source.json"
  '';
  ps = pkgs.python313.pkgs;
  piper = (pkgs.piper-tts.override {
    python3Packages = ps;
    withAlignment = false;
    withHTTP = false;
    withJapanese = false;
    withTrain = false;
  }).overrideAttrs {pythonImportsCheck = ["piper"];};
  python = pkgs.python313.withPackages (ps: [
    ps.numpy
    ps.faster-whisper
    ps.pysilero-vad
    (ps.toPythonModule piper)
  ]);
  source = pkgs.lib.cleanSourceWith {
    src = ../audio;
    filter = name: type:
      pkgs.lib.cleanSourceFilter name type
      && builtins.baseNameOf name != "__pycache__"
      && !(pkgs.lib.hasSuffix ".pyc" name);
  };
in
  pkgs.runCommand "paj-voice-continuous-test" {
    nativeBuildInputs = [pkgs.makeWrapper];
    passthru = {inherit python models;};
  } ''
    mkdir -p "$out/bin" "$out/share/paj-voice"
    cp -r ${source} "$out/share/paj-voice/audio"
    ln -s ${models} "$out/share/paj-voice/speech-models"
    makeWrapper ${python}/bin/python "$out/bin/paj-voice-continuous-test" \
      --add-flags "-P -m paj_voice_audio.continuous" \
      --set PYTHONPATH "$out/share/paj-voice/audio" \
      --set PAJ_VOICE_SPEECH_BUNDLE "${models}" \
      --set PYTHONNOUSERSITE 1 \
      --set PYTHONDONTWRITEBYTECODE 1 \
      --set HF_HUB_OFFLINE 1 \
      --set TRANSFORMERS_OFFLINE 1 \
      --set HF_HUB_DISABLE_TELEMETRY 1 \
      --set DO_NOT_TRACK 1 \
      --set TOKENIZERS_PARALLELISM false \
      --set OMP_NUM_THREADS 2 \
      --set OPENBLAS_NUM_THREADS 2 \
      --set MKL_NUM_THREADS 2 \
      --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.pipewire]} \
      --run ${pkgs.lib.escapeShellArg (import ./lab-cache.nix)}
  ''
