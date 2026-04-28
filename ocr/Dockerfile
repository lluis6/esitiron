FROM python:3.11-slim

ENV LANG=C.UTF-8
ENV PYTHONIOENCODING=utf-8
ENV PYTHONUTF8=1

# 1. Instalamos las dependencias de sistema (Poppler para PDF y libgl1 para OpenCV)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Instalamos las librerías de Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 3. Copiamos el código
COPY . .

# 4. Exponemos el puerto
EXPOSE 8000

# 5. Comando de ejecución (usando python para que lea tu bloque final de uvicorn.run)
CMD ["python", "main.py"]
