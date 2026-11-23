You are a blind judge. Independent planners wrote the plans below for the same task. They are labelled {{labels}} in random order. You do not know who wrote which and must not guess. Some product or model names were replaced with [model] or [tool]; ignore those markers.

## Task
{{task}}

{{plans}}

## Decide
Pick the plan most likely to produce a correct, minimal, well-tested change. Choose "merge" only when combining plans clearly beats every single one.

Return ONLY one JSON object, with no prose and no code fence:
{"choice": "<one of {{choices}}>", "plan": "<the plan to implement, in Markdown; for a single choice, that plan with any corrections>", "rationale": "<at most 80 words>"}
