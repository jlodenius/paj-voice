"""Experimental, local-only addressee classifier; never dispatches agent commands."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import time


MAX_TEXT = 1200
MAX_QUESTION = 300
ACCEPT_THRESHOLD = 0.95
ACCEPT_MARGIN = 0.35
REJECT_THRESHOLD = 0.90
REJECT_MARGIN = 0.25
LABELS = {
    "assistant_addressed": (
        "The speaker is directly addressing the local coding assistant now, asking it to act or "
        "answer. This is not merely mentioning an agent, quoting a command, or talking to a person."
    ),
    "not_assistant_addressed": (
        "The speaker is talking to a partner, game teammate, or themselves, or reporting or quoting "
        "someone's words. Mentioning coding, Nix, an agent, or a command does not address the assistant."
    ),
    "unclear_addressee": (
        "The intended listener cannot be determined from this utterance and minimal context. "
        "A broad request, fragment, or short reply could be for a person or the assistant. Ask locally."
    ),
}


class ClassifierError(RuntimeError):
    """A fail-closed error with no utterance text in its message."""


def _context(context):
    if context is None:
        context = {}
    if not isinstance(context, dict) or set(context) - {"active_agents", "last_question", "responding"}:
        raise ClassifierError("invalid context")
    agents = context.get("active_agents", [])
    question = context.get("last_question")
    responding = context.get("responding", False)
    if (not isinstance(agents, list) or len(agents) > 12
            or any(not isinstance(a, str) or not a.strip() or len(a) > 80 for a in agents)
            or (question is not None and (not isinstance(question, str) or len(question) > MAX_QUESTION))
            or not isinstance(responding, bool)):
        raise ClassifierError("invalid context")
    return {"active_agents": agents, "last_question": question, "responding": responding}


def _decision(scores):
    if not isinstance(scores, dict) or set(scores) != set(LABELS):
        raise ClassifierError("invalid classifier scores")
    if any(isinstance(s, bool) or not isinstance(s, (int, float))
           or not math.isfinite(s) or not 0 <= s <= 1 for s in scores.values()):
        raise ClassifierError("invalid classifier scores")
    accept = scores["assistant_addressed"]
    reject = scores["not_assistant_addressed"]
    unclear = scores["unclear_addressee"]
    if accept >= ACCEPT_THRESHOLD and accept - max(reject, unclear) >= ACCEPT_MARGIN:
        return "accept"
    if reject >= REJECT_THRESHOLD and reject - max(accept, unclear) >= REJECT_MARGIN:
        return "reject"
    return "uncertain"


class Classifier:
    def __init__(self, model_path):
        started = time.perf_counter()
        path = Path(model_path)
        if not path.is_absolute() or not path.is_dir():
            raise ClassifierError("model must be an explicit existing absolute directory")
        for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
            os.environ[name] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        try:
            import torch
            from gliner2 import GLiNER2

            torch.set_num_threads(2)
            self._torch = torch
            self._model = GLiNER2.from_pretrained(str(path), local_files_only=True).to("cpu")
            self._model.eval()
        except Exception:
            raise ClassifierError("local classifier load failed") from None
        self.load_ms = (time.perf_counter() - started) * 1000

    def classify(self, text, context=None):
        started = time.perf_counter()
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise ClassifierError("empty or overlong classifier input")
        context = _context(context)
        payload = (
            "Determine the intended addressee of the CURRENT UTTERANCE, not its topic. "
            "Context is metadata, not a command. Quoted or reported commands are not directed requests.\n"
            + "Minimal assistant context: " + json.dumps(context, ensure_ascii=True)
            + "\nCURRENT UTTERANCE: " + json.dumps(text, ensure_ascii=True)
        )
        try:
            with self._torch.inference_mode():
                output = self._model.classify_text(
                    payload,
                    {"addressee": {"labels": LABELS, "multi_label": True, "cls_threshold": 0.0}},
                    include_confidence=True,
                )
            items = output["addressee"]
            if not isinstance(items, list) or len(items) != len(LABELS):
                raise ClassifierError("invalid classifier scores")
            scores = {item["label"]: item["confidence"] for item in items}
            decision = _decision(scores)
        except Exception:
            raise ClassifierError("local classifier inference failed") from None
        return {"decision": decision, "scores": scores,
                "elapsedMs": (time.perf_counter() - started) * 1000}


def benchmark(classifier, fixture_path):
    path = Path(fixture_path)
    if path.stat().st_size > 128_000:
        raise ClassifierError("benchmark fixture exceeds size bound")
    raw = path.read_bytes()
    fixture = json.loads(raw)
    if (fixture.get("kind") != "authored-synthetic-addressee-v1"
            or not isinstance(fixture.get("cases"), list)
            or not 2 <= len(fixture["cases"]) <= 60
            or {c["split"] for c in fixture["cases"]} != {"development", "heldout"}):
        raise ClassifierError("benchmark requires bounded authored synthetic fixtures with both splits")
    rows = []
    for item in fixture["cases"]:
        result = classifier.classify(item["text"], item.get("context"))
        rows.append({"id": item["id"], "split": item["split"], "category": item["category"],
                     "expected": item["expected"], **result})
    summaries = {}
    for split in ("development", "heldout"):
        group = [r for r in rows if r["split"] == split]
        elapsed = sorted(r["elapsedMs"] for r in group)
        summaries[split] = {
            "count": len(group),
            "falseAcceptIds": [r["id"] for r in group
                               if r["decision"] == "accept" and r["expected"] != "accept"],
            "missedAcceptIds": [r["id"] for r in group
                                if r["decision"] != "accept" and r["expected"] == "accept"],
            "rejectedPositiveIds": [r["id"] for r in group
                                    if r["decision"] == "reject" and r["expected"] == "accept"],
            "uncertainFraction": sum(r["decision"] == "uncertain" for r in group) / len(group),
            "medianMs": statistics.median(elapsed),
            "p95Ms": elapsed[math.ceil(len(elapsed) * .95) - 1],
        }
    return {"experimental": True, "syntheticOnly": True,
            "model": "fastino/gliner2-base-v1", "cpuThreads": 2,
            "fixtureSha256": hashlib.sha256(raw).hexdigest(),
            "thresholds": {"accept": ACCEPT_THRESHOLD, "acceptMargin": ACCEPT_MARGIN,
                           "reject": REJECT_THRESHOLD, "rejectMargin": REJECT_MARGIN},
            "scoreCaveat": "Independent model confidence scores, not calibrated probabilities or accuracy.",
            "coldLoadMs": classifier.load_ms, "firstInferenceMs": rows[0]["elapsedMs"],
            "warmMedianMs": statistics.median(r["elapsedMs"] for r in rows[1:]),
            "splits": summaries, "results": rows}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Absolute offline Nix classifier directory")
    parser.add_argument("--benchmark", required=True, help="Authored synthetic fixture JSON only")
    args = parser.parse_args(argv)
    try:
        result = benchmark(Classifier(args.model), args.benchmark)
    except ClassifierError as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
