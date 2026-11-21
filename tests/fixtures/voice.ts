import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { registerVoice } from "../../src/extension.ts";

export default function (pi) {
  const journal = process.env.VOICE_TEST_JOURNAL;
  let worker;
  let serial = 0;
  const record = (value) =>
    appendFileSync(journal, `${JSON.stringify(value)}\n`);
  const wrapped = new Proxy(pi, {
    get(target, name) {
      if (name !== "registerCommand") return Reflect.get(target, name);
      return (command, definition) =>
        target.registerCommand(command, {
          ...definition,
          handler: (args, ctx) =>
            definition.handler(args, {
              ...ctx,
              mode: "tui",
              hasUI: true,
              ui: { ...ctx.ui, confirm: async () => true },
            }),
        });
    },
  });
  registerVoice(wrapped, Type, {
    layout: { truncateToWidth, visibleWidth, wrapTextWithAnsi },
    startCompanion(options) {
      worker = options;
      record({
        type: "opened",
        generation: options.generation,
        config: options.config,
      });
      return {
        send(frame) {
          record(frame);
          return true;
        },
        close() {
          record({ type: "closed", generation: options.generation });
        },
      };
    },
  });
  pi.registerCommand("voice-test-background", {
    description: "Trigger an isolated background agent update",
    handler: async () =>
      pi.sendMessage(
        {
          customType: "paj-messages",
          content:
            "A completed worker report was already handled. No new user request.",
          display: true,
        },
        { triggerTurn: true },
      ),
  });
  pi.registerCommand("voice-test-noise", {
    description: "Cancel a fake VAD capture without submitting a user prompt",
    handler: async () => {
      const id = `fake-capture-${++serial}`;
      worker.onEvent({ type: "addressed", id }, worker.generation);
      worker.onEvent(
        { type: "cancelled", id, reason: "empty" },
        worker.generation,
      );
    },
  });
  pi.registerCommand("voice-test-inbox", {
    description:
      "Deliver isolated fake Paj updates through the real Pi custom-message queue",
    handler: async (_args, ctx) => {
      const messageIds = [`fake-inbox-${++serial}`];
      pi.events.emit("paj:messages:delivering:v1", {
        sessionId: ctx.sessionManager.getSessionId(),
        messageIds,
        requestTurn() {},
      });
      pi.sendMessage(
        {
          customType: "paj-messages",
          content: "A worker completed its review.",
          display: true,
          details: { messageIds },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });
  pi.registerCommand("voice-test-ready", {
    description: "Signal fake audio worker readiness",
    handler: async () => worker.onEvent({ type: "ready" }, worker.generation),
  });
  pi.registerCommand("voice-test-utterance", {
    description: "Submit fake addressed speech without audio",
    handler: async (text) => {
      const id = `fake-capture-${++serial}`;
      worker.onEvent({ type: "addressed", id }, worker.generation);
      worker.onEvent({ type: "utterance", id, text }, worker.generation);
    },
  });
}
