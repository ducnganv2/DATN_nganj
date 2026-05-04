# Hydro AI Eval Gemini Generator - Manual Key

This Kaggle script generates AI C++ solutions for the 1000 oldest CodeContests
human tasks using `gemini-2.5-flash`.

Before running on Kaggle, open `generate_ai_dataset_gemini.py` and replace this
placeholder:

```python
API_KEY = 'PASTE_GEMINI_API_KEY_HERE'
```

with your real Gemini API key.

Output file after the kernel finishes:

```text
/kaggle/working/gemini_batch_output_1000.jsonl
```

Download that output and place it under:

```text
evaluation/ai-detection-gpt-gemini/requests/
```

Then merge it locally:

```powershell
python evaluation\ai-detection\scripts\prepare_eval_dataset.py `
  --human-source evaluation\ai-detection-gpt-gemini\data\human_1000.jsonl `
  --output-dir evaluation\ai-detection-gpt-gemini `
  --limit 1000 `
  --language cpp `
  --ai-model gemini-2.5-flash `
  --batch-output evaluation\ai-detection-gpt-gemini\requests\gemini_batch_output_1000.jsonl `
  --request-output-name openai_batch_requests_1000_oldest_gemini_2_5_flash.jsonl
```

Do not make the Kaggle notebook public while the real key is in the script.
