{
  pkgs ? import ./lab-pkgs.nix,
  classifier ? "gliclass",
}: let
  python = import ./lab-python.nix {inherit pkgs;};
  models = import ./models.nix {inherit pkgs classifier;};
  source = pkgs.lib.cleanSourceWith {
    src = ../audio;
    filter = name: type:
      pkgs.lib.cleanSourceFilter name type
      && builtins.baseNameOf name != "__pycache__"
      && !(pkgs.lib.hasSuffix ".pyc" name);
  };
in
  pkgs.runCommand "paj-voice-lab" {
    nativeBuildInputs = [pkgs.makeWrapper];
    passthru = {inherit python models;};
    meta = {
      description = "Experimental commands-disabled local voice lab with pinned models";
      platforms = pkgs.lib.platforms.linux;
      mainProgram = "paj-voice-lab";
    };
  } ''
    mkdir -p "$out/bin" "$out/share/paj-voice"
    cp -r ${source} "$out/share/paj-voice/audio"
    ln -s ${models}/share/paj-voice-models "$out/share/paj-voice-models"
    makeWrapper ${python}/bin/python "$out/bin/paj-voice-lab" \
      --add-flags "-P -m paj_voice_audio.lab" \
      --set PYTHONPATH "$out/share/paj-voice/audio" \
      --set PAJ_VOICE_CLASSIFIER ${pkgs.lib.escapeShellArg classifier} \
      --set PAJ_VOICE_MODEL_BUNDLE "${models}/share/paj-voice-models" \
      --set PYTHONDONTWRITEBYTECODE 1 \
      --set PYTHONNOUSERSITE 1 \
      --set HF_HUB_OFFLINE 1 \
      --set HF_DATASETS_OFFLINE 1 \
      --set TRANSFORMERS_OFFLINE 1 \
      --set HF_HUB_DISABLE_TELEMETRY 1 \
      --set DO_NOT_TRACK 1 \
      --set TOKENIZERS_PARALLELISM false \
      --set OMP_NUM_THREADS 2 \
      --set MKL_NUM_THREADS 2 \
      --set OPENBLAS_NUM_THREADS 2 \
      --set NUMEXPR_NUM_THREADS 2 \
      --set BLIS_NUM_THREADS 2 \
      --set NUMBA_NUM_THREADS 2 \
      --set VECLIB_MAXIMUM_THREADS 2 \
      --set CUDA_VISIBLE_DEVICES "" \
      --set SSL_CERT_FILE /etc/ssl/certs/ca-certificates.crt \
      --set REQUESTS_CA_BUNDLE /etc/ssl/certs/ca-certificates.crt \
      --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.pipewire]} \
      --run ${pkgs.lib.escapeShellArg (import ./lab-cache.nix)}
  ''
