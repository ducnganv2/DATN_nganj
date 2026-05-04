# Run On Kaggle

Use this option if `kaggle kernels push` fails locally.

1. Open Kaggle and create a new notebook.
2. Keep the notebook private.
3. Turn Internet on in the notebook settings.
4. Upload or copy the content from `hydro_ai_eval_gemini25flash_manualkey.ipynb`.
5. Run all cells.
6. Download this output file when the run finishes:

```text
/kaggle/working/gemini_batch_output_1000.jsonl
```

Send that file back to this workspace under:

```text
evaluation/ai-detection-gpt-gemini/requests/gemini_batch_output_1000.jsonl
```

Then run the merge step locally:

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
