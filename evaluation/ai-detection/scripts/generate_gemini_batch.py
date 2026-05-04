import argparse
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


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
    parser = argparse.ArgumentParser(description="Generate AI code with Gemini and write OpenAI-batch-like JSONL.")
    parser.add_argument("--input", required=True, help="Human JSONL/JSON/CSV with task_id and text.")
    parser.add_argument("--output", required=True, help="Output JSONL compatible with prepare_eval_dataset.py --batch-output.")
    parser.add_argument("--model", default="gemini-2.0-flash", help="Gemini model id.")
    parser.add_argument("--language", default="cpp", choices=["cpp", "python", "java"])
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--top-p", type=float, default=0.95)
    parser.add_argument("--max-output-tokens", type=int, default=4096)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--sleep-seconds", type=float, default=1.0)
    parser.add_argument("--max-retries", type=int, default=6)
    parser.add_argument(
        "--stop-on-quota",
        action="store_true",
        help="Stop without writing an error row when Gemini quota remains exhausted after retries.",
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
        import csv

        with target.open("r", encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    raise ValueError(f"Unsupported input file: {target}")


def done_ids(path: str | Path) -> set[str]:
    target = Path(path)
    if not target.exists():
        return set()
    ids = set()
    with target.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("custom_id") and extract_batch_content(row):
                ids.add(str(row["custom_id"]))
    return ids


def compact_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def gemini_text(payload: dict) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    return "".join(str(part.get("text") or "") for part in parts)


def extract_batch_content(batch_row: dict) -> str:
    response = batch_row.get("response", {})
    body = response.get("body", {}) if isinstance(response, dict) else {}
    choices = body.get("choices", []) if isinstance(body, dict) else []
    if not choices:
        return ""
    message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
    return str(message.get("content") or "")


def retry_delay_from_error(message: str) -> float | None:
    match = re.search(r"retry in ([0-9]+(?:\.[0-9]+)?)s", message, flags=re.IGNORECASE)
    if match:
        return float(match.group(1)) + 2.0
    return None


def make_batch_like_row(task_id: str, content: str, model: str) -> dict:
    return {
        "custom_id": task_id,
        "response": {
            "status_code": 200,
            "body": {
                "model": model,
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": content,
                        }
                    }
                ],
            },
        },
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }


def make_error_row(task_id: str, message: str, model: str) -> dict:
    return {
        "custom_id": task_id,
        "error": {"message": message},
        "response": {"status_code": 500, "body": {"model": model, "choices": []}},
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }


def call_gemini(api_key: str, model: str, language: str, problem: str, args: argparse.Namespace) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    request_body = {
        "systemInstruction": {
            "parts": [{"text": SYSTEM_PROMPT.format(language=language)}],
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": USER_PROMPT.format(problem=problem, language=language)}],
            }
        ],
        "generationConfig": {
            "temperature": args.temperature,
            "topP": args.top_p,
            "maxOutputTokens": args.max_output_tokens,
        },
    }
    data = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return gemini_text(payload)


def generate(args: argparse.Namespace) -> None:
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("Missing GOOGLE_API_KEY or GEMINI_API_KEY environment variable.")

    rows = load_records(args.input)
    if args.limit:
        rows = rows[: args.limit]

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    completed = done_ids(output_path)

    with output_path.open("a", encoding="utf-8", newline="") as output:
        for index, row in enumerate(rows, start=1):
            task_id = str(row.get("task_id") or row.get("problem_id") or "").strip()
            problem = compact_text(str(row.get("text") or row.get("problem") or row.get("description") or ""))
            if not task_id or not problem or task_id in completed:
                continue

            content = ""
            last_error = ""
            for attempt in range(1, args.max_retries + 1):
                try:
                    content = call_gemini(api_key, args.model, args.language, problem, args)
                    if content.strip():
                        break
                    last_error = "Gemini returned an empty response."
                except urllib.error.HTTPError as exc:
                    body = exc.read().decode("utf-8", errors="replace")
                    last_error = f"HTTP {exc.code}: {body[:1000]}"
                except Exception as exc:
                    last_error = f"{type(exc).__name__}: {exc}"
                if attempt < args.max_retries:
                    retry_after = retry_delay_from_error(last_error)
                    wait = retry_after if retry_after is not None else min(90.0, args.sleep_seconds * (2 ** (attempt - 1))) + random.random()
                    print(f"[retry {attempt}/{args.max_retries}] {task_id}: {last_error}; sleep {wait:.1f}s")
                    time.sleep(wait)
                else:
                    print(f"[retry {attempt}/{args.max_retries}] {task_id}: {last_error}; no retries left")

            if content.strip():
                output.write(json.dumps(make_batch_like_row(task_id, content, args.model), ensure_ascii=False) + "\n")
                completed.add(task_id)
                print(f"[{index}/{len(rows)}] ok {task_id}")
            else:
                if args.stop_on_quota and ("HTTP 429" in last_error or "RESOURCE_EXHAUSTED" in last_error):
                    raise SystemExit(f"Stopping on quota exhaustion at {task_id}: {last_error[:500]}")
                output.write(json.dumps(make_error_row(task_id, last_error, args.model), ensure_ascii=False) + "\n")
                print(f"[{index}/{len(rows)}] error {task_id}: {last_error}")
            output.flush()
            time.sleep(args.sleep_seconds)


def main() -> None:
    generate(parse_args())


if __name__ == "__main__":
    main()
