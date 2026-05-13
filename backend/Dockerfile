FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

ENV CONTEXTNORF_DATA_DIR=/app/data
RUN mkdir -p "$CONTEXTNORF_DATA_DIR"

RUN curl -fsSL -o "$CONTEXTNORF_DATA_DIR/navec_hudlit.tar" \
    "https://storage.yandexcloud.net/natasha-navec/packs/navec_hudlit_v1_12B_500K_300d_100q.tar"

RUN curl -fsSL -o /tmp/rv.zip "https://vectors.nlpl.eu/repository/20/180.zip" \
    && unzip -p /tmp/rv.zip model.bin > "$CONTEXTNORF_DATA_DIR/rusvectores_ruscorpora.bin" \
    && rm /tmp/rv.zip

RUN curl -fsSL -o /tmp/freq2011.zip "http://dict.ruslang.ru/Freq2011.zip" \
    && unzip -p /tmp/freq2011.zip freqrnc2011.csv > "$CONTEXTNORF_DATA_DIR/freqrnc2011.csv" \
    && rm /tmp/freq2011.zip

COPY app ./app

RUN python -m app.v2.warmup

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
