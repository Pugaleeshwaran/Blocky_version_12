FROM python:3.9-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    cmake \
    libgomp1 \
    wget \
    curl \
    bash \
    libicu-dev \
    && rm -rf /var/lib/apt/lists/*

# Install .NET 7
RUN curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh \
    && chmod +x dotnet-install.sh \
    && ./dotnet-install.sh --channel 7.0 --runtime dotnet --install-dir /usr/share/dotnet \
    && rm dotnet-install.sh

ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH=$PATH:/usr/share/dotnet
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

# Install packages
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
    tensorflow==2.13.0 \
    tf2onnx==1.15.1 \
    onnx==1.14.1 \
    numpy \
    fastapi \
    uvicorn \
    python-multipart \
    tensorflow-hub \
    httpx

RUN pip install --no-cache-dir nncase-kpu

COPY . .

EXPOSE 5001
CMD ["uvicorn", "convert_server:app", "--host", "0.0.0.0", "--port", "5001"]