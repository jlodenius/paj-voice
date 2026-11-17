{classifier ? "gliclass"}: let
  pkgs = import ./nix/lab-pkgs.nix;
  python = import ./nix/lab-python.nix {inherit pkgs;};
  models = import ./nix/models.nix {inherit pkgs classifier;};
in
  pkgs.mkShell {
    packages = [python pkgs.pipewire pkgs.nodejs pkgs.cacert];
    PAJ_VOICE_CLASSIFIER = classifier;
    PAJ_VOICE_MODEL_BUNDLE = "${models}/share/paj-voice-models";
    PYTHONDONTWRITEBYTECODE = "1";
    PYTHONNOUSERSITE = "1";
    HF_HUB_OFFLINE = "1";
    HF_DATASETS_OFFLINE = "1";
    TRANSFORMERS_OFFLINE = "1";
    HF_HUB_DISABLE_TELEMETRY = "1";
    DO_NOT_TRACK = "1";
    TOKENIZERS_PARALLELISM = "false";
    OMP_NUM_THREADS = "2";
    MKL_NUM_THREADS = "2";
    OPENBLAS_NUM_THREADS = "2";
    NUMEXPR_NUM_THREADS = "2";
    BLIS_NUM_THREADS = "2";
    NUMBA_NUM_THREADS = "2";
    VECLIB_MAXIMUM_THREADS = "2";
    CUDA_VISIBLE_DEVICES = "";
    shellHook = ''
      ${import ./nix/lab-cache.nix}
      export PYTHONPATH="$PAJ_VOICE_PROJECT_DIR/audio"
      export NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
      export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
      export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
    '';
  }
