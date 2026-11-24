{
  pkgs ? import ./pkgs.nix {},
  voiceModels ? {},
}:
assert builtins.all (name: builtins.match "[a-z][a-z0-9_-]{0,63}" name != null) (builtins.attrNames voiceModels);
let
  manifest = builtins.fromJSON (builtins.readFile ../models/manifest.json);
  assets = manifest.assets;
  packagedPath = path: let value = "${path}"; in
    assert pkgs.lib.hasPrefix "${builtins.storeDir}/" value && builtins.hasContext value;
    value;
  voiceCatalog = {
    ljspeech = { label = "LJSpeech — US English"; model = "tts/model.onnx"; config = "tts/model.onnx.json"; };
    amy = { label = "Amy — US English (medium)"; model = "tts/amy/model.onnx"; config = "tts/amy/model.onnx.json"; };
  } // pkgs.lib.mapAttrs (_: voice: {
    inherit (voice) label;
    model = packagedPath voice.model;
    config = packagedPath voice.config;
  }) voiceModels;
  assetsForCatalog = builtins.filter
    (entry: !(voiceModels ? amy)
      || (!(pkgs.lib.hasPrefix "tts/amy/" entry.path) && entry.path != "voice-notices/amy.txt"))
    assets;
  sources = removeAttrs manifest.models (pkgs.lib.optional (voiceModels ? amy) "amy");
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
      assetsForCatalog}
    cp ${pkgs.writeText "speech-source.json" (builtins.toJSON sources)} "$out/source.json"
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
in
assert builtins.length (builtins.attrNames voiceCatalog) <= 32;
{
  inherit python models;
}
