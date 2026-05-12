from fastapi import FastAPI, File, UploadFile, Form, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import tempfile
import json
import os
import subprocess
import zipfile
import traceback
import numpy as np
import asyncio
from contextlib import asynccontextmanager
import httpx

# Dictionary to hold per-camera locks to prevent concurrent connection resets
camera_locks = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Shared client for all proxy requests to improve performance/pooling
    # We limit max_connections to 1 for the camera host to avoid resets
    limits = httpx.Limits(max_connections=5, max_keepalive_connections=1)
    app.state.client = httpx.AsyncClient(
        timeout=10.0, 
        follow_redirects=True,
        limits=limits,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"}
    )
    yield
    await app.state.client.aclose()

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def rebuild_model_from_tfjs(model_json_path, weights_bin_path, saved_model_dir):
    import tensorflow as tf
    import tensorflow_hub as hub
    import struct

    with open(model_json_path, 'r') as f:
        topology = json.load(f)

    print(f"topology keys: {list(topology.keys())}")

    # Handle both TF.js formats
    if 'modelTopology' in topology:
        model_config     = topology['modelTopology']
        weights_manifest = topology.get('weightsManifest', [])
    else:
        model_config     = topology
        weights_manifest = []

    print(f"model_config keys: {list(model_config.keys())}")
    print(f"weights_manifest groups: {len(weights_manifest)}")

    # Build model from config
    head_model = tf.keras.models.model_from_json(json.dumps(model_config))
    print(f"Head model layers: {len(head_model.layers)}")

    # Load weights binary
    with open(weights_bin_path, 'rb') as f:
        weights_data = f.read()
    print(f"weights_data size: {len(weights_data)} bytes")

    # Get weight specs
    weight_specs = []
    if weights_manifest:
        for group in weights_manifest:
            for spec in group.get('weights', []):
                weight_specs.append(spec)
        print(f"Weight specs from manifest: {len(weight_specs)}")
    else:
        print("No weightsManifest — inferring from model layers")
        for layer in head_model.layers:
            for w in layer.weights:
                weight_specs.append({
                    'name':  w.name,
                    'shape': w.shape.as_list(),
                    'dtype': w.dtype.name
                })
        print(f"Inferred weight specs: {len(weight_specs)}")

    # Parse weights from binary
    weights = []
    offset  = 0
    for spec in weight_specs:
        dtype = spec.get('dtype', 'float32')
        shape = spec.get('shape', [])

        num_elements = 1
        for dim in shape:
            if dim is not None and dim > 0:
                num_elements *= dim

        if dtype == 'float32':
            byte_count = num_elements * 4
            fmt        = f'{num_elements}f'
        elif dtype == 'int32':
            byte_count = num_elements * 4
            fmt        = f'{num_elements}i'
        else:
            byte_count = num_elements * 4
            fmt        = f'{num_elements}f'

        if offset + byte_count > len(weights_data):
            print(f"WARNING: not enough bytes for {spec.get('name','?')}")
            break

        values = struct.unpack(fmt, weights_data[offset:offset + byte_count])
        arr    = np.array(values, dtype=np.float32).reshape(shape)
        weights.append(arr)
        offset += byte_count
        print(f"Loaded: {spec.get('name','?')} shape={shape}")

    print(f"Total weights loaded: {len(weights)}")

    head_model.set_weights(weights)
    print("Head model weights set OK")

    print("Stitching MobileNet V3 base model from TF Hub...")
    base_model = hub.KerasLayer(
        "https://tfhub.dev/google/imagenet/mobilenet_v3_small_100_224/feature_vector/5",
        trainable=False
    )

    # NCHW input format, uint8 type compatible with K230 Ai2d native output
    inputs = tf.keras.Input(batch_size=1, shape=(3, 224, 224), dtype=tf.uint8, name="input_image")
    # Convert NCHW to NHWC
    x = tf.transpose(inputs, [0, 2, 3, 1])
    # Normalize uint8 to float32 [0.0, 1.0] matching TF.js frontend behavior
    x = tf.cast(x, tf.float32) / 255.0

    # Pass through unified network
    x = base_model(x)
    outputs = head_model(x)

    full_model = tf.keras.Model(inputs=inputs, outputs=outputs)
    
    # ── CRITICAL FIX for nncase "Only Can Get It When Shape Is Fixed !" ──
    # The K230 KPU compiler crashes if spatial dimensions (like 7x7 for GlobalAveragePool) 
    # are dynamic. By explicitly saving the model wrapped in a tf.function with a 
    # highly rigid static array shape [1, 3, 224, 224], we completely lock the ONNX 
    # math operations to fixed hardware limits.
    @tf.function(input_signature=[tf.TensorSpec(shape=[1, 3, 224, 224], dtype=tf.uint8, name="input_image")])
    def serving_fn(x):
        return full_model(x)

    tf.saved_model.save(full_model, saved_model_dir, signatures={'serving_default': serving_fn})
    
    print(f"Stitched SavedModel saved: {saved_model_dir}")
    return full_model


@app.post("/convert")
async def convert(
    model_json:  UploadFile = File(...),
    weights_bin: UploadFile = File(...),
    labels:      str        = Form(...),
):
    print("✅ /convert API HIT", flush=True)
    tmpdir = tempfile.mkdtemp()
    try:
        model_json_bytes  = await model_json.read()
        weights_bin_bytes = await weights_bin.read()
        label_list        = json.loads(labels)

        model_json_path  = os.path.join(tmpdir, 'model.json')
        weights_bin_path = os.path.join(tmpdir, 'weights.bin')
        labels_path      = os.path.join(tmpdir, 'labels.txt')
        saved_model_dir  = os.path.join(tmpdir, 'saved_model')
        onnx_path        = os.path.join(tmpdir, 'model.onnx')
        kmodel_path      = os.path.join(tmpdir, 'model.kmodel')
        zip_path         = os.path.join(tmpdir, 'k230_model.zip')

        # Save files
        topology = json.loads(model_json_bytes)
        with open(model_json_path, 'w') as f:
            json.dump(topology, f)
        with open(weights_bin_path, 'wb') as f:
            f.write(weights_bin_bytes)
        with open(labels_path, 'w') as f:
            for label in label_list:
                f.write(label.strip() + '\n')

        print(f"[1/4] Files saved. Labels: {label_list}")
        print(f"weights.bin size: {len(weights_bin_bytes)} bytes")

        # Step 1: Rebuild model
        print("[2/4] Rebuilding model from TF.js artifacts...")
        try:
            rebuild_model_from_tfjs(
                model_json_path,
                weights_bin_path,
                saved_model_dir
            )
        except Exception as e:
            traceback.print_exc()
            return JSONResponse(
                status_code=500,
                content={"error": f"Model rebuild failed: {str(e)}"}
            )

        # Step 2: SavedModel → ONNX
        print("[3/4] SavedModel → ONNX...")
        r2 = subprocess.run([
            'python', '-m', 'tf2onnx.convert',
            '--saved-model', saved_model_dir,
            '--output', onnx_path,
            '--opset', '13',
        ], capture_output=True, text=True, timeout=120)

        print("tf2onnx stdout:", r2.stdout)
        print("tf2onnx stderr:", r2.stderr)

        if r2.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={"error": f"ONNX failed: {r2.stderr}"}
            )

        onnx_size = os.path.getsize(onnx_path)
        print(f"ONNX OK size={onnx_size} bytes")

        # Step 3: ONNX → kmodel
        print("[4/4] ONNX → kmodel...")
        r3 = subprocess.run([
            'python', '/app/nncase_compile.py',
            onnx_path,
            kmodel_path,
        ], capture_output=True, text=True, timeout=300)

        print("nncase stdout:", r3.stdout)
        print("nncase stderr:", r3.stderr)

        if r3.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={
                    "error":  "kmodel compilation failed",
                    "details": r3.stderr,
                    "stdout":  r3.stdout
                }
            )

        if not os.path.exists(kmodel_path):
            return JSONResponse(
                status_code=500,
                content={"error": "kmodel file not created"}
            )

        kmodel_size = os.path.getsize(kmodel_path)
        print(f"kmodel size={kmodel_size} bytes")

        if kmodel_size < 100:
            return JSONResponse(
                status_code=500,
                content={"error": f"kmodel too small: {kmodel_size} bytes"}
            )

        # Pack into zip
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.write(kmodel_path, 'model.kmodel')
            zf.write(labels_path, 'labels.txt')

        print("Zip created OK")

        return FileResponse(
            path=zip_path,
            media_type='application/zip',
            filename='k230_model.zip',
        )

    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )


async def push_to_k230(client, filepath, filename, k230_url):
    with open(filepath, 'rb') as f:
        data = f.read()
    headers = {
        'X-Filename': filename,
        'Content-Type': 'application/octet-stream',
        'Content-Length': str(len(data)),
    }
    resp = await client.post(k230_url, content=data, headers=headers, timeout=60.0)
    return resp.status_code == 200


@app.post("/deploy")
async def deploy(
    model_json:  UploadFile = File(...),
    weights_bin: UploadFile = File(...),
    labels:      str        = Form(...),
    k230_ip:     str        = Form(default="192.168.169.1"),
    k230_port:   int        = Form(default=8080),
):
    tmpdir = tempfile.mkdtemp()
    try:
        model_json_bytes  = await model_json.read()
        weights_bin_bytes = await weights_bin.read()
        label_list        = json.loads(labels)

        model_json_path  = os.path.join(tmpdir, 'model.json')
        weights_bin_path = os.path.join(tmpdir, 'weights.bin')
        labels_path      = os.path.join(tmpdir, 'labels.txt')
        saved_model_dir  = os.path.join(tmpdir, 'saved_model')
        onnx_path        = os.path.join(tmpdir, 'model.onnx')
        kmodel_path      = os.path.join(tmpdir, 'model.kmodel')

        # Save files
        topology = json.loads(model_json_bytes)
        with open(model_json_path, 'w') as f:
            json.dump(topology, f)
        with open(weights_bin_path, 'wb') as f:
            f.write(weights_bin_bytes)
        with open(labels_path, 'w') as f:
            for label in label_list:
                f.write(label.strip() + '\n')

        print(f"[1/4] Files saved. Labels: {label_list}")
        print(f"weights.bin size: {len(weights_bin_bytes)} bytes")

        # Step 1: Rebuild model
        print("[2/4] Rebuilding model from TF.js artifacts...")
        try:
            rebuild_model_from_tfjs(
                model_json_path,
                weights_bin_path,
                saved_model_dir
            )
        except Exception as e:
            traceback.print_exc()
            return JSONResponse(
                status_code=500,
                content={"error": f"Model rebuild failed: {str(e)}"}
            )

        # Step 2: SavedModel → ONNX
        print("[3/4] SavedModel → ONNX...")
        r2 = subprocess.run([
            'python', '-m', 'tf2onnx.convert',
            '--saved-model', saved_model_dir,
            '--output', onnx_path,
            '--opset', '13',
        ], capture_output=True, text=True, timeout=120)

        print("tf2onnx stdout:", r2.stdout)
        print("tf2onnx stderr:", r2.stderr)

        if r2.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={"error": f"ONNX failed: {r2.stderr}"}
            )

        onnx_size = os.path.getsize(onnx_path)
        print(f"ONNX OK size={onnx_size} bytes")

        # Step 3: ONNX → kmodel
        print("[4/4] ONNX → kmodel...")
        r3 = subprocess.run([
            'python', '/app/nncase_compile.py',
            onnx_path,
            kmodel_path,
        ], capture_output=True, text=True, timeout=300)

        print("nncase stdout:", r3.stdout)
        print("nncase stderr:", r3.stderr)

        if r3.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={
                    "error":  "kmodel compilation failed",
                    "details": r3.stderr,
                    "stdout":  r3.stdout
                }
            )

        if not os.path.exists(kmodel_path):
            return JSONResponse(
                status_code=500,
                content={"error": "kmodel file not created"}
            )

        kmodel_size = os.path.getsize(kmodel_path)
        print(f"kmodel size={kmodel_size} bytes")

        if kmodel_size < 100:
            return JSONResponse(
                status_code=500,
                content={"error": f"kmodel too small: {kmodel_size} bytes"}
            )

        # Push to K230
        k230_url = f"http://{k230_ip}:{k230_port}/upload"
        print(f"Pushing to K230 at {k230_url}...")
        
        try:
            client = app.state.client
            kmodel_ok = await push_to_k230(client, kmodel_path, 'model.kmodel', k230_url)
            labels_ok = await push_to_k230(client, labels_path, 'labels.txt', k230_url)
            
            if not kmodel_ok or not labels_ok:
                return JSONResponse(
                    status_code=502,
                    content={"error": "Failed to upload to K230 (status code not 200)"}
                )
        except Exception as e:
            traceback.print_exc()
            return JSONResponse(
                status_code=502,
                content={"error": f"Failed to connect to K230 at {k230_url}: {str(e)}"}
            )

        return JSONResponse(
            status_code=200,
            content={
                "status": "ok",
                "kmodel_size": kmodel_size,
                "deployed": ["model.kmodel", "labels.txt"]
            }
        )

    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )

@app.get("/")
async def root():
    return {"status": "backend running"}
    
@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/proxy")
async def proxy_cam(url: str = Query(..., description="Camera URL to proxy")):
    """
    Fetch any IP camera URL server-side and return it with CORS headers.
    Solves browser CORS restriction for K230 mjpg-streamer.
    """
    import httpx
    
    proxy_timeout = httpx.Timeout(10.0, connect=5.0, read=15.0)

    async def stream_generator(response):
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        except Exception as e:
            pass  # Stream closed by client — normal
        finally:
            await response.aclose()

    client = app.state.client
    try:
        response = await client.stream("GET", url, timeout=proxy_timeout).__aenter__()
        
        if response.status_code >= 400:
            await response.aclose()
            return JSONResponse(
                status_code=response.status_code, 
                content={"error": f"Camera returned status {response.status_code}"}
            )

        content_type = response.headers.get("Content-Type", "image/jpeg")
        
        if "multipart/x-mixed-replace" in content_type:
            return StreamingResponse(
                stream_generator(response),
                media_type=content_type,
                headers={
                    "Cache-Control": "no-store",
                    "Access-Control-Allow-Origin": "*",
                }
            )
        else:
            data = await response.aread()
            await response.aclose()
            return Response(
                content=data,
                media_type=content_type,
                headers={
                    "Cache-Control": "no-store",
                    "Access-Control-Allow-Origin": "*",
                }
            )
            
    except httpx.ReadTimeout:
        return JSONResponse(status_code=504, content={"error": "Camera read timeout"})
    except httpx.ConnectTimeout:
        return JSONResponse(status_code=504, content={"error": "Camera connect timeout"})
    except Exception as e:
        print(f"Proxy error for {url}: {repr(e)}")
        return JSONResponse(status_code=500, content={"error": repr(e)})


@app.get("/test-conversion")
async def test_conversion():
    tmpdir = tempfile.mkdtemp()
    try:
        import tensorflow as tf

        model = tf.keras.Sequential([
            tf.keras.layers.Dense(
                100, activation='relu', input_shape=(256,)
            ),
            tf.keras.layers.Dense(2, activation='softmax')
        ])
        model.compile(
            optimizer='adam',
            loss='categorical_crossentropy'
        )

        saved_dir   = os.path.join(tmpdir, 'saved_model')
        onnx_path   = os.path.join(tmpdir, 'test.onnx')
        kmodel_path = os.path.join(tmpdir, 'test.kmodel')

        model.save(saved_dir)

        r1 = subprocess.run([
            'python', '-m', 'tf2onnx.convert',
            '--saved-model', saved_dir,
            '--output', onnx_path,
            '--opset', '13'
        ], capture_output=True, text=True)

        if r1.returncode != 0:
            return {"step": "onnx", "error": r1.stderr}

        r2 = subprocess.run([
            'python', '/app/nncase_compile.py',
            onnx_path, kmodel_path
        ], capture_output=True, text=True)

        if r2.returncode != 0:
            return {
                "step":   "kmodel",
                "error":  r2.stderr,
                "stdout": r2.stdout
            }

        kmodel_size = os.path.getsize(kmodel_path) \
            if os.path.exists(kmodel_path) else 0

        return {
            "status":        "ok",
            "onnx_size":     os.path.getsize(onnx_path),
            "kmodel_size":   kmodel_size,
            "nncase_stdout": r2.stdout
        }

    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}