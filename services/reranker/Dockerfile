FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app
COPY main.py .

# Pre-download model at build time (optional, uncomment for faster starts)
# RUN python -c "from transformers import AutoTokenizer, AutoModelForSequenceClassification; AutoTokenizer.from_pretrained('BAAI/bge-reranker-v2-m3'); AutoModelForSequenceClassification.from_pretrained('BAAI/bge-reranker-v2-m3')"

EXPOSE 8081

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
