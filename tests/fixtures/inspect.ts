import { readFileSync } from "node:fs";

export default function (pi) {
  pi.registerCommand("voice-test-inspect", {
    description: "Inspect isolated voice test state",
    handler: async (_args, ctx) => {
      const replies = [];
      pi.events.emit("paj-voice:api:v1", {
        reply: (api) => replies.push(api.getState()),
      });
      ctx.ui.notify(
        JSON.stringify({
          active: pi.getActiveTools(),
          all: pi.getAllTools(),
          replies,
          journal: readFileSync(process.env.VOICE_TEST_JOURNAL, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(JSON.parse),
        }),
      );
    },
  });
  pi.registerCommand("voice-test-reload", {
    description: "Reload the isolated extension runtime",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
