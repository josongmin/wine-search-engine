"""
Cross-Encoder Reranker microservice.

Model: BAAI/bge-reranker-v2-m3 (multilingual, 568M params).
Endpoint: POST /rerank { query, texts[] } → { results: [{ index, score }] }

Start:
  uvicorn main:app --host 0.0.0.0 --port 8081

Environment:
  MODEL_NAME  — HuggingFace model ID (default: BAAI/bge-reranker-v2-m3)
  DEVICE      — "cuda" or "cpu" (default: auto-detect)
  MAX_LENGTH  — Max token length (default: 512)
"""

import os
import logging
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MODEL_NAME = os.getenv("MODEL_NAME", "BAAI/bge-reranker-v2-m3")
DEVICE = os.getenv("DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
MAX_LENGTH = int(os.getenv("MAX_LENGTH", "512"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("reranker")

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

logger.info(f"Loading model {MODEL_NAME} on {DEVICE} …")
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME)
model.to(DEVICE)
model.eval()
logger.info("Model loaded.")

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

app = FastAPI(title="Wine Reranker", version="1.0.0")


class RerankRequest(BaseModel):
    query: str
    texts: list[str]
    limit: Optional[int] = Field(default=None, description="Max results to return")


class RerankResultItem(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    results: list[RerankResultItem]


@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest) -> RerankResponse:
    """Score (query, text) pairs with the cross-encoder and return sorted results."""
    if len(request.texts) == 0:
        return RerankResponse(results=[])

    try:
        # Build pairs
        pairs = [[request.query, text] for text in request.texts]

        # Tokenize
        inputs = tokenizer(
            pairs,
            padding=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="pt",
        ).to(DEVICE)

        # Score
        with torch.no_grad():
            scores = model(**inputs, return_dict=True).logits.squeeze(-1)

        # If single result, scores is 0-dim
        if scores.dim() == 0:
            scores = scores.unsqueeze(0)

        score_list = scores.cpu().tolist()

        # Build results sorted by score descending
        results = [
            RerankResultItem(index=i, score=s)
            for i, s in enumerate(score_list)
        ]
        results.sort(key=lambda r: r.score, reverse=True)

        # Apply limit
        if request.limit is not None and request.limit > 0:
            results = results[: request.limit]

        return RerankResponse(results=results)

    except Exception as e:
        logger.error(f"Rerank error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    """Health check."""
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE}
