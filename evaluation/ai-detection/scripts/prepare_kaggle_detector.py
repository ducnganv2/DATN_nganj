import argparse
import json
from pathlib import Path


DETECTOR_TEMPLATE = r'''
import gc
import glob
import importlib.util
import json
import math
import os
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

SAMPLES_INPUT_PATH = __SAMPLES_INPUT_PATH__
ATC_RUNTIME_PATH = __ATC_RUNTIME_PATH__
BASE_MODEL_NAME = __BASE_MODEL_NAME__
LANGUAGE = __LANGUAGE__
METHOD = __METHOD__
THRESHOLD = __THRESHOLD__
PROMPT_STYLE = __PROMPT_STYLE__
PATTERN_WEIGHT_MAPPING = __PATTERN_WEIGHT_MAPPING__
DEVICE_PREFERENCE = __DEVICE_PREFERENCE__
ALLOW_CPU_FALLBACK = __ALLOW_CPU_FALLBACK__
INSTALL_P100_TORCH = __INSTALL_P100_TORCH__
P100_TORCH_WHEEL_PATH = __P100_TORCH_WHEEL_PATH__
MIN_NONEMPTY_LINES = __MIN_NONEMPTY_LINES__
MIN_NONWHITESPACE_CHARS = __MIN_NONWHITESPACE_CHARS__
PROVIDER_NAME = __PROVIDER_NAME__

OUTPUT_PATH = Path('/kaggle/working/prod_detector_outputs.jsonl')
ERROR_PATH = Path('/kaggle/working/prod_detector_errors.jsonl')
PROGRESS_PATH = Path('/kaggle/working/prod_detector_progress.json')

os.environ.setdefault('HF_HUB_ETAG_TIMEOUT', '120')
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '120')
os.environ.setdefault('PYTORCH_NVML_BASED_CUDA_CHECK', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('TRANSFORMERS_NO_TF', '1')
os.environ.setdefault('TRANSFORMERS_NO_FLAX', '1')


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
    if P100_TORCH_WHEEL_PATH:
        configured = Path(P100_TORCH_WHEEL_PATH).expanduser()
        if configured.is_dir():
            return str(configured.resolve())
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


gpu_name = get_nvidia_smi_name()
if INSTALL_P100_TORCH and 'P100' in gpu_name:
    print(f'Detected {gpu_name}; installing PyTorch 2.6.0 CUDA 12.4 for P100.', flush=True)
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


def get_model_input_device(model):
    try:
        return next(model.parameters()).device
    except Exception:
        return torch.device('cuda' if torch.cuda.is_available() else 'cpu')


def memory_efficient_neg_entropy(self, raw_input, num_assistant_tokens, tokens_to_weights):
    import torch.nn.functional as F

    input_ids = raw_input['input_ids']
    seq_len = int(input_ids.size(1))
    entropy_len = max(seq_len - 1, 0)
    if entropy_len <= 0:
        return 0.0

    weights = torch.ones(entropy_len, dtype=torch.float32)
    if tokens_to_weights is None:
        tokens_to_weights = []
    for tokens, weight in tokens_to_weights:
        tokens = [int(token) for token in tokens if int(token) < entropy_len]
        if tokens:
            weights[tokens] = float(weight)

    target_start = max(0, entropy_len - int(num_assistant_tokens))
    total_entropy = torch.tensor(0.0, dtype=torch.float64)
    total_weight = torch.tensor(0.0, dtype=torch.float64)
    device = get_model_input_device(self.model)
    ids = input_ids.to(device)
    past_key_values = None
    chunk_size = 64

    with torch.no_grad():
        for start in range(0, seq_len, chunk_size):
            end = min(seq_len, start + chunk_size)
            chunk = ids[:, start:end]
            output = self.model(input_ids=chunk, past_key_values=past_key_values, use_cache=True)
            past_key_values = output.past_key_values

            valid_len = min(end, entropy_len) - start
            if valid_len > 0:
                logits = output.logits[:, :valid_len, :].float()
                log_probs = F.log_softmax(logits, dim=-1)
                probs = log_probs.exp()
                entropy = -(probs * log_probs).sum(dim=-1)
                entropy = torch.nan_to_num(entropy, nan=0.0, posinf=0.0, neginf=0.0)

                score_start = max(start, target_start)
                score_end = min(start + valid_len, entropy_len)
                if score_end > score_start:
                    local_start = score_start - start
                    local_end = score_end - start
                    chunk_entropy = entropy[:, local_start:local_end].squeeze(0).detach().cpu().double()
                    chunk_weights = weights[score_start:score_end].double()
                    total_entropy += (chunk_entropy * chunk_weights).sum()
                    total_weight += chunk_weights.sum()

            del output
            if 'logits' in locals():
                del logits
            if 'log_probs' in locals():
                del log_probs
            if 'probs' in locals():
                del probs
            if 'entropy' in locals():
                del entropy
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    if total_weight.item() <= 0:
        return 0.0
    return -float(total_entropy.item() / total_weight.item())


def load_jsonl(path):
    with Path(path).open('r', encoding='utf-8-sig') as handle:
        return [json.loads(line) for line in handle if line.strip()]


def locate_samples_file():
    if SAMPLES_INPUT_PATH:
        path = Path(SAMPLES_INPUT_PATH)
        if path.exists():
            return path.resolve()
        matches = glob.glob(f'/kaggle/input/**/{path.name}', recursive=True)
        if matches:
            return Path(matches[0]).resolve()
    matches = glob.glob('/kaggle/input/**/samples_2000.jsonl', recursive=True)
    if not matches:
        matches = glob.glob('/kaggle/input/**/samples*.jsonl', recursive=True)
    if not matches:
        raise RuntimeError('Could not locate a samples JSONL file under /kaggle/input.')
    return Path(matches[0]).resolve()


def locate_atc_runtime():
    if ATC_RUNTIME_PATH:
        path = Path(ATC_RUNTIME_PATH).expanduser()
        if (path / 'detection' / 'detector.py').exists():
            return path.resolve()
    candidates = []
    for candidate in glob.glob('/kaggle/input/**', recursive=True):
        path = Path(candidate)
        if path.is_dir() and (path / 'detection' / 'detector.py').exists():
            candidates.append(path.resolve())
    if not candidates:
        visible_inputs = [str(Path(path).resolve()) for path in glob.glob('/kaggle/input/*')]
        raise RuntimeError(f'Could not locate ATC runtime. visible_inputs={visible_inputs}')
    return sorted(candidates, key=lambda item: (0 if item.name == 'ATC-main' else 1, len(str(item))))[0]


def locate_base_model():
    configured = Path(BASE_MODEL_NAME).expanduser()
    if (configured / 'config.json').exists():
        return str(configured.resolve())
    slug = configured.name or 'codellama-7b-instruct-hf'
    candidates = []
    for config_file in glob.glob('/kaggle/input/**/config.json', recursive=True):
        model_dir = Path(config_file).parent.resolve()
        score = 0
        model_dir_text = str(model_dir).lower()
        if slug.lower() in model_dir_text:
            score += 10
        if 'codellama' in model_dir_text:
            score += 5
        if (model_dir / 'tokenizer.model').exists() or (model_dir / 'tokenizer.json').exists():
            score += 2
        if list(model_dir.glob('pytorch_model*.bin')) or list(model_dir.glob('*.safetensors')):
            score += 2
        candidates.append((-score, len(str(model_dir)), str(model_dir)))
    if not candidates:
        raise RuntimeError(f'Could not locate local base model for {BASE_MODEL_NAME!r}.')
    return sorted(candidates)[0][2]


def patch_detector_module(runtime_path, device_name):
    module_name = 'detection.detector'
    module_path = runtime_path / 'detection' / 'detector.py'
    module_source = module_path.read_text(encoding='utf-8')
    module_source = module_source.replace('"python": \'^\\s*(#.*)$\'', '"python": r\'^\\s*(#.*)$\'')
    module_source = module_source.replace('torch_dtype=torch.float16', 'dtype=torch.float16')
    module_source = module_source.replace(
        'logits = output.logits[:, :-1]  # Shape: (batch_size=1, seq_length, vocab_size)',
        'logits = output.logits[:, :-1].float()  # Shape: (batch_size=1, seq_length, vocab_size)',
    )
    module_source = module_source.replace(
        'probs = F.softmax(logits, dim=-1)  # Shape: (1, seq_length, vocab_size)\n\n'
        '            # Compute entropy for each token\n'
        '            entropy = -(probs * probs.log()).sum(dim=-1)  # Shape: (1, seq_length)',
        'log_probs = F.log_softmax(logits, dim=-1)  # Shape: (1, seq_length, vocab_size)\n'
        '            probs = log_probs.exp()  # Shape: (1, seq_length, vocab_size)\n\n'
        '            # Compute entropy for each token\n'
        '            entropy = -(probs * log_probs).sum(dim=-1)  # Shape: (1, seq_length)\n'
        '            entropy = torch.nan_to_num(entropy, nan=0.0, posinf=0.0, neginf=0.0)',
    )

    model_device_map = 'auto' if device_name == 'cuda' else device_name
    module_source = module_source.replace('device_map="cuda"', f'device_map="{model_device_map}"')
    module_source = module_source.replace("device_map='cuda'", f"device_map='{model_device_map}'")
    module_source = module_source.replace('.to("cuda")', f'.to("{device_name}")')
    module_source = module_source.replace(".to('cuda')", f".to('{device_name}')")
    module_source = module_source.replace(
        f'attention_mask = raw_input.ne(self.tokenizer.eos_token_id).to("{device_name}")',
        f'raw_input = raw_input["input_ids"] if hasattr(raw_input, "data") and "input_ids" in raw_input else raw_input\n'
        f'            attention_mask = raw_input.ne(self.tokenizer.eos_token_id).to("{device_name}")',
    )
    if device_name == 'cpu':
        module_source = module_source.replace('dtype=torch.float16', 'dtype=torch.float32')

    sys.modules.pop(module_name, None)
    module_spec = importlib.util.spec_from_loader(module_name, loader=None)
    patched_module = importlib.util.module_from_spec(module_spec)
    patched_module.__file__ = str(module_path)
    patched_module.__package__ = 'detection'
    sys.modules[module_name] = patched_module
    exec(compile(module_source, str(module_path), 'exec'), patched_module.__dict__)
    if hasattr(patched_module, 'EntropyDetector'):
        patched_module.EntropyDetector._compute_neg_entropy = memory_efficient_neg_entropy
    return patched_module


def should_try_cuda():
    if not torch.cuda.is_available():
        return False, 'CUDA is not available.'
    try:
        arch_list = list(torch.cuda.get_arch_list())
    except Exception:
        arch_list = []
    if 'P100' in gpu_name and 'sm_60' not in arch_list:
        return False, f'Detected {gpu_name}; current PyTorch lacks sm_60.'
    return True, ''


def init_detector(runtime_path):
    preferred = (DEVICE_PREFERENCE or 'auto').strip().lower()
    if preferred not in ('auto', 'cuda', 'cpu'):
        raise RuntimeError(f'Unsupported device preference: {preferred}')
    cuda_ok, cuda_reason = should_try_cuda()
    if preferred == 'cpu':
        candidates = ['cpu']
    elif preferred == 'cuda':
        candidates = ['cuda'] if cuda_ok else []
        if ALLOW_CPU_FALLBACK:
            candidates.append('cpu')
    else:
        candidates = ['cuda'] if cuda_ok else []
        candidates.append('cpu')
    if not candidates:
        raise RuntimeError(cuda_reason or 'No usable device candidate is available.')

    last_error = None
    for device_name in candidates:
        try:
            if str(runtime_path) not in sys.path:
                sys.path.insert(0, str(runtime_path))
            detector_module = patch_detector_module(runtime_path, device_name)
            detectors = {
                'entropy': detector_module.EntropyDetector,
                'mean_log_likelihood': detector_module.MeanLogLikelihoodDetector,
                'log_rank': detector_module.LogRankDetector,
                'lrr': detector_module.LRRDetector,
            }
            infer_task_cfg = SimpleNamespace(
                debug=False,
                debug_file='debug_documentation.txt',
                use_cache=False,
                prompt_style=PROMPT_STYLE,
            )
            detector = detectors[METHOD](
                model_name=BASE_MODEL_NAME,
                pattern_weight_mapping=PATTERN_WEIGHT_MAPPING,
                infer_task_cfg=infer_task_cfg,
                language=LANGUAGE,
            )
            return detector, device_name, cuda_reason
        except Exception as exc:
            last_error = exc
            print(f'Failed to initialize detector on {device_name}: {type(exc).__name__}: {exc}', flush=True)
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            continue
    raise last_error or RuntimeError('Detector initialization failed.')


def code_stats(code):
    lines = [line.strip() for line in code.replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    non_empty = len([line for line in lines if line])
    non_whitespace = len(''.join(code.split()))
    return non_empty, non_whitespace


def confidence(score):
    if not math.isfinite(score) or not math.isfinite(THRESHOLD):
        return None
    return max(0, min(100, round(100 / (1 + math.exp(-((score - THRESHOLD) / 0.05))))))


def make_result(row, state, is_ai, score, message, inferred_task=None):
    result = {
        'sample_id': row.get('sample_id', ''),
        'task_id': row.get('task_id', ''),
        'variant': row.get('variant', ''),
        'label': row.get('label', None),
        'score': score,
        'threshold': THRESHOLD,
        'aiCheck': {
            'state': state,
            'isAI': is_ai,
            'score': score,
            'threshold': THRESHOLD,
            'confidence': confidence(score) if score is not None else None,
            'provider': PROVIDER_NAME,
            'message': message,
            'checkedAt': datetime.now(timezone.utc).isoformat(),
        },
    }
    if inferred_task is not None:
        result['inferredTask'] = inferred_task
    return result


def append_jsonl(path, row):
    with Path(path).open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + '\n')


def main():
    global BASE_MODEL_NAME
    samples_path = locate_samples_file()
    runtime_path = locate_atc_runtime()
    resolved_model_name = locate_base_model()
    BASE_MODEL_NAME = resolved_model_name
    print(f'Loaded samples from {samples_path}', flush=True)
    print(f'Using ATC runtime {runtime_path}', flush=True)
    print(f'Using base model {resolved_model_name}', flush=True)
    print(f'GPU: {gpu_name or "none"}', flush=True)

    rows = load_jsonl(samples_path)
    print(f'Total samples: {len(rows)}', flush=True)

    done = set()
    if OUTPUT_PATH.exists():
        with OUTPUT_PATH.open('r', encoding='utf-8') as handle:
            for line in handle:
                if line.strip():
                    done.add(json.loads(line).get('sample_id', ''))

    detector, used_device, cuda_skip_reason = init_detector(runtime_path)
    print(f'Detector initialized on {used_device}.', flush=True)
    if cuda_skip_reason and used_device == 'cpu':
        print(cuda_skip_reason, flush=True)

    processed = len(done)
    checked = skipped = errored = 0
    for index, row in enumerate(rows, start=1):
        sample_id = row.get('sample_id', '')
        if sample_id in done:
            continue
        code = row.get('code') or ''
        non_empty, non_whitespace = code_stats(code)
        if not code.strip():
            result = make_result(row, 'skipped', None, None, 'Skipped Kaggle ATC check because there is no source code to inspect.')
            skipped += 1
        elif non_empty < MIN_NONEMPTY_LINES or non_whitespace < MIN_NONWHITESPACE_CHARS:
            result = make_result(
                row,
                'skipped',
                None,
                None,
                f'Skipped AI check because the submission is too short ({non_empty} non-empty lines, {non_whitespace} non-whitespace chars; minimum {MIN_NONEMPTY_LINES} lines or {MIN_NONWHITESPACE_CHARS} chars).',
            )
            skipped += 1
        else:
            try:
                score, inferred_task = detector.compute_score_infer_task(code)
                score = float(score)
                if not math.isfinite(score):
                    raise FloatingPointError(f'Detector returned non-finite score: {score}')
                is_ai = bool(score >= THRESHOLD)
                comparison = '>=' if is_ai else '<'
                message = f'Kaggle ATC score {score:.6f} {comparison} threshold {THRESHOLD:.6f} on {used_device}.'
                result = make_result(row, 'checked', is_ai, score, message, inferred_task)
                checked += 1
            except Exception as exc:
                message = f'{type(exc).__name__}: {exc}'
                result = make_result(row, 'error', None, None, message)
                append_jsonl(ERROR_PATH, {
                    'sample_id': sample_id,
                    'task_id': row.get('task_id', ''),
                    'variant': row.get('variant', ''),
                    'error': message,
                    'traceback': traceback.format_exc(),
                })
                errored += 1
            finally:
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

        append_jsonl(OUTPUT_PATH, result)
        processed += 1
        if processed % 5 == 0 or processed == len(rows):
            PROGRESS_PATH.write_text(
                json.dumps({
                    'processed': processed,
                    'total': len(rows),
                    'checked_in_this_run': checked,
                    'skipped_in_this_run': skipped,
                    'errored_in_this_run': errored,
                    'last_sample_id': sample_id,
                    'updated_at': datetime.now(timezone.utc).isoformat(),
                }, ensure_ascii=False, indent=2),
                encoding='utf-8',
            )
            print(f'[{processed}/{len(rows)}] last={sample_id} checked={checked} skipped={skipped} error={errored}', flush=True)

    print(f'Done. Output: {OUTPUT_PATH}', flush=True)


if __name__ == '__main__':
    main()
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare a Kaggle kernel that batch-runs the Hydro production ATC detector.")
    parser.add_argument("--output-dir", required=True, help="Local Kaggle kernel directory to create.")
    parser.add_argument("--kernel-id", required=True, help="Kaggle kernel id, e.g. username/hydro-ai-eval-detector.")
    parser.add_argument("--title", default="Hydro AI Eval Production Detector", help="Kaggle kernel title.")
    parser.add_argument("--samples-input-path", default="/kaggle/input/hydro-ai-eval-samples-2000/samples_2000.jsonl")
    parser.add_argument("--atc-runtime-path", default="/kaggle/input/atcv1-source/ATC-main")
    parser.add_argument("--base-model-name", default="/kaggle/input/codellama-7b-instruct-hf")
    parser.add_argument("--language", default="cpp", choices=["cpp", "python", "java"])
    parser.add_argument("--method", default="entropy", choices=["entropy", "mean_log_likelihood", "log_rank", "lrr"])
    parser.add_argument("--threshold", type=float, default=-0.18)
    parser.add_argument("--prompt-style", default="regular")
    parser.add_argument("--pattern-weights", default="comments:0,docstrings:0")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--allow-cpu-fallback", action="store_true")
    parser.add_argument("--install-p100-torch", action="store_true")
    parser.add_argument("--p100-torch-wheel-path", default="")
    parser.add_argument("--min-nonempty-lines", type=int, default=8)
    parser.add_argument("--min-nonwhitespace-chars", type=int, default=120)
    parser.add_argument("--provider-name", default="kaggle-atc-batch")
    parser.add_argument("--enable-internet", action="store_true")
    parser.add_argument("--dataset-source", action="append", default=[])
    return parser.parse_args()


def parse_pattern_weights(value: str) -> dict[str, float]:
    value = value.strip()
    if not value or value.lower() == "none":
        return {}
    result = {}
    for entry in value.split(","):
        key, raw_weight = entry.split(":", 1)
        result[key.strip()] = float(raw_weight.strip())
    return result


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    replacements = {
        "__SAMPLES_INPUT_PATH__": json.dumps(args.samples_input_path),
        "__ATC_RUNTIME_PATH__": json.dumps(args.atc_runtime_path),
        "__BASE_MODEL_NAME__": json.dumps(args.base_model_name),
        "__LANGUAGE__": json.dumps(args.language),
        "__METHOD__": json.dumps(args.method),
        "__THRESHOLD__": repr(float(args.threshold)),
        "__PROMPT_STYLE__": json.dumps(args.prompt_style),
        "__PATTERN_WEIGHT_MAPPING__": json.dumps(parse_pattern_weights(args.pattern_weights)),
        "__DEVICE_PREFERENCE__": json.dumps(args.device),
        "__ALLOW_CPU_FALLBACK__": repr(bool(args.allow_cpu_fallback)),
        "__INSTALL_P100_TORCH__": repr(bool(args.install_p100_torch)),
        "__P100_TORCH_WHEEL_PATH__": json.dumps(args.p100_torch_wheel_path),
        "__MIN_NONEMPTY_LINES__": repr(int(args.min_nonempty_lines)),
        "__MIN_NONWHITESPACE_CHARS__": repr(int(args.min_nonwhitespace_chars)),
        "__PROVIDER_NAME__": json.dumps(args.provider_name),
    }
    script = DETECTOR_TEMPLATE
    for key, value in replacements.items():
        script = script.replace(key, value)
    (output_dir / "run_prod_detector.py").write_text(script.lstrip(), encoding="utf-8")

    metadata = {
        "id": args.kernel_id,
        "title": args.title,
        "code_file": "run_prod_detector.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_tpu": False,
        "enable_internet": bool(args.enable_internet),
        "keywords": [],
        "dataset_sources": args.dataset_source,
        "kernel_sources": [],
        "competition_sources": [],
        "model_sources": [],
    }
    (output_dir / "kernel-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote Kaggle detector kernel to {output_dir.resolve()}")


if __name__ == "__main__":
    main()
