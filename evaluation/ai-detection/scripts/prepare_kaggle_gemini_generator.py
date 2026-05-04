import argparse
import base64
import gzip
import json
from pathlib import Path


GENERATOR_TEMPLATE = r'''
import base64
import gzip
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MODEL_NAME = __MODEL_NAME__
LANGUAGE = __LANGUAGE__
MAX_OUTPUT_TOKENS = __MAX_OUTPUT_TOKENS__
TEMPERATURE = __TEMPERATURE__
TOP_P = __TOP_P__
PACK_SIZE = __PACK_SIZE__
SLEEP_SECONDS = __SLEEP_SECONDS__
MAX_RETRIES = __MAX_RETRIES__
DATA_B64 = __DATA_B64__
HUMAN_INPUT_PATH = __HUMAN_INPUT_PATH__
OUTPUT_PATH = Path('/kaggle/working/gemini_batch_output_1000.jsonl')
PROGRESS_PATH = Path('/kaggle/working/gemini_generation_progress.json')

SYSTEM_PROMPT = (
    "You are a competitive programming assistant. Generate independent, complete "
    f"{LANGUAGE} solutions for the requested programming problems. Each solution "
    "must read from standard input and write to standard output."
)

USER_PROMPT_HEADER = (
    f"Solve every task below in {LANGUAGE}.\n\n"
    "Return exactly one section per task in this format, with no extra text:\n"
    "### TASK_ID: <task_id>\n"
    f"```{LANGUAGE}\n"
    "<complete source code>\n"
    "```\n"
    "### END_TASK\n\n"
)


def get_api_key():
    try:
        from kaggle_secrets import UserSecretsClient

        key = UserSecretsClient().get_secret('GOOGLE_API_KEY')
        if key:
            return key
    except Exception as exc:
        print(f'Could not read Kaggle secret GOOGLE_API_KEY: {type(exc).__name__}: {exc}')
    key = os.environ.get('GOOGLE_API_KEY') or os.environ.get('GEMINI_API_KEY')
    if key:
        return key
    raise RuntimeError('Missing Kaggle secret GOOGLE_API_KEY.')


def load_rows():
    if HUMAN_INPUT_PATH:
        with Path(HUMAN_INPUT_PATH).open('r', encoding='utf-8-sig') as handle:
            return [json.loads(line) for line in handle if line.strip()]
    raw = gzip.decompress(base64.b64decode(DATA_B64)).decode('utf-8')
    return json.loads(raw)


def compact_text(value):
    value = value.replace('\r\n', '\n').replace('\r', '\n')
    value = re.sub(r'[ \t]+\n', '\n', value)
    value = re.sub(r'\n{3,}', '\n\n', value)
    return value.strip()


def extract_batch_content(batch_row):
    response = batch_row.get('response', {})
    body = response.get('body', {}) if isinstance(response, dict) else {}
    choices = body.get('choices', []) if isinstance(body, dict) else []
    if not choices:
        return ''
    message = choices[0].get('message', {}) if isinstance(choices[0], dict) else {}
    return str(message.get('content') or '')


def done_ids():
    if not OUTPUT_PATH.exists():
        return set()
    ids = set()
    with OUTPUT_PATH.open('r', encoding='utf-8-sig') as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get('custom_id') and extract_batch_content(row):
                ids.add(str(row['custom_id']))
    return ids


def gemini_text(payload):
    candidates = payload.get('candidates') or []
    if not candidates:
        return ''
    content = candidates[0].get('content') or {}
    parts = content.get('parts') or []
    return ''.join(str(part.get('text') or '') for part in parts)


def retry_delay_from_error(message):
    match = re.search(r'retry in ([0-9]+(?:\.[0-9]+)?)s', message, flags=re.IGNORECASE)
    if match:
        return float(match.group(1)) + 2.0
    return None


def build_prompt(batch):
    parts = [USER_PROMPT_HEADER]
    for task_id, problem in batch:
        parts.append(f'## TASK_ID: {task_id}\n{problem}\n')
    return '\n'.join(parts)


def call_gemini(api_key, batch):
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent?key={api_key}'
    request_body = {
        'systemInstruction': {
            'parts': [{'text': SYSTEM_PROMPT}],
        },
        'contents': [
            {
                'role': 'user',
                'parts': [{'text': build_prompt(batch)}],
            }
        ],
        'generationConfig': {
            'temperature': TEMPERATURE,
            'topP': TOP_P,
            'maxOutputTokens': MAX_OUTPUT_TOKENS,
        },
    }
    data = json.dumps(request_body, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(
        url,
        data=data,
        headers={'Content-Type': 'application/json; charset=utf-8'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=240) as response:
        payload = json.loads(response.read().decode('utf-8'))
    return gemini_text(payload)


def extract_code_block(section):
    if LANGUAGE == 'python':
        pattern = r'```(?:py(?:thon)?)?\s*\n(.*?)```'
    elif LANGUAGE == 'java':
        pattern = r'```(?:java)?\s*\n(.*?)```'
    else:
        pattern = r'```(?:cpp|c\+\+|cxx)?\s*\n(.*?)```'
    match = re.search(pattern, section, flags=re.DOTALL | re.IGNORECASE)
    if match:
        return compact_text(match.group(1))
    return ''


def parse_solutions(response, expected_ids):
    parsed = {}
    headers = list(re.finditer(r'^### TASK_ID:\s*(.+?)\s*$', response, flags=re.MULTILINE))
    for index, header in enumerate(headers):
        task_id = header.group(1).strip()
        if task_id not in expected_ids:
            continue
        end = headers[index + 1].start() if index + 1 < len(headers) else len(response)
        section = response[header.end() : end]
        code = extract_code_block(section)
        if code:
            parsed[task_id] = code
    return parsed


def make_batch_like_row(task_id, code):
    return {
        'custom_id': task_id,
        'response': {
            'status_code': 200,
            'body': {
                'model': MODEL_NAME,
                'choices': [
                    {
                        'message': {
                            'role': 'assistant',
                            'content': f'```{LANGUAGE}\n{code}\n```',
                        }
                    }
                ],
            },
        },
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
    }


def chunks(items, size):
    for index in range(0, len(items), size):
        yield items[index : index + size]


def write_progress(processed, total, done_count, last_pack):
    PROGRESS_PATH.write_text(
        json.dumps(
            {
                'processed_candidates': processed,
                'total_candidates': total,
                'done_count': done_count,
                'last_pack': last_pack,
                'output_path': str(OUTPUT_PATH),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding='utf-8',
    )


def main():
    api_key = get_api_key()
    rows = load_rows()
    completed = done_ids()
    candidates = [
        row for row in rows
        if row.get('task_id') and row.get('text') and str(row['task_id']) not in completed
    ]
    total_packs = (len(candidates) + PACK_SIZE - 1) // PACK_SIZE
    print(f'Loaded {len(rows)} tasks. Already done: {len(completed)}. Remaining: {len(candidates)}.')
    print(f'Model={MODEL_NAME}, pack_size={PACK_SIZE}, total_packs={total_packs}')

    processed = 0
    with OUTPUT_PATH.open('a', encoding='utf-8') as output:
        for pack_index, row_pack in enumerate(chunks(candidates, PACK_SIZE), start=1):
            batch = [(str(row['task_id']), compact_text(str(row['text']))) for row in row_pack]
            expected_ids = {task_id for task_id, _ in batch}
            parsed = {}
            last_error = ''

            for attempt in range(1, MAX_RETRIES + 1):
                try:
                    response = call_gemini(api_key, batch)
                    parsed = parse_solutions(response, expected_ids)
                    if parsed:
                        break
                    last_error = 'Gemini response contained no parseable task sections.'
                except urllib.error.HTTPError as exc:
                    body = exc.read().decode('utf-8', errors='replace')
                    last_error = f'HTTP {exc.code}: {body[:1000]}'
                except Exception as exc:
                    last_error = f'{type(exc).__name__}: {exc}'

                if attempt < MAX_RETRIES:
                    retry_after = retry_delay_from_error(last_error)
                    wait = retry_after if retry_after is not None else min(90.0, SLEEP_SECONDS * (2 ** (attempt - 1))) + random.random()
                    print(f'[retry {attempt}/{MAX_RETRIES}] pack {pack_index}: {last_error}; sleep {wait:.1f}s', flush=True)
                    time.sleep(wait)
                else:
                    print(f'[retry {attempt}/{MAX_RETRIES}] pack {pack_index}: {last_error}; no retries left', flush=True)

            if not parsed:
                write_progress(processed, len(candidates), len(completed), pack_index)
                if 'HTTP 429' in last_error or 'RESOURCE_EXHAUSTED' in last_error:
                    raise SystemExit(f'Stopping on quota exhaustion at pack {pack_index}: {last_error[:500]}')
                print(f'[pack {pack_index}/{total_packs}] no rows written: {last_error}', flush=True)
                continue

            for task_id, code in parsed.items():
                if task_id in completed:
                    continue
                output.write(json.dumps(make_batch_like_row(task_id, code), ensure_ascii=False) + '\n')
                completed.add(task_id)
            output.flush()

            processed += len(row_pack)
            missing = sorted(expected_ids - set(parsed))
            print(
                f'[pack {pack_index}/{total_packs}] ok {len(parsed)}/{len(row_pack)} '
                f'total_done={len(completed)} missing={len(missing)}',
                flush=True,
            )
            if missing:
                print('missing: ' + ', '.join(missing[:8]), flush=True)
            write_progress(processed, len(candidates), len(completed), pack_index)
            time.sleep(SLEEP_SECONDS)

    print(f'Done. Output: {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare a Kaggle kernel that generates AI code with Gemini.")
    parser.add_argument("--human-source", required=True, help="human_1000 JSON/JSONL file.")
    parser.add_argument("--output-dir", required=True, help="Local Kaggle kernel directory to create.")
    parser.add_argument("--kernel-id", required=True, help="Kaggle kernel id, e.g. username/hydro-ai-gemini-generator.")
    parser.add_argument("--title", default="Hydro AI Dataset Gemini Generator", help="Kaggle kernel title.")
    parser.add_argument("--model", default="gemini-2.5-flash", help="Gemini model id.")
    parser.add_argument("--language", default="cpp", choices=["cpp", "python", "java"], help="Target code language.")
    parser.add_argument("--max-output-tokens", type=int, default=24576, help="Gemini max output tokens per packed request.")
    parser.add_argument("--temperature", type=float, default=0.2, help="Sampling temperature.")
    parser.add_argument("--top-p", type=float, default=0.95, help="Top-p sampling.")
    parser.add_argument("--pack-size", type=int, default=5, help="Tasks per Gemini request.")
    parser.add_argument("--sleep-seconds", type=float, default=8.0, help="Delay between Gemini requests.")
    parser.add_argument("--max-retries", type=int, default=4, help="Retries per packed request.")
    parser.add_argument(
        "--kaggle-human-path",
        help="Path inside Kaggle input to human_1000.jsonl. If omitted, prompts are embedded into the script.",
    )
    return parser.parse_args()


def load_records(path: Path) -> list[dict]:
    if path.suffix.lower() == ".jsonl":
        with path.open("r", encoding="utf-8-sig") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    with path.open("r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise ValueError(f"Expected a JSON array in {path}")
    return payload


def main() -> None:
    args = parse_args()
    data_b64 = ""
    if not args.kaggle_human_path:
        rows = load_records(Path(args.human_source))
        payload_rows = [
            {
                "task_id": row["task_id"],
                "text": row["text"],
            }
            for row in rows
        ]
        compressed = gzip.compress(json.dumps(payload_rows, ensure_ascii=False).encode("utf-8"), compresslevel=9)
        data_b64 = base64.b64encode(compressed).decode("ascii")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    code_path = output_dir / "generate_ai_dataset_gemini.py"
    metadata_path = output_dir / "kernel-metadata.json"

    generator_code = (
        GENERATOR_TEMPLATE
        .replace("__MODEL_NAME__", repr(args.model))
        .replace("__LANGUAGE__", repr(args.language))
        .replace("__MAX_OUTPUT_TOKENS__", str(args.max_output_tokens))
        .replace("__TEMPERATURE__", str(args.temperature))
        .replace("__TOP_P__", str(args.top_p))
        .replace("__PACK_SIZE__", str(args.pack_size))
        .replace("__SLEEP_SECONDS__", str(args.sleep_seconds))
        .replace("__MAX_RETRIES__", str(args.max_retries))
        .replace("__DATA_B64__", repr(data_b64))
        .replace("__HUMAN_INPUT_PATH__", repr(args.kaggle_human_path or ""))
    )
    code_path.write_text(generator_code, encoding="utf-8")

    metadata = {
        "id": args.kernel_id,
        "title": args.title,
        "code_file": "generate_ai_dataset_gemini.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": False,
        "enable_tpu": False,
        "enable_internet": True,
        "keywords": [],
        "dataset_sources": [],
        "kernel_sources": [],
        "competition_sources": [],
        "model_sources": [],
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {code_path.resolve()}")
    print(f"Wrote {metadata_path.resolve()}")


if __name__ == "__main__":
    main()
