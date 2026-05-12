from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import tempfile
import os
import ctypes
import string
import shutil
import subprocess
import json
import httpx
import zipfile
import base64
import time
import serial
import serial.tools.list_ports

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Drive-letter detection ────────────────────────────────────────────────────

def list_all_drives():
    result = []
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    for letter in string.ascii_uppercase:
        if bitmask & 1:
            drive = letter + ":\\"
            try:
                buf = ctypes.create_unicode_buffer(261)
                ctypes.windll.kernel32.GetVolumeInformationW(
                    drive, buf, 261, None, None, None, None, 0)
                result.append((drive, buf.value.strip() or "(no label)"))
            except Exception:
                pass
        bitmask >>= 1
    return result

def find_canmv_drive():
    for drive, label in list_all_drives():
        if label.lower() in ('sdcard', 'data', 'canmv'):
            return drive, label
    return None, None

# ── MTP via PowerShell Shell.Application ─────────────────────────────────────

_PS_LIST = r"""
$shell  = New-Object -ComObject Shell.Application
$myComp = $shell.NameSpace(17)
$out    = [System.Collections.Generic.List[object]]::new()
foreach ($item in $myComp.Items()) {
    $subs = @()
    try { foreach ($s in $item.GetFolder.Items()) { $subs += $s.Name } } catch {}
    $obj = [PSCustomObject]@{ Name = $item.Name; Type = $item.Type; Subs = $subs }
    $out.Add($obj)
}
$out | ConvertTo-Json -Depth 3 -Compress
"""

def ps_list_devices():
    """Return list of dicts with Name/Type/Subs for every item under This PC."""
    r = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS_LIST],
        capture_output=True, text=True, timeout=20)
    if r.returncode != 0 or not r.stdout.strip():
        return []
    try:
        data = json.loads(r.stdout.strip())
        return [data] if isinstance(data, dict) else data
    except Exception:
        return []

def ps_copy_to_mtp(src_file, device_name, subfolder=""):
    """
    Copy src_file into an MTP device (device_name) optionally into subfolder.
    Returns (success: bool, error_msg: str|None).
    """
    src_escaped = src_file.replace("'", "''")

    size_kb = os.path.getsize(src_file) / 1024
    wait_sec = max(2, int(size_kb / 500) + 1)

    sub_nav = ""
    if subfolder:
        sub_nav = f"""
foreach ($s in $ns.Items()) {{
    if ($s.Name -eq '{subfolder}') {{ $ns = $s.GetFolder; break }}
}}"""

    ps = f"""
$shell  = New-Object -ComObject Shell.Application
$myComp = $shell.NameSpace(17)
$device = $null
foreach ($item in $myComp.Items()) {{
    if ($item.Name -like '*{device_name}*') {{ $device = $item; break }}
}}
if (-not $device) {{ Write-Error 'DEVICE_NOT_FOUND'; exit 1 }}

$ns = $device.GetFolder
{sub_nav}

$srcDir  = $shell.NameSpace([System.IO.Path]::GetDirectoryName('{src_escaped}'))
$srcItem = $srcDir.ParseName([System.IO.Path]::GetFileName('{src_escaped}'))
if (-not $srcItem) {{ Write-Error 'SRC_NOT_FOUND'; exit 1 }}

# 20 = 16 (Yes to All) + 4 (No Progress Dialog)
$ns.CopyHere($srcItem, 20)
Start-Sleep -Seconds {wait_sec}
Write-Output 'SUCCESS'
"""
    try:
        timeout = wait_sec + 30
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=timeout)
        if "SUCCESS" in r.stdout:
            return True, None
        err = (r.stderr or r.stdout or "Unknown error").strip()
        return False, err
    except subprocess.TimeoutExpired:
        return False, "Timed out — file may be too large or board disconnected."
    except Exception as e:
        return False, str(e)

# ── Serial COM Port Transfer Logic ──────────────────────────────────────────

def pyserial_copy(filepath, com_port, filename):
    BAUD_RATE = 921600
    try:
        ser = serial.Serial()
        ser.port = com_port
        ser.baudrate = BAUD_RATE
        ser.timeout = 5.0  # Increased timeout for file operations on K230
        ser.dsrdtr = None
        ser.rtscts = False
        ser.open()
        try:
            ser.setDTR(True)
            ser.setRTS(True)
        except:
            pass
        time.sleep(1.0) # Wait for connection
        
        file_size = os.path.getsize(filepath)
        print(f"[{com_port}] Sending START_TRANSFER:{filename}:{file_size}")
        
        # Flush input buffer
        ser.reset_input_buffer()
        
        ser.write(f"START_TRANSFER:{filename}:{file_size}\n".encode('ascii'))
        ser.flush()
        
        # Wait for READY
        t0 = time.time()
        ready = False
        while time.time() - t0 < 5:
            line = ser.readline().decode('ascii', errors='ignore').strip()
            if line == "READY":
                ready = True
                break
            elif line.startswith("ERR:"):
                ser.close()
                return False, f"Board error: {line}"
                
        if not ready:
            ser.close()
            return False, "Board did not send READY. Ensure k230_usb_receive.py is running on CanMV IDE."
            
        print(f"[{com_port}] Board READY. Sending base64 chunks...")
        
        with open(filepath, 'rb') as f:
            chunk_count = 0
            while True:
                chunk = f.read(8192)
                if not chunk:
                    break
                b64_chunk = base64.b64encode(chunk).decode('ascii')
                ser.write(f"DATA:{b64_chunk}\n".encode('ascii'))
                ser.flush()
                
                # Wait for ACK
                ack = ser.readline().decode('ascii', errors='ignore').strip()
                if ack != "ACK":
                    ser.close()
                    return False, f"Did not receive ACK. Got: {ack}"
                chunk_count += 1
                
        print(f"[{com_port}] Sent {chunk_count} chunks. Sending EOF...")
        ser.write(b"EOF\n")
        ser.flush()
        
        final = ser.readline().decode('ascii', errors='ignore').strip()
        ser.close()
        
        if final == "SUCCESS":
            return True, None
        return False, f"K230 failed at EOF: {final}"
        
    except serial.SerialException as e:
        return False, f"Serial port error: {e}"
    except Exception as e:
        return False, str(e)


@app.get("/usb-ports")
async def get_usb_ports():
    ports = serial.tools.list_ports.comports()
    result = []
    for p in sorted(ports):
        result.append({
            "device": p.device,
            "description": p.description
        })
    return {"ports": result}


@app.post("/deploy")
async def deploy(
    model_json:  UploadFile = File(...),
    weights_bin: UploadFile = File(...),
    labels:      str        = Form(...),
    k230_ip:     str        = Form(default="192.168.169.1"),
    k230_port:   int        = Form(default=8080),
    com_port:    str        = Form(default=""),
):
    print(f"Received deploy request. COM Port: '{com_port}'")
    
    # 1. Forward request to Docker (localhost:5001/convert)
    tmpdir = tempfile.mkdtemp()
    try:
        model_json_bytes  = await model_json.read()
        weights_bin_bytes = await weights_bin.read()
        
        async with httpx.AsyncClient(timeout=300.0) as client:
            files = {
                'model_json': (model_json.filename, model_json_bytes, model_json.content_type),
                'weights_bin': (weights_bin.filename, weights_bin_bytes, weights_bin.content_type),
            }
            data = {'labels': labels}
            
            resp = await client.post('http://localhost:5001/convert', files=files, data=data)
            
            if resp.status_code != 200:
                print("Docker compilation failed.")
                return JSONResponse(status_code=500, content={"error": f"Compilation failed: {resp.text}"})
            
            # Save the compiled zip returned by Docker
            zip_path = os.path.join(tmpdir, "compiled.zip")
            with open(zip_path, 'wb') as f:
                f.write(resp.content)
                
            print("Successfully received compiled model from Docker.")
            
            # Extract zip
            extract_dir = os.path.join(tmpdir, "extracted")
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(extract_dir)
                
            kmodel_path = os.path.join(extract_dir, 'model.kmodel')
            labels_path = os.path.join(extract_dir, 'labels.txt')
            kmodel_size = os.path.getsize(kmodel_path)
            
            # 2. USB Serial / MTP / Mass Storage Logic
            usb_copied = False
            usb_method = None
            
            try:
                if com_port and com_port.strip():
                    print(f"Attempting to deploy via Serial COM port: {com_port}")
                    ok1, err1 = pyserial_copy(kmodel_path, com_port, 'model.kmodel')
                    if ok1:
                        ok2, err2 = pyserial_copy(labels_path, com_port, 'labels.txt')
                        if ok2:
                            usb_copied = True
                            usb_method = "Serial (COM)"
                        else:
                            print(f"Serial copy failed for labels: {err2}")
                    else:
                        print(f"Serial copy failed for kmodel: {err1}")
                
                if not usb_copied:
                    print("Checking for K230 USB connection (Mass Storage)...")
                drive, label = find_canmv_drive()
                if drive:
                    print(f"Found USB drive: {drive} (label={label})")
                    dest_dir = drive
                    shutil.copy2(kmodel_path, os.path.join(dest_dir, 'model.kmodel'))
                    shutil.copy2(labels_path, os.path.join(dest_dir, 'labels.txt'))
                    usb_copied = True
                    usb_method = "USB Mass Storage"
                else:
                    print("Checking for K230 MTP connection...")
                    devices = ps_list_devices()
                    canmv_dev = next((d for d in devices if "canmv" in d.get("Name", "").lower()), None)
                    if canmv_dev:
                        print(f"Found MTP device: {canmv_dev['Name']}")
                        subs = canmv_dev.get("Subs", [])
                        
                        subfolder = ""
                        for s in subs:
                            if s.lower() == "sdcard":
                                subfolder = s
                                break

                        print(f"Copying to MTP subfolder: '{subfolder}'")
                        ok1, err1 = ps_copy_to_mtp(kmodel_path, canmv_dev["Name"], subfolder)
                        ok2, err2 = ps_copy_to_mtp(labels_path, canmv_dev["Name"], subfolder)
                        
                        if ok1 and ok2:
                            usb_copied = True
                            usb_method = "MTP"
                        else:
                            print(f"MTP copy failed. kmodel: {err1}, labels: {err2}")
            except Exception as e:
                print(f"USB detection/copy failed: {e}")

            if usb_copied:
                print(f"Successfully deployed via {usb_method}")
                return JSONResponse(
                    status_code=200,
                    content={
                        "status": "ok",
                        "kmodel_size": kmodel_size,
                        "deployed": ["model.kmodel", "labels.txt"],
                        "method": usb_method
                    }
                )

            # Fallback: Push to K230 via Wi-Fi HTTP
            k230_url = f"http://{k230_ip}:{k230_port}/upload"
            print(f"USB not found or failed. Pushing to K230 at {k230_url} via Wi-Fi...")
            
            with open(kmodel_path, 'rb') as f:
                kmodel_data = f.read()
            with open(labels_path, 'rb') as f:
                labels_data = f.read()

            k_resp = await client.post(k230_url, content=kmodel_data, headers={'X-Filename': 'model.kmodel', 'Content-Type': 'application/octet-stream'})
            l_resp = await client.post(k230_url, content=labels_data, headers={'X-Filename': 'labels.txt', 'Content-Type': 'application/octet-stream'})
            
            if k_resp.status_code != 200 or l_resp.status_code != 200:
                return JSONResponse(status_code=502, content={"error": "Failed to upload to K230 over Wi-Fi"})

            return JSONResponse(
                status_code=200,
                content={
                    "status": "ok",
                    "kmodel_size": kmodel_size,
                    "deployed": ["model.kmodel", "labels.txt"],
                    "method": "Wi-Fi"
                }
            )

    except Exception as e:
        print(f"Error: {str(e)}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/convert")
async def convert(
    model_json:  UploadFile = File(...),
    weights_bin: UploadFile = File(...),
    labels:      str        = Form(...),
):
    print("Proxying /convert to Docker compiler...")
    try:
        model_json_bytes = await model_json.read()
        weights_bin_bytes = await weights_bin.read()
        async with httpx.AsyncClient(timeout=300.0) as client:
            files = {
                'model_json': (model_json.filename, model_json_bytes, model_json.content_type),
                'weights_bin': (weights_bin.filename, weights_bin_bytes, weights_bin.content_type),
            }
            data = {'labels': labels}
            resp = await client.post('http://localhost:5001/convert', files=files, data=data)
            from fastapi.responses import Response
            return Response(
                content=resp.content, 
                status_code=resp.status_code, 
                media_type=resp.headers.get("Content-Type", "application/zip"),
                headers={"Access-Control-Allow-Origin": "*"}
            )
    except Exception as e:
        return JSONResponse(
            status_code=500, 
            content={"error": f"Failed to proxy to Docker: {e}"},
            headers={"Access-Control-Allow-Origin": "*"}
        )

@app.get("/proxy")
async def proxy_cam(url: str):
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"http://localhost:5001/proxy?url={url}")
            from fastapi.responses import Response, StreamingResponse
            
            # For MJPEG streams, we need to stream the response
            if "multipart/x-mixed-replace" in resp.headers.get("Content-Type", ""):
                async def stream_generator():
                    async with client.stream("GET", f"http://localhost:5001/proxy?url={url}") as stream_resp:
                        async for chunk in stream_resp.aiter_bytes():
                            yield chunk
                return StreamingResponse(
                    stream_generator(),
                    media_type=resp.headers.get("Content-Type"),
                    headers={"Access-Control-Allow-Origin": "*"}
                )
            
            return Response(
                content=resp.content, 
                status_code=resp.status_code, 
                media_type=resp.headers.get("Content-Type", "image/jpeg"),
                headers={"Access-Control-Allow-Origin": "*"}
            )
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/health")
async def health():
    return {"status": "ok", "service": "Windows USB Agent"}
