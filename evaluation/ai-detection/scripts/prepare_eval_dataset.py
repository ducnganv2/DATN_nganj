import argparse
import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


SYSTEM_PROMPT = (
    "You are a competitive programming assistant. Given a programming problem, "
    "write a complete {language} solution. Return only the final code inside one "
    "markdown code block."
)

USER_PROMPT = (
    "{problem}\n\n"
    "Solve this programming problem in {language}. The solution must read from "
    "standard input and write to standard output. Return only one complete "
    "{language} code block."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare a 1000-human + 1000-AI evaluation dataset for the Hydro "
            "production AI detector."
        )
    )
    parser.add_argument("--human-source", required=True, help="Human source dataset (.jsonl, .json, or .csv).")
    parser.add_argument("--output-dir", required=True, help="Output directory under Hydro-master.")
    parser.add_argument("--limit", type=int, default=1000, help="Number of human tasks to keep.")
    parser.add_argument("--language", default="cpp", choices=["cpp", "python", "java"], help="AI target language.")
    parser.add_argument("--ai-model", default="gpt-4o-mini", help="AI generator model recorded in request/pair files.")
    parser.add_argument(
        "--batch-output",
        help="Optional completed OpenAI Batch output JSONL. When provided, paired AI/human datasets are generated.",
    )
    parser.add_argument(
        "--request-output-name",
        default="openai_batch_requests_1000.jsonl",
        help="Filename for OpenAI Batch request JSONL.",
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


def compact_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def first_value(*values) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def normalize_human_rows(rows: list[dict], limit: int) -> list[dict]:
    normalized = []
    seen = set()
    for row in rows:
        task_id = first_value(row.get("task_id"), row.get("problem_id"), row.get("sample_id"))
        text = first_value(row.get("text"), row.get("problem"), row.get("description"), row.get("statement"))
        code = first_value(row.get("code"), row.get("human_code"), row.get("source_code"), row.get("solution"))
        if not task_id or not text or not code or task_id in seen:
            continue
        seen.add(task_id)
        normalized.append(
            {
                "task_id": task_id,
                "problem_id": first_value(row.get("problem_id"), task_id),
                "title": first_value(row.get("title"), row.get("name")),
                "text": compact_text(text),
                "human_code": compact_text(code),
                "code": compact_text(code),
                "human_label": 0,
                "source": first_value(row.get("source"), "deepmind_code_contests_human"),
                "human_language": first_value(row.get("human_language"), row.get("language")),
                "dataset_name": first_value(row.get("dataset_name")),
                "dataset_split": first_value(row.get("dataset_split")),
            }
        )
        if len(normalized) >= limit:
            break
    if len(normalized) < limit:
        raise ValueError(f"Only found {len(normalized)} usable human rows, expected {limit}.")
    return normalized


def build_openai_batch_requests(human_rows: list[dict], model: str, language: str) -> list[dict]:
    requests = []
    for row in human_rows:
        requests.append(
            {
                "custom_id": row["task_id"],
                "method": "POST",
                "url": "/v1/chat/completions",
                "body": {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT.format(language=language)},
                        {"role": "user", "content": USER_PROMPT.format(problem=row["text"], language=language)},
                    ],
                    "temperature": 0.2,
                    "top_p": 0.95,
                    "max_completion_tokens": 4096,
                },
            }
        )
    return requests


def extract_batch_content(batch_row: dict) -> str:
    response = batch_row.get("response", {})
    body = response.get("body", {}) if isinstance(response, dict) else {}
    choices = body.get("choices", []) if isinstance(body, dict) else []
    if not choices:
        return ""
    message = choices[0].get("message", {})
    return message.get("content", "") or ""


def extract_code_block(response: str, language: str) -> str:
    if language == "python":
        pattern = r"```(?:py(?:thon)?)?\n(.*?)```"
    elif language == "java":
        pattern = r"```(?:java)?\n(.*?)```"
    else:
        pattern = r"```(?:cpp|c\+\+|cxx)?\n(.*?)```"
    matches = tuple(re.finditer(pattern, response, re.DOTALL))
    if len(matches) == 1:
        return compact_text(matches[0].group(1))
    fallback = compact_text(response)
    return fallback if len(fallback.splitlines()) > 1 else ""


def merge_ai_rows(human_rows: list[dict], batch_output_path: str, model: str, language: str) -> tuple[list[dict], list[str]]:
    human_by_id = {row["task_id"]: dict(row) for row in human_rows}
    ai_by_id = {}
    for batch_row in load_records(batch_output_path):
        task_id = batch_row.get("custom_id")
        if task_id not in human_by_id:
            continue
        raw_response = extract_batch_content(batch_row)
        ai_code = extract_code_block(raw_response, language)
        if ai_code:
            ai_by_id[task_id] = {
                "raw_model_response": raw_response,
                "ai_code": ai_code,
                "model_response": ai_code,
            }

    pairs = []
    missing_task_ids = []
    generated_at = datetime.now(timezone.utc).isoformat()
    for row in human_rows:
        ai_payload = ai_by_id.get(row["task_id"])
        if not ai_payload:
            missing_task_ids.append(row["task_id"])
            continue
        pairs.append(
            {
                **row,
                **ai_payload,
                "ai_label": 1,
                "ai_model": model,
                "ai_generated_at_utc": generated_at,
            }
        )
    return pairs, missing_task_ids


def flatten_pairs(pairs: list[dict]) -> list[dict]:
    samples = []
    for row in pairs:
        shared = {
            "task_id": row["task_id"],
            "problem_id": row.get("problem_id", ""),
            "title": row.get("title", ""),
            "language": row.get("human_language", ""),
            "ai_model": row.get("ai_model", ""),
        }
        samples.append(
            {
                **shared,
                "sample_id": f"{row['task_id']}_human",
                "variant": "human",
                "label": 0,
                "code": row["human_code"],
            }
        )
        samples.append(
            {
                **shared,
                "sample_id": f"{row['task_id']}_ai",
                "variant": "ai",
                "label": 1,
                "code": row["ai_code"],
            }
        )
    return samples


def write_manifest(output_dir: Path, payload: dict) -> None:
    manifest_path = output_dir / "manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    data_dir = output_dir / "data"
    request_dir = output_dir / "requests"

    human_rows = normalize_human_rows(load_records(args.human_source), args.limit)
    dump_records(data_dir / "human_1000.jsonl", human_rows)
    dump_records(data_dir / "human_1000.json", human_rows)
    dump_records(data_dir / "human_1000.csv", human_rows)

    requests = build_openai_batch_requests(human_rows, args.ai_model, args.language)
    dump_records(request_dir / args.request_output_name, requests)

    manifest = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "human_count": len(human_rows),
        "ai_count": 0,
        "total_sample_count": len(human_rows),
        "language": args.language,
        "ai_model": args.ai_model,
        "human_source": str(Path(args.human_source).resolve()),
        "openai_batch_request_file": str((request_dir / args.request_output_name).resolve()),
        "status": "human_ready_ai_missing",
    }

    if args.batch_output:
        pairs, missing_task_ids = merge_ai_rows(human_rows, args.batch_output, args.ai_model, args.language)
        samples = flatten_pairs(pairs)
        dump_records(data_dir / "pairs_1000.jsonl", pairs)
        dump_records(data_dir / "pairs_1000.json", pairs)
        dump_records(data_dir / "pairs_1000.csv", pairs)
        dump_records(data_dir / "samples_2000.jsonl", samples)
        dump_records(data_dir / "samples_2000.json", samples)
        dump_records(data_dir / "samples_2000.csv", samples)
        dump_records(data_dir / "missing_ai_task_ids.json", [{"task_id": task_id} for task_id in missing_task_ids])
        manifest.update(
            {
                "ai_count": len(pairs),
                "total_sample_count": len(samples),
                "batch_output": str(Path(args.batch_output).resolve()),
                "paired_dataset_json": str((data_dir / "pairs_1000.json").resolve()),
                "labeled_samples_csv": str((data_dir / "samples_2000.csv").resolve()),
                "missing_ai_count": len(missing_task_ids),
                "status": "complete" if len(pairs) == args.limit else "partial_ai",
            }
        )

    write_manifest(output_dir, manifest)
    print(f"Human rows: {manifest['human_count']}")
    print(f"AI rows: {manifest['ai_count']}")
    print(f"Status: {manifest['status']}")
    print(f"Output: {output_dir.resolve()}")


if __name__ == "__main__":
    main()
