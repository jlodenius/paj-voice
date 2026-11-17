{
  description = "Local eyes-free voice conversations with Pi";

  outputs = {self}: {
    homeManagerModules.default = {
      config,
      lib,
      pkgs,
      ...
    }: let
      cfg = config.programs.paj-voice;
      format = pkgs.formats.json {};
    in {
      options.programs.paj-voice = {
        enable = lib.mkEnableOption "local eyes-free voice inside Pi";
        package = lib.mkOption {
          type = lib.types.package;
          default = pkgs.callPackage ./nix/package.nix {};
          description = "Local audio companion and Pi extension package.";
        };
        settings = lib.mkOption {
          type = lib.types.nullOr lib.types.attrs;
          default = null;
          description = "Inner Voice preferences, generated as { voice = settings; } in shared paj.json. Owns the whole file; leave null when the host manages combined addon settings. Capture remains off until explicitly enabled.";
        };
        configFile = lib.mkOption {
          type = lib.types.nullOr (lib.types.either lib.types.path lib.types.str);
          default = null;
          description = "Entire shared paj.json source, optionally an out-of-store managed symlink. Must include a voice section and preserve other addon sections. Exclusive with settings; leave null when another module owns the shared file.";
        };
      };
      config = lib.mkIf cfg.enable {
        assertions = [
          {
            assertion = cfg.settings == null || cfg.configFile == null;
            message = "Set only one of programs.paj-voice.settings and programs.paj-voice.configFile.";
          }
        ];
        home.packages = [cfg.package];
        home.file =
          {
            ".pi/agent/extensions/paj-voice".source = "${cfg.package}/share/paj-voice";
          }
          // lib.optionalAttrs (cfg.settings != null || cfg.configFile != null) {
            ".pi/agent/paj.json".source =
              if cfg.configFile != null
              then cfg.configFile
              else format.generate "paj.json" {voice = cfg.settings;};
          };
      };
    };
  };
}
