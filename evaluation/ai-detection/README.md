# Hydro AI Detector Evaluation

This folder contains the cleaned evaluation dataset and production-detector
results for the Hydro AI-code detector.

## Dataset

- Human samples: 1000 real competitive-programming C++ submissions.
- AI samples: 1000 C++ submissions generated for the same tasks by
  `Qwen/Qwen2.5-Coder-0.5B-Instruct` on Kaggle.
- Labels: `human = 0`, `ai = 1`.

Files:

```text
data/
  human_1000.csv
  human_1000.json
  human_1000.jsonl
  pairs_1000.csv
  pairs_1000.json
  pairs_1000.jsonl
  samples_2000.csv
  samples_2000.json
  samples_2000.jsonl
requests/
  qwen_batch_output_1000.jsonl
```

`pairs_1000.*` keeps one row per task:

```text
task_id | human code | AI code
```

`samples_2000.*` keeps one row per detector input:

```text
sample_id    | variant | label | code
<id>_human   | human   | 0     | human source
<id>_ai      | ai      | 1     | AI source
```

## Production Evaluation

Detector setup used for the recorded run:

- Provider: Kaggle ATC batch detector
- Base model: CodeLlama 7B Instruct HF
- Method: `entropy`
- Language: `cpp`
- Threshold: `-0.18`
- Pattern weights: `comments:0,docstrings:0`

Result files:

```text
results/
  prod_detector_outputs.jsonl
  prod_detector_errors.jsonl
  prod_detector_progress.json
  prod_eval/
    metrics.json
    samples_with_predictions.csv
    all_roc_curve.csv
    all_pr_curve.csv
```

Current metrics are computed from the 1946 samples with valid detector scores.
The full input had 2000 rows: 1946 checked, 20 skipped as too short, and 34
failed during Kaggle scoring with CUDA out-of-memory errors.

```text
accuracy: 0.8299
f1:       0.8105
fpr:      0.0532
auc:      0.9349
```

Confusion matrix on checked samples:

```text
tp: 708
tn: 907
fp: 51
fn: 280
```

AUC is computed from detector scores. The random baseline stored in
`metrics.json` is `0.5`.

## Re-run Metrics

From `Hydro-master`:

```powershell
python evaluation\ai-detection\scripts\evaluate_prod_detector.py `
  --samples evaluation\ai-detection\data\samples_2000.csv `
  --predictions evaluation\ai-detection\results\prod_detector_outputs.jsonl `
  --output-dir evaluation\ai-detection\results\prod_eval `
  --experiment-name hydro_atc_prod_qwen1000
```

Useful scripts are kept in `scripts/`:

- `prepare_eval_dataset.py`: rebuild human/pair/sample files.
- `prepare_kaggle_generator.py`: prepare Kaggle AI-generation kernel.
- `prepare_kaggle_detector.py`: prepare Kaggle production-detector kernel.
- `evaluate_prod_detector.py`: compute accuracy, F1, FPR, AUC.
