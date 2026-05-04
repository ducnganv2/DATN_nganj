import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any, Iterable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute accuracy, F1, FPR, and AUC for Hydro production detector outputs."
    )
    parser.add_argument("--samples", required=True, help="Labeled samples file with sample_id and label.")
    parser.add_argument("--predictions", required=True, help="Prod detector output file with sample_id plus score/isAI.")
    parser.add_argument("--output-dir", required=True, help="Output directory for metric files.")
    parser.add_argument("--join-key", default="sample_id", help="Join key shared by samples and predictions.")
    parser.add_argument("--experiment-name", default="hydro_prod_detector", help="Name stored in metrics.json.")
    parser.add_argument(
        "--decision-source",
        choices=["production", "threshold"],
        default="production",
        help="Use production isAI decisions or recompute decisions from scores.",
    )
    parser.add_argument(
        "--threshold-strategy",
        choices=["f1", "youden", "fixed", "target_fpr"],
        default="f1",
        help="Threshold policy when --decision-source threshold is used.",
    )
    parser.add_argument("--fixed-threshold", type=float, help="Raw threshold for --threshold-strategy fixed.")
    parser.add_argument("--target-fpr", type=float, default=0.1, help="Maximum FPR for target_fpr strategy.")
    parser.add_argument(
        "--score-direction",
        choices=["higher_ai", "lower_ai"],
        default="higher_ai",
        help="Direction of the raw score. Hydro ATC uses higher_ai.",
    )
    return parser.parse_args()


def ensure_parent(path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def load_records(path: str | Path) -> list[dict]:
    target = Path(path)
    suffix = target.suffix.lower()
    if suffix == ".jsonl":
        with target.open("r", encoding="utf-8-sig") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    if suffix == ".json":
        with target.open("r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("rows", "data", "samples", "predictions", "results"):
                if isinstance(payload.get(key), list):
                    return payload[key]
            return [payload]
        raise ValueError(f"Unsupported JSON payload in {target}")
    if suffix == ".csv":
        with target.open("r", encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    raise ValueError(f"Unsupported file extension for {target}")


def dump_records(path: str | Path, records: Iterable[dict]) -> None:
    target = ensure_parent(path)
    rows = list(records)
    suffix = target.suffix.lower()
    if suffix == ".jsonl":
        with target.open("w", encoding="utf-8", newline="") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        return
    if suffix == ".json":
        with target.open("w", encoding="utf-8") as handle:
            json.dump(rows, handle, ensure_ascii=False, indent=2)
        return
    if suffix == ".csv":
        fieldnames = collect_fieldnames(rows)
        with target.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        return
    raise ValueError(f"Unsupported file extension for {target}")


def collect_fieldnames(rows: list[dict]) -> list[str]:
    fields = []
    seen = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                fields.append(key)
    return fields


def get_path(row: dict, field_path: str) -> Any:
    value: Any = row
    for part in field_path.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def first_present(row: dict, paths: tuple[str, ...]) -> Any:
    for path in paths:
        value = get_path(row, path)
        if value is not None and value != "":
            return value
    return None


def parse_label(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    text = str(value).strip().lower()
    if text in {"1", "ai", "aigc", "true", "yes"}:
        return 1
    if text in {"0", "human", "false", "no"}:
        return 0
    return None


def parse_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def normalize_prediction(row: dict, score_direction: str) -> dict:
    if len(row) == 1 and "sample_id" not in row:
        key, payload = next(iter(row.items()))
        if isinstance(payload, dict):
            row = {"sample_id": str(key), **payload}
    ai_check = row.get("aiCheck") if isinstance(row.get("aiCheck"), dict) else {}
    merged = {**row}
    for key in ("state", "isAI", "score", "threshold", "confidence", "provider", "message"):
        if key in ai_check and key not in merged:
            merged[key] = ai_check[key]

    raw_score = parse_float(first_present(merged, ("score_ai", "score", "ai_score", "raw_score", "aiCheck.score")))
    score_ai = None if raw_score is None else raw_score if score_direction == "higher_ai" else -raw_score
    threshold = parse_float(first_present(merged, ("threshold", "aiCheck.threshold")))
    pred_ai = parse_label(first_present(merged, ("pred_ai", "isAI", "is_ai", "prediction", "aiCheck.isAI")))
    if pred_ai is None and raw_score is not None and threshold is not None:
        if score_direction == "higher_ai":
            pred_ai = 1 if raw_score >= threshold else 0
        else:
            pred_ai = 1 if raw_score <= threshold else 0

    sample_id = str(first_present(merged, ("sample_id", "id")) or "")
    task_id = str(first_present(merged, ("task_id",)) or "")
    variant = str(first_present(merged, ("variant",)) or "")
    if not sample_id and task_id and variant:
        sample_id = f"{task_id}_{variant}"

    return {
        "sample_id": sample_id,
        "task_id": task_id,
        "variant": variant,
        "raw_score": raw_score,
        "score_ai": score_ai,
        "threshold": threshold,
        "pred_ai": pred_ai,
        "detector_state": str(first_present(merged, ("state", "aiCheck.state")) or ""),
        "provider": str(first_present(merged, ("provider", "aiCheck.provider")) or ""),
        "message": str(first_present(merged, ("message", "aiCheck.message")) or ""),
    }


def merge_samples(samples: list[dict], predictions: list[dict], args: argparse.Namespace) -> list[dict]:
    predictions_by_key = {
        str(prediction.get(args.join_key, "")): prediction
        for prediction in predictions
        if prediction.get(args.join_key)
    }
    rows = []
    for sample in samples:
        key = str(sample.get(args.join_key, ""))
        label = parse_label(sample.get("label", sample.get("variant")))
        prediction = predictions_by_key.get(key)
        base = {
            "sample_id": str(sample.get("sample_id", "")),
            "task_id": str(sample.get("task_id", "")),
            "variant": str(sample.get("variant", "")),
            "label": label,
            "problem_id": sample.get("problem_id", ""),
            "title": sample.get("title", ""),
            "language": sample.get("language", ""),
            "ai_model": sample.get("ai_model", ""),
        }
        if prediction:
            rows.append({**base, **prediction})
        else:
            rows.append(
                {
                    **base,
                    "raw_score": None,
                    "score_ai": None,
                    "threshold": None,
                    "pred_ai": None,
                    "detector_state": "missing",
                    "provider": "",
                    "message": "No prediction matched this sample.",
                }
            )
    return rows


def confusion_counts(labels: list[int], preds: list[int]) -> tuple[int, int, int, int]:
    tn = fp = fn = tp = 0
    for label, pred in zip(labels, preds):
        if label == 0 and pred == 0:
            tn += 1
        elif label == 0 and pred == 1:
            fp += 1
        elif label == 1 and pred == 0:
            fn += 1
        elif label == 1 and pred == 1:
            tp += 1
    return tn, fp, fn, tp


def hard_metrics(rows: list[dict]) -> dict:
    labels = [int(row["label"]) for row in rows]
    preds = [int(row["pred_ai"]) for row in rows]
    tn, fp, fn, tp = confusion_counts(labels, preds)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "num_samples": len(rows),
        "accuracy": (tp + tn) / len(rows) if rows else 0.0,
        "f1": f1,
        "precision": precision,
        "recall": recall,
        "fpr": fp / (fp + tn) if fp + tn else 0.0,
        "tpr": recall,
        "tp": int(tp),
        "tn": int(tn),
        "fp": int(fp),
        "fn": int(fn),
    }


def roc_curve(labels: list[int], scores: list[float]) -> list[dict]:
    positives = sum(labels)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        return []
    pairs = sorted(zip(scores, labels), key=lambda item: item[0], reverse=True)
    points = [{"fpr": 0.0, "tpr": 0.0, "threshold": "inf"}]
    tp = fp = 0
    prev_score = None
    for score, label in pairs:
        if prev_score is not None and score != prev_score:
            points.append({"fpr": fp / negatives, "tpr": tp / positives, "threshold": prev_score})
        if label == 1:
            tp += 1
        else:
            fp += 1
        prev_score = score
    points.append({"fpr": fp / negatives, "tpr": tp / positives, "threshold": prev_score})
    return points


def pr_curve(labels: list[int], scores: list[float]) -> list[dict]:
    positives = sum(labels)
    if positives == 0:
        return []
    pairs = sorted(zip(scores, labels), key=lambda item: item[0], reverse=True)
    points = [{"precision": 1.0, "recall": 0.0, "threshold": "inf"}]
    tp = fp = 0
    prev_score = None
    for score, label in pairs:
        if prev_score is not None and score != prev_score:
            points.append(
                {
                    "precision": tp / (tp + fp) if tp + fp else 1.0,
                    "recall": tp / positives,
                    "threshold": prev_score,
                }
            )
        if label == 1:
            tp += 1
        else:
            fp += 1
        prev_score = score
    points.append(
        {
            "precision": tp / (tp + fp) if tp + fp else 1.0,
            "recall": tp / positives,
            "threshold": prev_score,
        }
    )
    return points


def area(xs: list[float], ys: list[float]) -> float:
    total = 0.0
    for index in range(1, len(xs)):
        total += (xs[index] - xs[index - 1]) * (ys[index] + ys[index - 1]) / 2
    return total


def metric_at_threshold(rows: list[dict], threshold: float) -> dict:
    copied = []
    for row in rows:
        copied.append({**row, "pred_ai": 1 if float(row["score_ai"]) >= threshold else 0})
    return hard_metrics(copied)


def select_threshold(rows: list[dict], strategy: str, fixed_threshold: float | None, target_fpr: float) -> float:
    if strategy == "fixed":
        if fixed_threshold is None:
            raise ValueError("--fixed-threshold is required when threshold-strategy=fixed")
        return fixed_threshold
    candidates = sorted({float(row["score_ai"]) for row in rows}, reverse=True)
    best_threshold = candidates[0]
    best_value = float("-inf")
    for threshold in candidates:
        metrics = metric_at_threshold(rows, threshold)
        if strategy == "f1":
            value = metrics["f1"]
        elif strategy == "youden":
            value = metrics["tpr"] - metrics["fpr"]
        elif strategy == "target_fpr":
            value = metrics["f1"] if metrics["fpr"] <= target_fpr else float("-inf")
        else:
            raise ValueError(f"Unsupported strategy: {strategy}")
        if value > best_value:
            best_value = value
            best_threshold = threshold
    return best_threshold


def evaluate(args: argparse.Namespace) -> tuple[list[dict], dict]:
    samples = load_records(args.samples)
    predictions = [normalize_prediction(row, args.score_direction) for row in load_records(args.predictions)]
    rows = merge_samples(samples, predictions, args)

    score_rows = [
        row for row in rows
        if row.get("label") in (0, 1) and row.get("score_ai") is not None and math.isfinite(float(row["score_ai"]))
    ]
    selected_threshold = None
    selected_raw_threshold = None
    if args.decision_source == "threshold":
        if not score_rows:
            raise ValueError("Threshold evaluation requires at least one labeled row with a detector score.")
        fixed_threshold = args.fixed_threshold
        if args.score_direction == "lower_ai" and fixed_threshold is not None:
            fixed_threshold = -fixed_threshold
        selected_threshold = select_threshold(score_rows, args.threshold_strategy, fixed_threshold, args.target_fpr)
        selected_raw_threshold = selected_threshold if args.score_direction == "higher_ai" else -selected_threshold
        for row in rows:
            if row.get("score_ai") is not None and math.isfinite(float(row["score_ai"])):
                row["pred_ai"] = 1 if float(row["score_ai"]) >= selected_threshold else 0

    hard_rows = [row for row in rows if row.get("label") in (0, 1) and row.get("pred_ai") in (0, 1)]
    if not hard_rows:
        raise ValueError("No labeled rows have production predictions.")
    metrics = hard_metrics(hard_rows)

    roc_points = roc_curve([int(row["label"]) for row in score_rows], [float(row["score_ai"]) for row in score_rows])
    pr_points = pr_curve([int(row["label"]) for row in score_rows], [float(row["score_ai"]) for row in score_rows])
    metrics.update(
        {
            "auc": area([point["fpr"] for point in roc_points], [point["tpr"] for point in roc_points]) if roc_points else None,
            "pr_auc": area([point["recall"] for point in pr_points], [point["precision"] for point in pr_points]) if pr_points else None,
            "auc_num_samples": len(score_rows),
            "random_auc_baseline": 0.5,
        }
    )

    payload = {
        "experiment_name": args.experiment_name,
        "decision_source": args.decision_source,
        "threshold_strategy": args.threshold_strategy if args.decision_source == "threshold" else None,
        "selected_threshold": selected_threshold,
        "selected_raw_threshold": selected_raw_threshold,
        "score_direction": args.score_direction,
        "num_input_rows": len(rows),
        "num_missing_predictions": len([row for row in rows if row.get("detector_state") == "missing"]),
        "metrics": metrics,
    }
    return rows, payload


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    rows, payload = evaluate(args)
    dump_records(output_dir / "samples_with_predictions.csv", rows)
    dump_records(output_dir / "metrics.json", [payload])

    score_rows = [
        row for row in rows
        if row.get("label") in (0, 1) and row.get("score_ai") is not None and math.isfinite(float(row["score_ai"]))
    ]
    roc_points = roc_curve([int(row["label"]) for row in score_rows], [float(row["score_ai"]) for row in score_rows])
    pr_points = pr_curve([int(row["label"]) for row in score_rows], [float(row["score_ai"]) for row in score_rows])
    if roc_points:
        dump_records(output_dir / "all_roc_curve.csv", roc_points)
    if pr_points:
        dump_records(output_dir / "all_pr_curve.csv", pr_points)

    metrics = payload["metrics"]
    print(f"Experiment: {payload['experiment_name']}")
    print(f"Samples: {metrics['num_samples']}")
    print(f"Accuracy: {metrics['accuracy']:.4f}")
    print(f"F1: {metrics['f1']:.4f}")
    print(f"FPR: {metrics['fpr']:.4f}")
    print(f"AUC: {metrics['auc']:.4f}" if metrics["auc"] is not None else "AUC: n/a")


if __name__ == "__main__":
    main()
