#!/usr/bin/env python3
"""
Fine-tune BGE-M3 embedding model on wine domain triplets.

Inputs: data/triplets-train.jsonl (~2000 triplets)
Outputs: models/bge-m3-wine-ft-v1/ (fine-tuned model)

Uses: SentenceTransformer with MultipleNegativesRankingLoss
      (efficient: 128-dim embeddings, in-batch negatives, 3 epochs)

Run: python scripts/ltr/finetune_embedding.py
"""

import json
import argparse
import logging
from pathlib import Path
from typing import List, Optional

import torch
from sentence_transformers import SentenceTransformer, InputExample, losses
from torch.utils.data import DataLoader

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_INPUT = Path('data/triplets-train.jsonl')
DEFAULT_OUTPUT = Path('models/bge-m3-wine-ft-v1')
DEFAULT_MODEL = 'BAAI/bge-m3'

# Hyperparameters for fine-tuning
BATCH_SIZE = 16
NUM_EPOCHS = 3
WARMUP_STEPS = 100
SAVE_STEPS = 500
LEARNING_RATE = 1e-5

# ─────────────────────────────────────────────────────────────────────────────
# Utilities
# ─────────────────────────────────────────────────────────────────────────────

def load_triplets(file_path: Path) -> List[dict]:
    """Load triplets from NDJSON file."""
    triplets = []
    with open(file_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                try:
                    triplet = json.loads(line)
                    triplets.append(triplet)
                except json.JSONDecodeError:
                    logger.warning(f"Skipped malformed JSON line: {line[:50]}")
    return triplets

def triplets_to_examples(triplets: List[dict]) -> List[InputExample]:
    """
    Convert triplet dicts to SentenceTransformer InputExample objects.

    InputExample format for MultipleNegativesRankingLoss:
    - texts: [query, positive, hard_negative, ...]
    - labels: [1, 0, 0, ...] (1 for positive, 0 for negatives)

    However, MultipleNegativesRankingLoss expects:
    - texts[0]: anchor (query)
    - texts[1]: positive
    - texts[2:]: hard negatives (optional)
    """
    examples = []
    for triplet in triplets:
        # Simple format: just query, positive, hard_negative
        example = InputExample(texts=[
            triplet['query'],      # anchor
            triplet['positive'],   # positive
            triplet['hard_negative']  # hard negative
        ])
        examples.append(example)
    return examples

def should_use_cuda() -> bool:
    """Check if CUDA/GPU is available."""
    if torch.cuda.is_available():
        logger.info(f"✅ CUDA available. Using device: {torch.cuda.get_device_name(0)}")
        return True
    logger.info("⚠️  CUDA not available. Using CPU (slower training).")
    return False

# ─────────────────────────────────────────────────────────────────────────────
# Main fine-tuning
# ─────────────────────────────────────────────────────────────────────────────

def main(
    input_file: Optional[Path] = None,
    output_dir: Optional[Path] = None,
    model_name: str = DEFAULT_MODEL,
    batch_size: int = BATCH_SIZE,
    epochs: int = NUM_EPOCHS,
    learning_rate: float = LEARNING_RATE,
) -> None:
    """
    Fine-tune BGE-M3 on wine domain triplets.

    Args:
        input_file: Path to triplets NDJSON file
        output_dir: Directory to save fine-tuned model
        model_name: Model identifier (e.g., 'BAAI/bge-m3')
        batch_size: Training batch size
        epochs: Number of training epochs
        learning_rate: Learning rate for optimizer
    """
    input_file = input_file or DEFAULT_INPUT
    output_dir = output_dir or DEFAULT_OUTPUT

    # Validate inputs
    if not input_file.exists():
        logger.error(f"❌ Input file not found: {input_file}")
        raise FileNotFoundError(str(input_file))

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"📁 Output directory: {output_dir}")

    # Load triplets
    logger.info(f"📖 Loading triplets from {input_file}...")
    triplets = load_triplets(input_file)
    logger.info(f"✅ Loaded {len(triplets)} triplets")

    if len(triplets) == 0:
        logger.error("❌ No triplets loaded. Aborting.")
        raise ValueError("Empty triplet dataset")

    # Convert to InputExample objects
    logger.info("🔄 Converting triplets to training examples...")
    examples = triplets_to_examples(triplets)
    logger.info(f"✅ Created {len(examples)} training examples")

    # Create DataLoader
    dataloader = DataLoader(
        examples,
        shuffle=True,
        batch_size=batch_size,
    )
    logger.info(f"📊 DataLoader: batch_size={batch_size}, num_batches={len(dataloader)}")

    # Load pre-trained model
    logger.info(f"🔧 Loading model: {model_name}...")
    device = 'cuda' if should_use_cuda() else 'cpu'
    model = SentenceTransformer(model_name, device=device)
    logger.info(f"✅ Model loaded with {sum(p.numel() for p in model.parameters())} parameters")

    # Create loss function
    # MultipleNegativesRankingLoss: treats all negatives in batch as negatives
    # Expects: anchor at texts[0], positive at texts[1], hard negatives at texts[2:]
    train_loss = losses.MultipleNegativesRankingLoss(model)
    logger.info("📌 Using MultipleNegativesRankingLoss with in-batch negatives")

    # Fine-tune
    logger.info(
        f"🚀 Starting fine-tuning: {epochs} epochs, "
        f"{learning_rate} learning rate, {WARMUP_STEPS} warmup steps..."
    )

    model.fit(
        train_objectives=[(dataloader, train_loss)],
        epochs=epochs,
        warmup_steps=WARMUP_STEPS,
        checkpoint_save_steps=SAVE_STEPS,
        checkpoint_save_total_limit=2,
        weight_decay=0.01,
        optimizer_params={'lr': learning_rate},
        show_progress_bar=True,
    )

    # Save model
    logger.info(f"💾 Saving fine-tuned model to {output_dir}...")
    model.save(str(output_dir))
    logger.info(f"✅ Model saved: {output_dir}")

    # Verify saved model
    logger.info("✔️  Verifying saved model...")
    test_model = SentenceTransformer(str(output_dir))
    test_embedding = test_model.encode("test wine query", convert_to_tensor=False)
    logger.info(f"✅ Model load verification passed. Embedding dim: {len(test_embedding)}")

    logger.info("🎉 Fine-tuning complete!")

# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Fine-tune BGE-M3 on wine domain triplets'
    )
    parser.add_argument(
        '--input',
        type=Path,
        default=DEFAULT_INPUT,
        help=f'Path to triplets NDJSON file (default: {DEFAULT_INPUT})',
    )
    parser.add_argument(
        '--output',
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f'Directory to save fine-tuned model (default: {DEFAULT_OUTPUT})',
    )
    parser.add_argument(
        '--model',
        type=str,
        default=DEFAULT_MODEL,
        help=f'Model identifier (default: {DEFAULT_MODEL})',
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

    args = parser.parse_args()

    try:
        main(
            input_file=args.input,
            output_dir=args.output,
            model_name=args.model,
            batch_size=args.batch_size,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
        )
    except Exception as e:
        logger.error(f"❌ Error: {e}", exc_info=True)
        exit(1)
