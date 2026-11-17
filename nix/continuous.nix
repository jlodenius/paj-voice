{
  pkgs ? import ./lab-pkgs.nix,
  voiceModels ? {},
}:
assert builtins.length (builtins.attrNames voiceModels) <= 31;
assert builtins.all (name: builtins.match "[a-z][a-z0-9_-]{0,63}" name != null) (builtins.attrNames voiceModels);
let
  manifest = builtins.fromJSON (builtins.readFile ../models/lab-manifest.json);
  assets = builtins.filter (entry:
    pkgs.lib.hasPrefix "stt/" entry.path || pkgs.lib.hasPrefix "tts/" entry.path)
  manifest.assets;
  packagedPath = path: let value = "${path}"; in
    assert pkgs.lib.hasPrefix "${builtins.storeDir}/" value && builtins.hasContext value;
    value;
  voiceCatalog = {
    ljspeech = { label = "LJSpeech — US English"; model = "tts/model.onnx"; config = "tts/model.onnx.json"; };
  } // pkgs.lib.mapAttrs (_: voice: {
    inherit (voice) label;
    model = packagedPath voice.model;
    config = packagedPath voice.config;
  }) voiceModels;
  models = pkgs.runCommand "paj-voice-speech-models" {} ''
    mkdir -p "$out"
    cp ${pkgs.writeText "paj-voice-catalog.json" (builtins.toJSON voiceCatalog)} "$out/voices.json"
    mkdir -p "$out/voice-notices"
    ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (name: voice:
      "ln -s ${pkgs.lib.escapeShellArg (packagedPath voice.notice)} $out/voice-notices/${pkgs.lib.escapeShellArg name}.txt") voiceModels)}
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
