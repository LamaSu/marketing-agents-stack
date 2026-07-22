# HHEM sidecar (grounded-NLI backstop for `@mstack/reviewer`)

Deployment note, not application code — see
`packages/reviewer/src/nli-backstop.ts` for the TS client (`NliBackstop`,
`createHhemBackstop`) and `research/10-sota-integration-design.md` §2.2
(Wave B2) for the design context.

Vectara's **HHEM-2.1-Open** (Apache-2.0 model weights,
`vectara/hallucination_evaluation_model` on Hugging Face) is a small, fast
classifier that scores whether a `passage` entails a `claim` — the grounded,
model-independent second opinion the reviewer's judge step calls for every
claim it marks unsupported/drifted. Per `docs/build-conventions.md`'s sidecar
rule, model inference stays out of the strict-ESM TS tree; it runs as its own
container, reached over plain HTTP.

**Unlike Crawl4AI (`docker/crawl4ai.md`), there is no ready-made "HHEM server"
image.** Vectara ships the model weights plus a `transformers`-based usage
snippet, not a Docker server. The minimal wrapper below is OUR OWN glue code
(not a Vectara product) — verify it against the model card on first real use,
same discipline `crawl4ai.ts` used for its own unverified assumptions.

## A minimal serving wrapper

`server.py`:

```python
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModelForSequenceClassification

app = FastAPI()
model = AutoModelForSequenceClassification.from_pretrained(
    "vectara/hallucination_evaluation_model", trust_remote_code=True
)

class PredictRequest(BaseModel):
    claim: str
    passage: str

@app.post("/predict")
def predict(req: PredictRequest):
    # HHEM's predict() takes (premise, hypothesis) pairs -- the passage is the
    # premise (the evidence), the claim is the hypothesis (what's being checked).
    score = float(model.predict([(req.passage, req.claim)])[0])
    return {"score": score}
```

`Dockerfile`:

```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn "transformers>=4.40" \
    torch --index-url https://download.pytorch.org/whl/cpu
COPY server.py .
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
docker build -t hhem-sidecar .
docker run -d --name hhem -p 8000:8000 hhem-sidecar
```

The first request downloads the model weights from Hugging Face into the
container — expect a slow first call, fast ones after (or bake the weights
into the image with a `RUN python -c "..."` warm-up layer).

## Point the TS code at it

Default (zero config): `hhemBackstop` targets `http://localhost:8000`.

Override via env var:

```bash
export HHEM_URL=http://hhem.internal:8000
```

or per-call config:

```ts
import { createHhemBackstop, reviewAsset } from "@mstack/reviewer";

const nliBackstop = createHhemBackstop({ baseUrl: "http://hhem.internal:8000", threshold: 0.5 });
const result = await reviewAsset(req, { corpus, nliBackstop });
```

## The HTTP contract this client assumes (verify against your server)

```
POST {baseUrl}/predict
  request:  { "claim": "<claim text>", "passage": "<passage text>" }
  response: { "score": <number 0-1> }
```

`score >= threshold` (default `0.5`, configurable via
`createHhemBackstop({ threshold })`) counts as `supported: true` — the
backstop DISAGREES with a judge finding that treated the claim as a
violation, and `review-agent.ts` re-attributes that finding
`detectedBy: "nli"` + flags `needsReview: true`. If you serve HHEM
differently (e.g. behind Vectara's hosted API instead of self-hosting the
open weights, or a batched `/predict` endpoint), adjust the wrapper's
response shape and `HhemPredictResponse`/`createHhemBackstop` in
`nli-backstop.ts` together — callers (`review-agent.ts`) never need to change.

## Offline default — nothing requires this sidecar

`reviewAsset` defaults to `noopNliBackstop`, which always agrees with the
judge (`supported: false`) — the pipeline's deterministic-pre-scan +
Claude-judge path is completely unaffected whether or not this sidecar
exists, and `mstack demo` never calls it. Even where `hhemBackstop` *is*
wired in, any sidecar failure (down, timeout, non-OK, malformed response)
falls back to the SAME no-op verdict — degraded, never broken, never a
spurious `needsReview` flag from a flaky sidecar.
