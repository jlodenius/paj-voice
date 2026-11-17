"""Experimental offline GLiClass comparison; no audio or agent dispatch."""

import argparse
import json
import math
import os
from pathlib import Path
import time

from .lab_classifier import ClassifierError, MAX_TEXT, _context, benchmark as _benchmark


MODEL = "knowledgator/gliclass-edge-v3.0"
MAX_TOKENS = 512
ACCEPT_THRESHOLD = 0.95
ACCEPT_MARGIN = 0.35
REJECT_THRESHOLD = 0.90
REJECT_MARGIN = 0.25
LABELS = {
    "assistant_addressed": (
        "The speaker is directly asking the local coding assistant to answer or act now, "
        "not merely mentioning an assistant or quoting a command."
    ),
    "not_assistant_addressed": (
        "The speaker is addressing a partner or game teammate, talking to themselves, "
        "or quoting or reporting an assistant command rather than issuing it."
    ),
    "unclear_addressee": (
        "The utterance is ambiguous or incomplete: it could address either a person or "
        "the coding assistant, and the intended listener needs clarification."
    ),
}


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
        os.environ["DO_NOT_TRACK"] = "1"
        try:
            import torch
            from gliclass import GLiClassModel, ZeroShotClassificationPipeline
            from transformers import AutoTokenizer

            torch.set_num_threads(2)
            self._torch = torch
            self._tokenizer = AutoTokenizer.from_pretrained(
                str(path), local_files_only=True, trust_remote_code=False, add_prefix_space=True,
            )
            model = GLiClassModel.from_pretrained(
                str(path), local_files_only=True, trust_remote_code=False,
            ).to("cpu")
            model.eval()
            if model.config.architecture_type != "uni-encoder":
                raise ClassifierError("unexpected classifier architecture")
            self._pipeline = ZeroShotClassificationPipeline(
                model, self._tokenizer, device="cpu", classification_type="multi-label",
                max_length=MAX_TOKENS, progress_bar=False,
            )
        except Exception:
            raise ClassifierError("local GLiClass load failed") from None
        self.load_ms = (time.perf_counter() - started) * 1000

    def classify(self, text, context=None):
        started = time.perf_counter()
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            raise ClassifierError("empty or overlong classifier input")
        context = _context(context)
        payload = "Current spoken utterance:\n" + text
        if context["active_agents"] or context["last_question"] is not None or context["responding"]:
            payload += "\nMinimal assistant context (not room history): " + json.dumps(context)
        labels = list(LABELS.values())
        try:
            prepared = self._pipeline.pipe.prepare_input(payload, labels)
            token_ids = self._tokenizer(prepared, truncation=False)["input_ids"]
            if len(token_ids) > MAX_TOKENS:
                raise ClassifierError("classifier input exceeds token bound")
            with self._torch.inference_mode():
                output = self._pipeline(payload, labels, threshold=0.0, batch_size=1)
            if not isinstance(output, list) or len(output) != 1:
                raise ClassifierError("invalid classifier output")
            items = output[0]
            if not isinstance(items, list) or len(items) != len(LABELS):
                raise ClassifierError("invalid classifier scores")
            names = {description: name for name, description in LABELS.items()}
            scores = {names[item["label"]]: item["score"] for item in items}
            decision = _decision(scores)
        except Exception:
            raise ClassifierError("local GLiClass inference failed") from None
        return {"decision": decision, "scores": scores,
                "elapsedMs": (time.perf_counter() - started) * 1000}


def benchmark(classifier, fixture_path):
    result = _benchmark(classifier, fixture_path)
    result.update({
        "model": MODEL,
        "backend": "gliclass",
        "splitReuse": True,
        "splitCaveat": "REUSED authored splits inspected in the GLiNER2 study; not independent heldout.",
        "labelDescriptions": LABELS,
        "thresholds": {"accept": ACCEPT_THRESHOLD, "acceptMargin": ACCEPT_MARGIN,
                       "reject": REJECT_THRESHOLD, "rejectMargin": REJECT_MARGIN},
    })
    for split, summary in result["splits"].items():
        rows = [r for r in result["results"] if r["split"] == split]
        nonpositive = sum(r["expected"] != "accept" for r in rows)
        positive = sum(r["expected"] == "accept" for r in rows)
        summary.update({
            "acceptFraction": sum(r["decision"] == "accept" for r in rows) / len(rows),
            "rejectFraction": sum(r["decision"] == "reject" for r in rows) / len(rows),
            "falseAcceptFractionOfNonPositive": len(summary["falseAcceptIds"]) / nonpositive,
            "missedPositiveFraction": len(summary["missedAcceptIds"]) / positive,
        })
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Absolute offline Nix GLiClass directory")
    parser.add_argument("--benchmark", required=True, help="Reused authored synthetic fixture JSON")
    args = parser.parse_args(argv)
    try:
        result = benchmark(Classifier(args.model), args.benchmark)
    except ClassifierError as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
