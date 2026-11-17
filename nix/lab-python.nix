{pkgs ? import ./lab-pkgs.nix}: let
  python = pkgs.python313;
  ps = python.pkgs;
  gliner2 = ps.buildPythonPackage {
    pname = "gliner2";
    version = "2.1.0";
    format = "wheel";
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/6a/b1/cae13092a6ca796dd17493c8129d48e38fc370f23b9cce6f616020ed3654/gliner2-2.1.0-py3-none-any.whl";
      curlOptsList = ["--no-insecure" "--cacert" "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"];
      sha256 = "0c242c5de53f37020df835788fc4eb820e1673b5212c202cd90e9234a7e786bc";
    };
    dependencies = with ps; [
      pydantic
      requests
      tqdm
      urllib3
      numpy
      peft
      safetensors
      torch
      transformers
      sentencepiece
      protobuf
    ];
    pythonImportsCheck = ["gliner2" "gliner2.inference.engine"];
    meta.license = pkgs.lib.licenses.asl20;
  };
  gliclass = ps.buildPythonPackage {
    pname = "gliclass";
    version = "0.1.22";
    format = "wheel";
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/d5/fb/8aa349f460fdcf081340523dfd90d64d069384a321d61593fe3b8f4b35cb/gliclass-0.1.22-py3-none-any.whl";
      curlOptsList = ["--no-insecure" "--cacert" "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"];
      sha256 = "f29c471fe373985288efa4d69f838957e7b70d729b9628fc5135e1b67e9085e9";
    };
    dependencies = with ps; [torch transformers scikit-learn numpy];
    pythonImportsCheck = ["gliclass"];
    meta.license = pkgs.lib.licenses.asl20;
  };
  piper =
    (pkgs.piper-tts.override {
      python3Packages = ps;
      withAlignment = false;
      withHTTP = false;
      withJapanese = false;
      withTrain = false;
    }).overrideAttrs {
      pythonImportsCheck = ["piper"];
    };
in
  python.withPackages (ps: [
    gliner2
    gliclass
    ps.torch
    ps.transformers
    ps.faster-whisper
    ps.pysilero-vad
    ps.numpy
    (ps.toPythonModule piper)
  ])
