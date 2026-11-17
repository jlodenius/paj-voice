{
  pkgs ? import ./lab-pkgs.nix,
  classifier ? "gliclass",
}:
assert builtins.elem classifier ["gliner2" "gliclass"]; let
  manifestFile =
    if classifier == "gliclass"
    then ../models/lab-gliclass-manifest.json
    else ../models/lab-manifest.json;
  manifest = builtins.fromJSON (builtins.readFile manifestFile);
  asset = entry: let
    source = pkgs.fetchurl {
      inherit (entry) url;
      curlOptsList = ["--no-insecure" "--cacert" "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"];
      sha256 = entry.sha256;
      name = "paj-voice-" + builtins.replaceStrings ["/"] ["-"] entry.path;
    };
  in ''
    mkdir -p "$out/share/paj-voice-models/$(dirname '${entry.path}')"
    ln -s ${source} "$out/share/paj-voice-models/${entry.path}"
  '';
in
  pkgs.runCommand "paj-voice-lab-models" {} ''
    mkdir -p "$out/share/paj-voice-models"
    ${pkgs.lib.concatMapStringsSep "\n" asset manifest.assets}
    cp ${manifestFile} "$out/share/paj-voice-models/provenance.json"
    ${pkgs.lib.concatMapStringsSep "\n" (group: ''
      cp ${pkgs.writeText "paj-voice-${group}-source.json" (builtins.toJSON manifest.models.${group})} \
        "$out/share/paj-voice-models/${group}/source.json"
    '') ["stt" "tts" "classifier"]}
  ''
