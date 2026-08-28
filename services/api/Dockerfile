FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv/api

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy only what the service needs (never .env / *.db / .venv — see .dockerignore as the backstop).
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini pyproject.toml ./

# Bundled data (mandis.json, agmarknet_snapshot.json, demo_scenarios/) is mounted or copied to /data.
ENV DATA_DIR=/data
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
