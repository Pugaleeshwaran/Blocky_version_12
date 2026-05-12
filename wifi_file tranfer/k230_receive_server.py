"""
k230_receive_server.py  — runs ON the K230 board (MicroPython)
1. Creates WiFi hotspot  (SSID: YAHBOOM-K230  password: 12345678)
2. Starts HTTP server on port 8080
3. Receives files from PC and saves them to /sdcard/
"""

import network
import socket
import os
import time

# ---------- hotspot config ----------
AP_SSID = 'YAHBOOM-K230'
AP_KEY  = '12345678'
PORT    = 8080
SAVE_DIR = None   # auto-detected below
# ------------------------------------

def detect_save_dir():
    path = '/sdcard'
    try:
        os.mkdir(path)
        print("Created folder:", path)
    except OSError:
        pass  # already exists
    print("Save directory:", path)
    return path

def create_ap():
    ap = network.WLAN(network.AP_IF)
    if not ap.active():
        ap.active(True)
    ap.config(ssid=AP_SSID, key=AP_KEY)
    time.sleep(3)
    ip_info = ap.ifconfig()
    print("Hotspot ready  SSID:", AP_SSID)
    print("Board IP:", ip_info[0])
    return ip_info[0]

def ensure_dir(path):
    try:
        os.mkdir(path)
    except OSError:
        pass  # already exists

def send_response(conn, status, body):
    cors_headers = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n"
    resp = "HTTP/1.1 {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}".format(
        status, len(body), cors_headers, body)
    conn.sendall(resp.encode())

def read_until(conn, delimiter, max_bytes=4096):
    """Read from socket byte-by-byte until delimiter found."""
    buf = b''
    delim = delimiter.encode() if isinstance(delimiter, str) else delimiter
    while len(buf) < max_bytes:
        ch = conn.recv(1)
        if not ch:
            break
        buf += ch
        if buf.endswith(delim):
            return buf[:-len(delim)]
    return buf

def handle_request(conn):
    try:
        # Read request line + headers
        header_data = b''
        while True:
            chunk = conn.recv(1)
            if not chunk:
                break
            header_data += chunk
            if header_data.endswith(b'\r\n\r\n'):
                break

        headers_str = header_data.decode('utf-8', 'ignore')
        lines = headers_str.split('\r\n')
        request_line = lines[0]

        # Parse headers into dict
        headers = {}
        for line in lines[1:]:
            if ':' in line:
                k, v = line.split(':', 1)
                headers[k.strip().lower()] = v.strip()

        # Handle CORS preflight
        if request_line.startswith('OPTIONS'):
            send_response(conn, '204 No Content', '')
            return

        # Only handle POST /upload
        if not request_line.startswith('POST /upload'):
            send_response(conn, '404 Not Found', 'Use POST /upload')
            return



        filename = headers.get('x-filename', 'received_file.bin')
        content_length = int(headers.get('content-length', 0))

        # Sanitize filename (no path traversal)
        filename = filename.replace('/', '_').replace('\\', '_').replace('..', '_')
        save_path = SAVE_DIR + '/' + filename
        print("Receiving:", filename, "(", content_length, "bytes )")
        print("Saving to:", save_path)

        # Read body and write to SD card
        received = 0
        empty_reads = 0
        with open(save_path, 'wb') as f:
            while received < content_length:
                to_read = min(4096, content_length - received)
                chunk = conn.recv(to_read)
                if not chunk:
                    time.sleep(0.01)
                    empty_reads += 1
                    if empty_reads > 500:  # 5 seconds wait for more data
                        print("Connection lost mid-transfer")
                        break
                    continue
                empty_reads = 0
                f.write(chunk)
                received += len(chunk)

        print("Saved to", save_path, "  bytes:", received)
        send_response(conn, '200 OK', 'OK:' + filename)

    except Exception as e:
        print("Error:", e)
        try:
            send_response(conn, '500 Internal Server Error', str(e))
        except:
            pass

def start_server(ip):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setblocking(True)          # force blocking — fixes EAGAIN on MicroPython
    s.bind((ip, PORT))
    s.listen(5)
    print("File server listening on  http://{}:{}".format(ip, PORT))
    print("Waiting for files from PC...")

    while True:
        try:
            conn, addr = s.accept()
            conn.setblocking(True)   # also force client socket to blocking
            try:
                conn.settimeout(60.0)
            except:
                pass
            print("\nConnected from:", addr)
            handle_request(conn)
            conn.close()
        except OSError as e:
            if e.args[0] == 11:      # EAGAIN — no client yet, just retry
                time.sleep(0.05)
            else:
                print("Socket error:", e)
        except Exception as e:
            print("Connection error:", e)

# ---- main ----
SAVE_DIR = detect_save_dir()
ip = create_ap()
start_server(ip)
