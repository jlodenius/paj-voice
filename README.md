# paj-voice

`paj-voice` adds voice conversations to an existing
[Pi](https://github.com/earendil-works/pi) session. Paj and Captain are optional.

## Install

Requires Linux, Nix, PipeWire, Pi 1.5.2 or newer, and a microphone. Headphones are recommended.
Nix packages the speech models and audio tools; no separate model setup is needed.

### NixOS

Add the flake input:

```nix
inputs.paj-voice.url = "github:jlodenius/paj-voice";
```

In your Home Manager configuration:

```nix
imports = [inputs.paj-voice.homeManagerModules.default];
programs.paj-voice.enable = true;
```

Install Pi separately. Rebuild NixOS, then run `/reload` in Pi. Install only one copy of the extension.
Without Home Manager, run `nix build`, then `pi install ./result/share/paj-voice`.

## Setup

Add `"voice": {}` to `~/.pi/agent/paj.json` (or `paj.json` in `PI_CODING_AGENT_DIR`). Keep sibling
settings. In a main interactive Pi session, run `/paj-voice setup desk` and choose your devices.

**Before turning Voice on:**

- **Open mic, no wake word.** Incidental or misheard speech can trigger normal Pi tools.
  Terminal confirmations remain manual.
- **Audio is processed locally.** Submitted text goes to your configured model provider and Pi history.
- **Wait for closure confirmation.** Bare `/paj-voice pause` and `/paj-voice off` request audio
  shutdown. Zero playback volume does not close the mic.

Run `/paj-voice on`, confirm, and stay quiet until the ready beep. Ask a short question and
listen for the reply. If audio is unavailable, check `/paj-voice status`.

## Reference

- [Commands and voice behavior](docs/usage.md)
- [Settings and storage](docs/settings.md)
- [Audio recovery and diagnostics](docs/troubleshooting.md)
- [Development](docs/development.md)
