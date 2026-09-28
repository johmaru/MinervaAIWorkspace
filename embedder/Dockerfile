FROM python:3.12-slim

WORKDIR /app

# Bound native thread pools to avoid oversubscription on small hosts.
ENV OMP_NUM_THREADS=4
ENV TOKENIZERS_PARALLELISM=false

COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 60 --retries 10 -r requirements.txt

COPY . .

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
