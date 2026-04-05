#!/usr/bin/env python3
"""
Distill knowledge from a cross-encoder into a bi-encoder via MSE loss.

This script:
1. Loads the fine-tuned bi-encoder (bge-m3-wine-ft-v1)
2. Loads a synthetic wine corpus (10K documents)
3. For each document:
   - Generates embedding with fine-tuned bi-encoder
   - Scores with cross-encoder (simulated: uses semantic similarity score)
   - Stores (query_representative, doc_embedding, ce_score)
4. Fine-tunes bi-encoder again with MSE loss:
   loss = (cos_sim(q, d) - ce_score)^2

Outputs: models/bge-m3-wine-distilled-v1/

Run: python scripts/ltr/distill_cross_encoder.py
"""

import json
import argparse
import logging
import random
from pathlib import Path
from typing import List, Optional, Tuple
import numpy as np

import torch
from torch import nn
from torch.utils.data import Dataset, DataLoader
from sentence_transformers import SentenceTransformer, models
from torch.optim import AdamW
from tqdm import tqdm

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_FINETUNED_MODEL = Path('models/bge-m3-wine-ft-v1')
DEFAULT_OUTPUT = Path('models/bge-m3-wine-distilled-v1')

BATCH_SIZE = 32
NUM_EPOCHS = 2
LEARNING_RATE = 1e-5
NUM_CORPUS_DOCS = 100  # Mock corpus for demo (in production, would be 10K)

# ─────────────────────────────────────────────────────────────────────────────
# Synthetic wine corpus
# ─────────────────────────────────────────────────────────────────────────────

def generate_synthetic_corpus(size: int = 100) -> List[dict]:
    """Generate synthetic wine documents for distillation corpus."""
    regions = [
        'Bordeaux', 'Burgundy', 'Loire Valley', 'Alsace', 'Champagne',
        'Barossa Valley', 'Central Coast', 'Napa Valley', 'Sonoma',
        'Rioja', 'Penedes', 'Tuscany', 'Piedmont',
    ]
    producers = [
        'Château', 'Domaine', 'Bodega', 'Enoteca', 'Winery',
        'Estate', 'Vineyard', 'Producer', 'Maison',
    ]
    grape_types = [
        'Cabernet Sauvignon', 'Merlot', 'Pinot Noir', 'Syrah', 'Chardonnay',
        'Sauvignon Blanc', 'Riesling', 'Nebbiolo', 'Tempranillo', 'Grenache',
    ]
    styles = [
        'bold red', 'light red', 'crisp white', 'rich white', 'dry rosé',
        'sweet white', 'sparkling', 'fortified',
    ]

    corpus = []
    for i in range(size):
        doc = {
            'entity_id': f'wine-{i:04d}',
            'canonical_label': f"{random.choice(producers)} {random.choice(regions)} {random.randint(2010, 2024)}",
            'search_text_en': f"{random.choice(grape_types)} {random.choice(styles)} wine from {random.choice(regions)}",
            'region': random.choice(regions),
            'producer': random.choice(producers),
            'grape_primary': random.choice(grape_types),
            'style': random.choice(styles),
            'body': random.uniform(0.3, 1.0),
            'sweetness': random.uniform(0.0, 1.0),
            'acidity': random.uniform(0.4, 1.0),
            'tannin': random.uniform(0.0, 1.0),
        }
        corpus.append(doc)

    return corpus

def score_with_cross_encoder_mock(query: str, doc: dict) -> float:
    """
    Mock cross-encoder score (0-1).

    In production, would call a real cross-encoder model.
    Here, we simulate based on semantic similarity of text fields.
    """
    query_tokens = set(query.lower().split())
    doc_tokens = set(doc.get('search_text_en', '').lower().split())

    if not query_tokens or not doc_tokens:
        return 0.5

    intersection = query_tokens & doc_tokens
    union = query_tokens | doc_tokens

    jaccard = len(intersection) / len(union) if union else 0.0
    # Add some randomness for realism
    noise = random.uniform(-0.1, 0.1)
    score = max(0.0, min(1.0, jaccard + noise))
    return score

# ─────────────────────────────────────────────────────────────────────────────
# Distillation Dataset
# ─────────────────────────────────────────────────────────────────────────────

class DistillationDataset(Dataset):
    """Dataset for MSE distillation from cross-encoder."""

    def __init__(
        self,
        model: SentenceTransformer,
        corpus: List[dict],
        queries: List[str],
        batch_encode: int = 32,
    ):
        """
        Args:
            model: Fine-tuned bi-encoder for generating embeddings
            corpus: Wine documents
            queries: List of representative queries
            batch_encode: Batch size for encoding (to avoid OOM)
        """
        self.model = model
        self.corpus = corpus
        self.queries = queries

        logger.info("🔄 Pre-computing embeddings and cross-encoder scores...")
        self.pairs = []

        # Generate embeddings for corpus in batches
        corpus_texts = [d.get('search_text_en', '') for d in corpus]
        corpus_embeddings = model.encode(
            corpus_texts,
            batch_size=batch_encode,
            convert_to_tensor=True,
            show_progress_bar=True,
        )

        # For each query, create pairs with docs
        for query in queries:
            query_embedding = model.encode(query, convert_to_tensor=True)

            for doc_idx, doc in enumerate(corpus):
                # Score with mock cross-encoder
                ce_score = score_with_cross_encoder_mock(query, doc)

                # Store: (query_embedding, doc_embedding, ce_score)
                self.pairs.append({
                    'query_embedding': query_embedding,
                    'doc_embedding': corpus_embeddings[doc_idx],
                    'ce_score': torch.tensor(ce_score, dtype=torch.float32),
                })

        logger.info(f"✅ Created {len(self.pairs)} query-document pairs for distillation")

    def __len__(self) -> int:
        return len(self.pairs)

    def __getitem__(self, idx: int) -> dict:
        return self.pairs[idx]

# ─────────────────────────────────────────────────────────────────────────────
# MSE Loss for Distillation
# ─────────────────────────────────────────────────────────────────────────────

class DistillationLoss(nn.Module):
    """MSE loss between cosine similarity and cross-encoder score."""

    def forward(
        self,
        query_embeddings: torch.Tensor,
        doc_embeddings: torch.Tensor,
        ce_scores: torch.Tensor,
    ) -> torch.Tensor:
        """
        Compute MSE loss.

        Args:
            query_embeddings: (batch_size, embedding_dim)
            doc_embeddings: (batch_size, embedding_dim)
            ce_scores: (batch_size,) cross-encoder scores in [0, 1]

        Returns:
            scalar MSE loss
        """
        # Normalize embeddings
        query_norms = torch.nn.functional.normalize(query_embeddings, p=2, dim=1)
        doc_norms = torch.nn.functional.normalize(doc_embeddings, p=2, dim=1)

        # Compute cosine similarity
        cosine_sims = torch.sum(query_norms * doc_norms, dim=1)

        # MSE loss: (cos_sim - ce_score)^2
        loss = torch.mean((cosine_sims - ce_scores) ** 2)
        return loss

# ─────────────────────────────────────────────────────────────────────────────
# Training loop
# ─────────────────────────────────────────────────────────────────────────────

def should_use_cuda() -> bool:
    """Check if CUDA/GPU is available."""
    if torch.cuda.is_available():
        logger.info(f"✅ CUDA available. Using device: {torch.cuda.get_device_name(0)}")
        return True
    logger.info("⚠️  CUDA not available. Using CPU (slower training).")
    return False

def main(
    finetuned_model_path: Optional[Path] = None,
    output_dir: Optional[Path] = None,
    batch_size: int = BATCH_SIZE,
    epochs: int = NUM_EPOCHS,
    learning_rate: float = LEARNING_RATE,
    corpus_size: int = NUM_CORPUS_DOCS,
) -> None:
    """
    Distill cross-encoder knowledge into bi-encoder.

    Args:
        finetuned_model_path: Path to fine-tuned bi-encoder
        output_dir: Directory to save distilled model
        batch_size: Training batch size
        epochs: Number of training epochs
        learning_rate: Learning rate
        corpus_size: Size of synthetic corpus
    """
    finetuned_model_path = finetuned_model_path or DEFAULT_FINETUNED_MODEL
    output_dir = output_dir or DEFAULT_OUTPUT

    # Validate inputs
    if not finetuned_model_path.exists():
        logger.error(f"❌ Fine-tuned model not found: {finetuned_model_path}")
        logger.info("Run: python scripts/ltr/finetune_embedding.py")
        raise FileNotFoundError(str(finetuned_model_path))

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"📁 Output directory: {output_dir}")

    # Load fine-tuned model
    logger.info(f"🔧 Loading fine-tuned model from {finetuned_model_path}...")
    device = 'cuda' if should_use_cuda() else 'cpu'
    model = SentenceTransformer(str(finetuned_model_path), device=device)
    logger.info(f"✅ Model loaded")

    # Generate synthetic corpus
    logger.info(f"📖 Generating synthetic corpus ({corpus_size} documents)...")
    corpus = generate_synthetic_corpus(corpus_size)
    logger.info(f"✅ Generated {len(corpus)} wine documents")

    # Generate representative queries
    representative_queries = [
        "bold red wine from Bordeaux",
        "light crisp white wine",
        "full-bodied Cabernet Sauvignon",
        "dry Riesling from Alsace",
        "elegant Pinot Noir",
        "fruity Sauvignon Blanc",
    ]
    logger.info(f"📝 Using {len(representative_queries)} representative queries")

    # Create distillation dataset
    dataset = DistillationDataset(
        model=model,
        corpus=corpus,
        queries=representative_queries,
        batch_encode=32,
    )

    # Create dataloader
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)
    logger.info(f"📊 DataLoader: batch_size={batch_size}, num_batches={len(dataloader)}")

    # Setup optimizer and loss
    optimizer = AdamW(model.parameters(), lr=learning_rate)
    loss_fn = DistillationLoss()
    logger.info(f"⚙️  Optimizer: AdamW(lr={learning_rate})")

    # Training loop
    logger.info(f"🚀 Starting distillation training: {epochs} epochs...")
    model.train()

    for epoch in range(epochs):
        total_loss = 0.0
        num_batches = 0

        pbar = tqdm(dataloader, desc=f"Epoch {epoch + 1}/{epochs}")
        for batch in pbar:
            query_emb = batch['query_embedding'].to(device)
            doc_emb = batch['doc_embedding'].to(device)
            ce_scores = batch['ce_score'].to(device)

            optimizer.zero_grad()

            # Forward pass
            loss = loss_fn(query_emb, doc_emb, ce_scores)

            # Backward pass
            loss.backward()
            optimizer.step()

            total_loss += loss.item()
            num_batches += 1
            pbar.set_postfix({'loss': f'{loss.item():.4f}'})

        avg_loss = total_loss / num_batches if num_batches > 0 else 0.0
        logger.info(f"✅ Epoch {epoch + 1}/{epochs} - Avg Loss: {avg_loss:.4f}")

    model.eval()

    # Save distilled model
    logger.info(f"💾 Saving distilled model to {output_dir}...")
    model.save(str(output_dir))
    logger.info(f"✅ Model saved: {output_dir}")

    # Verify saved model
    logger.info("✔️  Verifying saved model...")
    test_model = SentenceTransformer(str(output_dir))
    test_embedding = test_model.encode("test wine query", convert_to_tensor=False)
    logger.info(f"✅ Model load verification passed. Embedding dim: {len(test_embedding)}")

    logger.info("🎉 Distillation complete!")

# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Distill cross-encoder knowledge into bi-encoder'
    )
    parser.add_argument(
        '--finetuned-model',
        type=Path,
        default=DEFAULT_FINETUNED_MODEL,
        help=f'Path to fine-tuned model (default: {DEFAULT_FINETUNED_MODEL})',
    )
    parser.add_argument(
        '--output',
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f'Directory to save distilled model (default: {DEFAULT_OUTPUT})',
    )
    parser.add_argument(
        '--batch-size',
        type=int,
        default=BATCH_SIZE,
        help=f'Training batch size (default: {BATCH_SIZE})',
    )
    parser.add_argument(
        '--epochs',
        type=int,
        default=NUM_EPOCHS,
        help=f'Number of training epochs (default: {NUM_EPOCHS})',
    )
    parser.add_argument(
        '--learning-rate',
        type=float,
        default=LEARNING_RATE,
        help=f'Learning rate (default: {LEARNING_RATE})',
    )
    parser.add_argument(
        '--corpus-size',
        type=int,
        default=NUM_CORPUS_DOCS,
        help=f'Size of synthetic corpus (default: {NUM_CORPUS_DOCS})',
    )

    args = parser.parse_args()

    try:
        main(
            finetuned_model_path=args.finetuned_model,
            output_dir=args.output,
            batch_size=args.batch_size,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            corpus_size=args.corpus_size,
        )
    except Exception as e:
        logger.error(f"❌ Error: {e}", exc_info=True)
        exit(1)
