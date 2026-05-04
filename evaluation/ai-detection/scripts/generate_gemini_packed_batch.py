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
    "You are a competitive programming assistant. Generate independent, complete "
    "{language} solutions for the requested programming problems. Each solution "
    "must read from standard input and write to standard output."
)

USER_PROMPT_HEADER = (
    "Solve every task below in {language}.\n\n"
    "Return exactly one section per task in this format, with no extra text:\n"
    "### TASK_ID: <task_id>\n"
    "```{language}\n"
    "<complete source code>\n"
    "```\n"
    "### END_TASK\n\n"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate multiple Gemini AI code samples per request and write "
            "OpenAI-batch-like JSONL compatible with prepare_eval_dataset.py."
        )
    )
    parser.add_argument("--input", required=True, help="Human JSONL/JSON/CSV with task_id and text.")
    parser.add_argument("--output", required=True, help="Output JSONL compatible with prepare_eval_dataset.py --batch-output.")
    parser.add_argument("--model", default="gemini-2.5-flash", help="Gemini model id.")
    parser.add_argument("--language", default="cpp", choices=["cpp", "python", "java"])
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--top-p", type=float, default=0.95)
    parser.add_argument("--max-output-tokens", type=int, default=16384)
    parser.add_argument("--limit", type=int, help="Only consider the first N human rows.")
    parser.add_argument("--pack-size", type=int, default=4, help="Number of tasks to ask Gemini to solve per request.")
    parser.add_argument("--sleep-seconds", type=float, default=8.0)
    parser.add_argument("--max-retries", type=int, default=3)
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


def extract_batch_content(batch_row: dict) -> str:
    response = batch_row.get("response", {})
    body = response.get("body", {}) if isinstance(response, dict) else {}
    choices = body.get("choices", []) if isinstance(body, dict) else []
    if not choices:
        return ""
    message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
    return str(message.get("content") or "")


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


def task_id_for(row: dict) -> str:
    return str(row.get("task_id") or row.get("problem_id") or "").strip()


def problem_for(row: dict) -> str:
    return compact_text(str(row.get("text") or row.get("problem") or row.get("description") or ""))


def gemini_text(payload: dict) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    return "".join(str(part.get("text") or "") for part in parts)


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


def build_prompt(batch: list[tuple[str, str]], language: str) -> str:
    parts = [USER_PROMPT_HEADER.format(language=language)]
    for task_id, problem in batch:
        parts.append(f"## TASK_ID: {task_id}\n{problem}\n")
    return "\n".join(parts)


def call_gemini_pack(api_key: str, model: str, language: str, batch: list[tuple[str, str]], args: argparse.Namespace) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    request_body = {
        "systemInstruction": {
            "parts": [{"text": SYSTEM_PROMPT.format(language=language)}],
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": build_prompt(batch, language)}],
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
    with urllib.request.urlopen(request, timeout=240) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return gemini_text(payload)


def extract_code_block(section: str, language: str) -> str:
    if language == "python":
        pattern = r"```(?:py(?:thon)?)?\s*\n(.*?)```"
    elif language == "java":
        pattern = r"```(?:java)?\s*\n(.*?)```"
    else:
        pattern = r"```(?:cpp|c\+\+|cxx)?\s*\n(.*?)```"
    match = re.search(pattern, section, flags=re.DOTALL | re.IGNORECASE)
    if match:
        return compact_text(match.group(1))
    return ""


def parse_solutions(response: str, expected_ids: set[str], language: str) -> dict[str, str]:
    parsed = {}
    headers = list(re.finditer(r"^### TASK_ID:\s*(.+?)\s*$", response, flags=re.MULTILINE))
    for index, header in enumerate(headers):
        task_id = header.group(1).strip()
        if task_id not in expected_ids:
            continue
        end = headers[index + 1].start() if index + 1 < len(headers) else len(response)
        section = response[header.end() : end]
        code = extract_code_block(section, language)
        if code:
            parsed[task_id] = code
    return parsed


def chunked(rows: list[dict], size: int) -> list[list[dict]]:
    return [rows[index : index + size] for index in range(0, len(rows), size)]


def generate(args: argparse.Namespace) -> None:
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("Missing GOOGLE_API_KEY or GEMINI_API_KEY environment variable.")
    if args.pack_size < 1:
        raise SystemExit("--pack-size must be at least 1.")

    rows = load_records(args.input)
    if args.limit:
        rows = rows[: args.limit]

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    completed = done_ids(output_path)
    candidates = [row for row in rows if task_id_for(row) and problem_for(row) and task_id_for(row) not in completed]

    with output_path.open("a", encoding="utf-8", newline="") as output:
        for batch_index, row_batch in enumerate(chunked(candidates, args.pack_size), start=1):
            batch = [(task_id_for(row), problem_for(row)) for row in row_batch]
            expected_ids = {task_id for task_id, _ in batch}
            parsed: dict[str, str] = {}
            last_error = ""

            for attempt in range(1, args.max_retries + 1):
                try:
                    response = call_gemini_pack(api_key, args.model, args.language, batch, args)
                    parsed = parse_solutions(response, expected_ids, args.language)
                    if parsed:
                        break
                    last_error = "Gemini response contained no parseable task sections."
                except urllib.error.HTTPError as exc:
                    body = exc.read().decode("utf-8", errors="replace")
                    last_error = f"HTTP {exc.code}: {body[:1000]}"
                except Exception as exc:
                    last_error = f"{type(exc).__name__}: {exc}"

                if attempt < args.max_retries:
                    retry_after = retry_delay_from_error(last_error)
                    wait = retry_after if retry_after is not None else min(90.0, args.sleep_seconds * (2 ** (attempt - 1))) + random.random()
                    print(f"[retry {attempt}/{args.max_retries}] pack {batch_index}: {last_error}; sleep {wait:.1f}s")
                    time.sleep(wait)
                else:
                    print(f"[retry {attempt}/{args.max_retries}] pack {batch_index}: {last_error}; no retries left")

            if parsed:
                for task_id, code in parsed.items():
                    content = f"```{args.language}\n{code}\n```"
                    output.write(json.dumps(make_batch_like_row(task_id, content, args.model), ensure_ascii=False) + "\n")
                    completed.add(task_id)
                missing = sorted(expected_ids - set(parsed))
                print(
                    f"[pack {batch_index}/{(len(candidates) + args.pack_size - 1) // args.pack_size}] "
                    f"ok {len(parsed)}/{len(batch)} total_ok={len(completed)} missing={len(missing)}"
                )
                if missing:
                    print("missing: " + ", ".join(missing[:8]))
            else:
                if args.stop_on_quota and ("HTTP 429" in last_error or "RESOURCE_EXHAUSTED" in last_error):
                    raise SystemExit(f"Stopping on quota exhaustion at pack {batch_index}: {last_error[:500]}")
                print(f"[pack {batch_index}] no rows written: {last_error}")

            output.flush()
            time.sleep(args.sleep_seconds)


def main() -> None:
    generate(parse_args())


if __name__ == "__main__":
    main()
