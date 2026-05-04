import argparse
import base64
import gzip
import json
from pathlib import Path


GENERATOR_TEMPLATE = r'''
import base64
import gc
import gzip
import glob
import json
import math
import subprocess
import sys
import re
from pathlib import Path

MODEL_NAME = __MODEL_NAME__
LANGUAGE = __LANGUAGE__
MAX_NEW_TOKENS = __MAX_NEW_TOKENS__
TEMPERATURE = __TEMPERATURE__
TOP_P = __TOP_P__
DATA_B64 = __DATA_B64__
HUMAN_INPUT_PATH = __HUMAN_INPUT_PATH__
INSTALL_P100_TORCH = __INSTALL_P100_TORCH__
OUTPUT_PATH = Path('/kaggle/working/qwen_batch_output_1000.jsonl')
PROGRESS_PATH = Path('/kaggle/working/qwen_generation_progress.json')


def run_python_module(args):
    subprocess.run([sys.executable, '-m', *args], check=True)


def get_nvidia_smi_name():
    try:
        completed = subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return completed.stdout.strip()
    except Exception:
        return ''


def find_local_p100_torch_wheel_dir():
    patterns = [
        '/kaggle/input/**/torch-2.6.0*cu124*cp312*.whl',
        '/kaggle/input/**/torch-2.6.0+cu124*.whl',
        '/kaggle/input/**/torch-2.6.0*.whl',
    ]
    for pattern in patterns:
        matches = glob.glob(pattern, recursive=True)
        if matches:
            return str(Path(matches[0]).resolve().parent)
    return None


GPU_NAME = get_nvidia_smi_name()
if INSTALL_P100_TORCH and 'P100' in GPU_NAME:
    print(f'Detected {GPU_NAME}; installing PyTorch 2.6.0 CUDA 12.4 for P100.', flush=True)
    run_python_module(['pip', 'uninstall', '-y', '-q', 'torchvision', 'torchaudio', 'torchao'])
    wheel_dir = find_local_p100_torch_wheel_dir()
    if wheel_dir:
        print(f'Installing PyTorch from local wheel dir: {wheel_dir}', flush=True)
        run_python_module([
            'pip', 'install', '-q', '--no-warn-conflicts', '--force-reinstall',
            '--no-cache-dir', '--no-index', '--find-links', wheel_dir, 'torch==2.6.0',
        ])
    else:
        run_python_module([
            'pip', 'install', '-q', '--no-warn-conflicts', '--force-reinstall',
            '--no-cache-dir', '--index-url', 'https://download.pytorch.org/whl/cu124',
            'torch==2.6.0',
        ])

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


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


def extract_code_block(response):
    if LANGUAGE == 'python':
        pattern = r'```(?:py(?:thon)?)?\n(.*?)```'
    elif LANGUAGE == 'java':
        pattern = r'```(?:java)?\n(.*?)```'
    else:
        pattern = r'```(?:cpp|c\+\+|cxx)?\n(.*?)```'
    matches = tuple(re.finditer(pattern, response, re.DOTALL))
    if len(matches) == 1:
        return compact_text(matches[0].group(1))
    fallback = compact_text(response)
    return fallback if len(fallback.splitlines()) > 1 else ''


def build_messages(problem):
    return [
        {
            'role': 'system',
            'content': (
                'You are a competitive programming assistant. Given a programming problem, '
                f'write a complete {LANGUAGE} solution. Return only the final code inside '
                'one markdown code block.'
            ),
        },
        {
            'role': 'user',
            'content': (
                f'{problem}\n\n'
                f'Solve this programming problem in {LANGUAGE}. The solution must read from '
                'standard input and write to standard output. Return only one complete '
                f'{LANGUAGE} code block.'
            ),
        },
    ]


def make_batch_like_row(task_id, raw_response):
    return {
        'custom_id': task_id,
        'response': {
            'status_code': 200,
            'body': {
                'choices': [
                    {
                        'message': {
                            'role': 'assistant',
                            'content': raw_response,
                        }
                    }
                ]
            },
        },
    }


def main():
    rows = load_rows()
    print(f'Loaded {len(rows)} tasks.')
    cuda_available = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if cuda_available else ''
    use_cuda = cuda_available and ('P100' not in gpu_name or INSTALL_P100_TORCH)
    if cuda_available and not use_cuda:
        print(f'CUDA device {gpu_name} is not supported by the installed PyTorch build; using CPU.')
    dtype = torch.float16 if use_cuda else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
    if use_cuda:
        model = AutoModelForCausalLM.from_pretrained(
            MODEL_NAME,
            torch_dtype=dtype,
            device_map='auto',
            trust_remote_code=True,
        )
    else:
        model = AutoModelForCausalLM.from_pretrained(
            MODEL_NAME,
            torch_dtype=dtype,
            trust_remote_code=True,
        )
        model.to('cpu')
    model.eval()

    done = set()
    if OUTPUT_PATH.exists():
        with OUTPUT_PATH.open('r', encoding='utf-8') as handle:
            for line in handle:
                if line.strip():
                    done.add(json.loads(line)['custom_id'])

    with OUTPUT_PATH.open('a', encoding='utf-8') as output:
        for index, row in enumerate(rows, start=1):
            task_id = row['task_id']
            if task_id in done:
                continue
            prompt = tokenizer.apply_chat_template(
                build_messages(row['text']),
                tokenize=False,
                add_generation_prompt=True,
            )
            inputs = tokenizer([prompt], return_tensors='pt').to(model.device)
            with torch.no_grad():
                generated = model.generate(
                    **inputs,
                    max_new_tokens=MAX_NEW_TOKENS,
                    do_sample=True,
                    temperature=TEMPERATURE,
                    top_p=TOP_P,
                    pad_token_id=tokenizer.eos_token_id,
                )
            new_tokens = generated[:, inputs.input_ids.shape[-1]:]
            raw_response = tokenizer.batch_decode(new_tokens, skip_special_tokens=True)[0]
            code = extract_code_block(raw_response)
            if not code:
                raw_response = '```' + LANGUAGE + '\n' + compact_text(raw_response) + '\n```'
            output.write(json.dumps(make_batch_like_row(task_id, raw_response), ensure_ascii=False) + '\n')
            output.flush()

            if index % 10 == 0:
                PROGRESS_PATH.write_text(
                    json.dumps({'processed_index': index, 'task_id': task_id}, ensure_ascii=False, indent=2),
                    encoding='utf-8',
                )
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            print(f'[{index}/{len(rows)}] generated {task_id}')

    print(f'Done. Output: {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare a Kaggle kernel that generates AI code for eval tasks.")
    parser.add_argument("--human-source", required=True, help="human_1000 JSON/JSONL file.")
    parser.add_argument("--output-dir", required=True, help="Local Kaggle kernel directory to create.")
    parser.add_argument("--kernel-id", required=True, help="Kaggle kernel id, e.g. username/hydro-ai-dataset-generator.")
    parser.add_argument("--title", default="Hydro AI Dataset Generator", help="Kaggle kernel title.")
    parser.add_argument("--model", default="Qwen/Qwen2.5-Coder-0.5B-Instruct", help="HF model id on Kaggle.")
    parser.add_argument("--language", default="cpp", choices=["cpp", "python", "java"], help="Target code language.")
    parser.add_argument("--max-new-tokens", type=int, default=768, help="Generation limit per task.")
    parser.add_argument("--temperature", type=float, default=0.2, help="Sampling temperature.")
    parser.add_argument("--top-p", type=float, default=0.95, help="Top-p sampling.")
    parser.add_argument(
        "--install-p100-torch",
        action="store_true",
        help="Install a P100-compatible PyTorch build at Kaggle runtime before generation.",
    )
    parser.add_argument(
        "--kaggle-human-path",
        help="Path inside Kaggle input to human_1000.jsonl. If omitted, prompts are embedded into the script.",
    )
    parser.add_argument(
        "--dataset-source",
        action="append",
        default=[],
        help="Kaggle dataset source to attach to the kernel, e.g. username/dataset-slug.",
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
    code_path = output_dir / "generate_ai_dataset.py"
    metadata_path = output_dir / "kernel-metadata.json"

    generator_code = (
        GENERATOR_TEMPLATE
        .replace("__MODEL_NAME__", repr(args.model))
        .replace("__LANGUAGE__", repr(args.language))
        .replace("__MAX_NEW_TOKENS__", str(args.max_new_tokens))
        .replace("__TEMPERATURE__", str(args.temperature))
        .replace("__TOP_P__", str(args.top_p))
        .replace("__DATA_B64__", repr(data_b64))
        .replace("__HUMAN_INPUT_PATH__", repr(args.kaggle_human_path or ""))
        .replace("__INSTALL_P100_TORCH__", repr(bool(args.install_p100_torch)))
    )
    code_path.write_text(generator_code, encoding="utf-8")
    metadata = {
        "id": args.kernel_id,
        "title": args.title,
        "code_file": "generate_ai_dataset.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_tpu": False,
        "enable_internet": True,
        "keywords": [],
        "dataset_sources": args.dataset_source,
        "kernel_sources": [],
        "competition_sources": [],
        "model_sources": [],
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {code_path.resolve()}")
    print(f"Wrote {metadata_path.resolve()}")


if __name__ == "__main__":
    main()
