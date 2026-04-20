import argparse
import gc
import json
import shutil
from pathlib import Path

import torch
from safetensors.torch import save_file


COPY_FILES = {
    "config.json",
    "generation_config.json",
    "LICENSE",
    "README.md",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "USE_POLICY.md",
}


def copy_metadata(input_dir: Path, output_dir: Path, dataset_ref: str):
    output_dir.mkdir(parents=True, exist_ok=True)
    for filename in COPY_FILES:
        src = input_dir / filename
        if src.exists():
            shutil.copy2(src, output_dir / filename)

    metadata = {
        "id": dataset_ref,
        "title": "CodeLlama 7B Instruct HF Safetensors",
        "licenses": [{"name": "other"}],
    }
    (output_dir / "dataset-metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def convert(input_dir: Path, output_dir: Path, dataset_ref: str):
    index_path = input_dir / "pytorch_model.bin.index.json"
    if not index_path.exists():
        raise FileNotFoundError(f"Missing sharded PyTorch index: {index_path}")

    copy_metadata(input_dir, output_dir, dataset_ref)

    index_data = json.loads(index_path.read_text(encoding="utf-8"))
    original_weight_map = index_data["weight_map"]
    shard_names = sorted(set(original_weight_map.values()))
    shard_name_map = {
        shard_name: shard_name.replace("pytorch_model", "model").replace(".bin", ".safetensors")
        for shard_name in shard_names
    }

    converted_weight_map = {}
    for shard_number, shard_name in enumerate(shard_names, start=1):
        src = input_dir / shard_name
        dst_name = shard_name_map[shard_name]
        dst = output_dir / dst_name
        if not src.exists():
            raise FileNotFoundError(f"Missing model shard: {src}")

        print(f"[{shard_number}/{len(shard_names)}] {src.name} -> {dst.name}", flush=True)
        shard = torch.load(src, map_location="cpu", weights_only=True)
        if "state_dict" in shard and isinstance(shard["state_dict"], dict):
            shard = shard["state_dict"]
        save_file(shard, dst, metadata={"format": "pt"})

        for weight_name, mapped_shard in original_weight_map.items():
            if mapped_shard == shard_name:
                converted_weight_map[weight_name] = dst_name

        del shard
        gc.collect()

    safetensors_index = {
        "metadata": {
            "total_size": sum((output_dir / name).stat().st_size for name in shard_name_map.values()),
        },
        "weight_map": converted_weight_map,
    }
    (output_dir / "model.safetensors.index.json").write_text(
        json.dumps(safetensors_index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"Done: {output_dir}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--dataset-ref", required=True)
    args = parser.parse_args()
    convert(Path(args.input_dir).resolve(), Path(args.output_dir).resolve(), args.dataset_ref)


if __name__ == "__main__":
    main()
