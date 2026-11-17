{pkgs ? import ./lab-pkgs.nix}: let
  manifest = builtins.fromJSON (builtins.readFile ../models/lab-manifest.json);
  assets = builtins.filter (entry: pkgs.lib.hasPrefix "stt/" entry.path) manifest.assets;
  model = pkgs.runCommand "paj-voice-stt-model" {} ''
    mkdir -p "$out"
    ${pkgs.lib.concatMapStringsSep "\n" (entry: let
        source = pkgs.fetchurl {
          inherit (entry) url;
          sha256 = entry.sha256;
          name = "paj-voice-" + builtins.replaceStrings ["/"] ["-"] entry.path;
          curlOptsList = ["--no-insecure" "--cacert" "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"];
        };
      in ''
        ln -s ${source} "$out/${builtins.baseNameOf entry.path}"
      '')
      assets}
    cp ${pkgs.writeText "whisper-source.json" (builtins.toJSON manifest.models.stt)} "$out/source.json"
  '';
  python = pkgs.python313.withPackages (ps: [ps.numpy ps.faster-whisper ps.pysilero-vad]);
  source = pkgs.lib.cleanSourceWith {
    src = ../audio;
    filter = name: type:
      pkgs.lib.cleanSourceFilter name type
      && builtins.baseNameOf name != "__pycache__"
      && !(pkgs.lib.hasSuffix ".pyc" name);
  };
in
  pkgs.runCommand "paj-voice-stt-eval" {
    nativeBuildInputs = [pkgs.makeWrapper];
    passthru = {inherit model python;};
  } ''
    mkdir -p "$out/bin" "$out/share/paj-voice"
    cp -r ${source} "$out/share/paj-voice/audio"
    ln -s ${model} "$out/share/paj-voice/stt-model"
    makeWrapper ${python}/bin/python "$out/bin/paj-voice-stt-eval" \
      --add-flags "-P -m paj_voice_audio.stt_eval" \
      --set PYTHONPATH "$out/share/paj-voice/audio" \
      --set PAJ_VOICE_STT_MODEL "${model}" \
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
