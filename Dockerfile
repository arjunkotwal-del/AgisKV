FROM python:3.12-slim AS cpp_builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY cpp_core ./cpp_core
RUN cmake -S cpp_core -B cpp_core/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build cpp_core/build -j \
    && ./cpp_core/build/aegis_tests \
    && ./cpp_core/build/aegis_bench cpp_core/build/bench_results.json

FROM node:22-alpine AS web_builder
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=cpp_builder /src/cpp_core/build ./cpp_core/build
COPY --from=web_builder /web/dist ./web/dist
COPY gateway ./gateway
COPY evals ./evals
COPY tests ./tests
EXPOSE 8000
CMD ["uvicorn", "gateway.app:app", "--host", "0.0.0.0", "--port", "8000"]
