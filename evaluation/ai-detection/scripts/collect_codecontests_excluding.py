import argparse
import csv
import json
import re
from pathlib import Path


LANGUAGE_MAP = {
    1: "python",
    2: "cpp",
    3: "python",
    4: "java",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect CodeContests human solutions while excluding task ids from existing files."
    )
    parser.add_argument("--output", required=True, help="Output JSONL path.")
    parser.add_argument("--target-count", type=int, default=1000)
    parser.add_argument("--language", default="cpp", choices=["cpp", "python", "java"])
    parser.add_argument("--split", action="append", default=[], help="Dataset split(s), e.g. train, valid, test.")
    parser.add_argument("--arrow-dir", help="Optional local directory containing CodeContests .arrow shards.")
    parser.add_argument("--exclude-file", action="append", default=[], help="Existing JSONL/JSON/CSV files to exclude.")
    parser.add_argument("--streaming", action="store_true")
    parser.add_argument(
        "--order",
        choices=["dataset", "oldest"],
        default="dataset",
        help="dataset keeps dataset iteration order; oldest sorts candidates by contest/problem id when available.",
    )
    parser.add_argument(
        "--candidate-count",
        type=int,
        default=20000,
        help="Number of usable candidates to collect before sorting when --order oldest is used.",
    )
    return parser.parse_args()


def load_records(path: str | Path) -> list[dict]:
    target = Path(path)
    suffix = target.suffix.lower()
    if suffix == ".jsonl":
        with target.open("r", encoding="utf-8-sig") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    if suffix == ".json":
        with target.open("r", encoding="utf-8-sig") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, list) else []
    if suffix == ".csv":
        with target.open("r", encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    return []


def task_id_from_row(row: dict) -> str:
    return str(row.get("task_id") or row.get("problem_id") or row.get("sample_id") or "").strip()


def load_excluded_task_ids(paths: list[str]) -> set[str]:
    excluded = set()
    for path in paths:
        for row in load_records(path):
            task_id = task_id_from_row(row)
            if task_id:
                excluded.add(task_id)
    return excluded


def dump_jsonl(path: str | Path, rows: list[dict]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def oldest_key(row: dict) -> tuple[int, int, str]:
    source = str(row.get("codecontests_source_id", "") or row.get("source_id", "")).strip()
    cf_contest_id = row.get("cf_contest_id")
    if source == "2" and isinstance(cf_contest_id, int) and cf_contest_id > 0:
        return (0, cf_contest_id, str(row.get("task_id", "")))
    if source == "2" and isinstance(cf_contest_id, str) and cf_contest_id.isdigit() and int(cf_contest_id) > 0:
        return (0, int(cf_contest_id), str(row.get("task_id", "")))

    title = str(row.get("title", ""))
    task_id = str(row.get("task_id", ""))
    text = f"{source}_{title}_{task_id}"

    # DeepMind CodeContests source id 2 is Codeforces. Smaller contest ids are older.
    codeforces = re.search(r"(?:^|_|\b)(\d{1,5})[_\-. ]+[A-Z][0-9]?\b", text)
    if source == "2" and codeforces:
        return (0, int(codeforces.group(1)), task_id)

    # AtCoder titles often include "AtCoder Beginner Contest 060"; smaller ids are older.
    atcoder = re.search(r"AtCoder\s+Beginner\s+Contest\s+(\d+)", text, flags=re.IGNORECASE)
    if atcoder:
        return (1, int(atcoder.group(1)), task_id)

    # Aizu/online judge style p00025 ids are also roughly chronological.
    problem_number = re.search(r"\bp0*(\d{1,6})\b", text, flags=re.IGNORECASE)
    if problem_number:
        return (2, int(problem_number.group(1)), task_id)

    any_number = re.search(r"\b(\d{1,6})\b", text)
    if any_number:
        return (3, int(any_number.group(1)), task_id)

    return (9, 10**9, task_id)


def collect(args: argparse.Namespace) -> list[dict]:
    import datasets

    splits = args.split or ["train"]
    excluded = load_excluded_task_ids(args.exclude_file)
    selected = []
    seen = set(excluded)
    candidate_target = args.target_count if args.order == "dataset" else max(args.target_count, args.candidate_count)

    if args.arrow_dir:
        arrow_files = sorted(Path(args.arrow_dir).glob("*.arrow"))
        datasets_to_scan = []
        for path in arrow_files:
            try:
                datasets_to_scan.append(datasets.Dataset.from_file(str(path)))
            except Exception as exc:
                print(f"Skipping unreadable arrow shard {path}: {type(exc).__name__}: {exc}")
    else:
        datasets_to_scan = [
            datasets.load_dataset("deepmind/code_contests", split=split, streaming=args.streaming)
            for split in splits
        ]

    for dataset_index, dataset in enumerate(datasets_to_scan):
        split = splits[min(dataset_index, len(splits) - 1)] if splits else ""
        for item in dataset:
            solutions = item.get("solutions", {})
            languages = solutions.get("language", [])
            answers = solutions.get("solution", [])

            selected_code = ""
            for lang_id, code in zip(languages, answers):
                if LANGUAGE_MAP.get(lang_id) == args.language and str(code).strip():
                    selected_code = str(code)
                    break
            if not selected_code:
                continue

            source = str(item.get("source", "")).strip()
            name = str(item.get("name", "")).strip()
            task_id = f"{source}_{name}".replace(" ", "_")
            if not task_id or task_id in seen:
                continue
            seen.add(task_id)
            selected.append(
                {
                    "task_id": task_id,
                    "problem_id": task_id,
                    "title": name,
                    "text": item.get("description", ""),
                    "code": selected_code,
                    "source": "deepmind_code_contests_human",
                    "codecontests_source_id": source,
                    "cf_contest_id": item.get("cf_contest_id", -1),
                    "cf_index": item.get("cf_index", ""),
                    "cf_rating": item.get("cf_rating", -1),
                    "human_language": args.language,
                    "dataset_name": "deepmind/code_contests",
                    "dataset_split": split,
                }
            )
            if len(selected) >= candidate_target:
                if args.order == "oldest":
                    return sorted(selected, key=oldest_key)[: args.target_count]
                return selected

    if args.order == "oldest":
        return sorted(selected, key=oldest_key)[: args.target_count]
    return selected


def main() -> None:
    args = parse_args()
    rows = collect(args)
    if len(rows) < args.target_count:
        raise SystemExit(f"Only collected {len(rows)} rows, expected {args.target_count}.")
    dump_jsonl(args.output, rows)
    print(f"Saved {len(rows)} rows to {Path(args.output).resolve()}")


if __name__ == "__main__":
    main()
