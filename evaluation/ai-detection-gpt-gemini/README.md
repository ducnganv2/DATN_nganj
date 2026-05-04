# Hydro AI Detector Evaluation - GPT/Gemini Extension

This folder is prepared for a second evaluation set.

Current status:

- Human samples: 1000
- Human source: DeepMind CodeContests, Codeforces problems only
- Contest range: Codeforces contest id 1 to 455
- Overlap with the existing Qwen evaluation set: 0 tasks
- Target language: C++
- AI samples: not generated yet

The human set intentionally prioritizes older Codeforces contests to reduce the
risk that the human submissions were AI-assisted.

Prepared files:

```text
source/codecontests_human_1000_oldest_new.jsonl
data/human_1000.jsonl
data/human_1000.json
data/human_1000.csv
requests/openai_batch_requests_1000_oldest_gpt4o_mini.jsonl
manifest.json
```

Next step:

Generate one AI C++ solution per problem using GPT or Gemini, then merge the AI
outputs into `pairs_1000.*` and `samples_2000.*`.
