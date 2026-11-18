{system ? builtins.currentSystem}:
import (import ./nixpkgs-source.nix) {
  inherit system;
  config = {
    allowUnfree = false;
    cudaSupport = false;
  };
}
