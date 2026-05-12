"""
pc_usb_camera.py - runs on WINDOWS PC

Displays live camera feed from K230 board over USB serial (COM port).
Requires: pip install pyserial Pillow

Steps:
  1. Copy k230_usb_camera.py to K230 and run it in CanMV IDE
  2. CLOSE CanMV IDE (it holds the COM port)
  3. Run this script, select the K230 COM port, click Connect
"""

import base64
import io
import os
import threading
import time
import tkinter as tk
from tkinter import ttk

from PIL import Image, ImageTk
import serial
import serial.tools.list_ports

# Config
BAUD_RATE = 921600
READ_TIMEOUT = 0.2
DISPLAY_SIZE = (320, 240)
SERIAL_CHUNK_SIZE = 8192
DEBUG_LOG_PATH = os.path.join(os.getcwd(), "pc_usb_camera_debug.log")
DEBUG_VERBOSE_FRAMES = False


def debug_print(msg):
    text = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(text, flush=True)
    try:
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except Exception:
        pass


def list_com_ports():
    """Return list of (port, description) for all available COM ports."""
    ports = serial.tools.list_ports.comports()
    return [(p.device, p.description) for p in sorted(ports)]


class UsbCameraApp:
    def __init__(self, root):
        self.root = root
        root.title("K230 USB Camera")
        root.resizable(False, False)
        root.geometry("430x330")

        top = tk.Frame(root)
        top.pack(padx=10, pady=6, fill=tk.X)

        tk.Label(top, text="COM Port:").pack(side=tk.LEFT)
        self.port_var = tk.StringVar()
        self.port_combo = ttk.Combobox(
            top, textvariable=self.port_var, width=32, state="readonly"
        )
        self.port_combo.pack(side=tk.LEFT, padx=4)

        tk.Button(top, text="Refresh", command=self.refresh_ports).pack(
            side=tk.LEFT, padx=2
        )
        self.connect_btn = tk.Button(
            top,
            text="Connect",
            bg="#2a7a2a",
            fg="white",
            command=self.toggle_connect,
        )
        self.connect_btn.pack(side=tk.LEFT, padx=4)

        self.canvas = tk.Label(
            root,
            bg="black",
            width=DISPLAY_SIZE[0],
            height=DISPLAY_SIZE[1],
        )
        self.canvas.pack(padx=10, pady=4)

        bot = tk.Frame(root)
        bot.pack(padx=10, pady=4, fill=tk.X)
        self.status_var = tk.StringVar(value="Select COM port then click Connect")
        tk.Label(bot, textvariable=self.status_var, fg="navy", font=("Arial", 9)).pack(
            side=tk.LEFT
        )
        self.fps_var = tk.StringVar(value="")
        tk.Label(bot, textvariable=self.fps_var, fg="gray", font=("Arial", 9)).pack(
            side=tk.RIGHT
        )

        self._running = False
        self._thread = None
        self._tk_img = None
        self._serial = None
        self._decode_errors = 0
        self._frames_seen = 0
        self._status_color = "navy"
        self._line_count = 0
        self._saved_debug_frame = False
        self._last_decode_error = ""

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.refresh_ports()

    def refresh_ports(self):
        ports = list_com_ports()
        debug_print("Refresh ports: " + ", ".join(f"{dev} ({desc})" for dev, desc in ports))
        entries = [f"{dev} - {desc}" for dev, desc in ports]
        self.port_combo["values"] = entries

        selected = 0
        for i, (_, desc) in enumerate(ports):
            keywords = ("ch340", "cdc", "usb serial", "uart", "k230", "canmv")
            if any(k in desc.lower() for k in keywords):
                selected = i
                break

        if entries:
            self.port_combo.current(selected)
        else:
            self.set_status("No COM ports found. Plug in USB cable.", "red")

    def _selected_port(self):
        val = self.port_var.get()
        if not val:
            return None
        return val.split(" - ")[0].strip()

    def toggle_connect(self):
        if self._running:
            self._running = False
            self.connect_btn.config(text="Connect", bg="#2a7a2a")
            self.set_status("Disconnected", "navy")
            return

        port = self._selected_port()
        if not port:
            self.set_status("Select a COM port first.", "red")
            return

        self._running = True
        self._decode_errors = 0
        self._frames_seen = 0
        self._line_count = 0
        self._saved_debug_frame = False
        self.connect_btn.config(text="Disconnect", bg="#aa2222")
        self.set_status(f"Connecting to {port}...", "navy")
        debug_print(f"Connect requested: {port}")
        self._thread = threading.Thread(
            target=self._reader_thread, args=(port,), daemon=True
        )
        self._thread.start()

    def _reader_thread(self, port):
        try:
            ser = serial.Serial()
            ser.port = port
            ser.baudrate = BAUD_RATE
            ser.timeout = READ_TIMEOUT
            ser.dsrdtr = None
            ser.rtscts = False
            ser.open()
            debug_print(f"Serial opened: {port} baud={BAUD_RATE} timeout={READ_TIMEOUT}")
            try:
                ser.setDTR(True)
                ser.setRTS(True)
                debug_print("DTR/RTS set True")
            except Exception:
                pass
            time.sleep(0.5)
            self._serial = ser
            self.root.after(0, self.set_status, f"Connected: {port} - waiting for data...", "green")
            debug_print("Waiting for USB camera lines")

            frame_count = 0
            t0 = time.time()
            rx_buffer = b""
            total_bytes = 0
            last_rx_report = time.time()

            while self._running:
                raw = ser.read(SERIAL_CHUNK_SIZE)
                if not raw:
                    continue

                total_bytes += len(raw)
                now = time.time()
                if now - last_rx_report >= 1.0:
                    debug_print(f"RX bytes total={total_bytes} buffer={len(rx_buffer)}")
                    last_rx_report = now

                rx_buffer += raw

                while b"\n" in rx_buffer:
                    raw_line, rx_buffer = rx_buffer.split(b"\n", 1)
                    line = raw_line.decode("ascii", errors="ignore").strip()
                    if not line:
                        continue
                    self._line_count += 1

                    if line.startswith("F:"):
                        if DEBUG_VERBOSE_FRAMES:
                            debug_print(f"F line received len={len(line) - 2}")
                        self._handle_frame_line(line[2:], frame_count, t0)
                        if self._last_frame_ok:
                            frame_count += 1
                        elif self._decode_errors % 3 == 1:
                            self.root.after(
                                0,
                                self.set_status,
                                f"Frame line received, decode failed. len={len(line) - 2} {self._last_decode_error}",
                                "dark orange",
                            )

                    elif line.startswith("H:"):
                        debug_print(f"H line received: {line}")
                        self._handle_status_line(line[2:])
                    elif self._line_count % 10 == 1:
                        debug_print(f"Other line received len={len(line)} text={line[:80]}")
                        self.root.after(
                            0,
                            self.set_status,
                            f"Receiving non-frame data: {line[:40]}",
                            "dark orange",
                        )

        except serial.SerialException as e:
            debug_print(f"SerialException: {e}")
            self.root.after(0, self.set_status, f"Serial error: {e}", "red")
        except Exception as e:
            debug_print(f"Reader error: {e}")
            if self._running:
                self.root.after(0, self.set_status, f"Error: {e}", "red")
        finally:
            try:
                if self._serial:
                    self._serial.close()
            except Exception:
                pass
            self._serial = None
            self._running = False
            debug_print("Serial reader stopped")
            self.root.after(0, lambda: self.connect_btn.config(text="Connect", bg="#2a7a2a"))

    def _handle_frame_line(self, payload, frame_count, t0):
        self._last_frame_ok = False
        try:
            jpg_bytes = base64.b64decode(payload, validate=False)
            img = Image.open(io.BytesIO(jpg_bytes))
            img.load()
            if not self._saved_debug_frame:
                debug_path = os.path.join(os.getcwd(), "pc_usb_first_frame.jpg")
                img.save(debug_path, format="JPEG")
                self._saved_debug_frame = True
                debug_print(f"Saved first decoded frame: {debug_path}")
            img = img.resize(DISPLAY_SIZE, Image.LANCZOS)
            elapsed = time.time() - t0
            fps = (frame_count + 1) / elapsed if elapsed > 0 else 0
            self._decode_errors = 0
            self._frames_seen += 1
            self._last_frame_ok = True
            if DEBUG_VERBOSE_FRAMES:
                debug_print(f"Frame decoded ok size={img.size} frames_seen={self._frames_seen}")
            self.root.after(0, self._update_frame, img.copy(), fps)
        except Exception as e:
            self._last_decode_error = str(e)
            self._decode_errors += 1
            debug_print(f"Frame decode failed count={self._decode_errors} payload_len={len(payload)} error={e}")
            if self._decode_errors % 10 == 1:
                self.root.after(
                    0,
                    self.set_status,
                    f"Receiving frames, retrying decode... {self._last_decode_error}",
                    "dark orange",
                )

    def _handle_status_line(self, msg):
        if msg == "READY":
            self.root.after(
                0, self.set_status, "Board ready - waiting for frames...", "navy"
            )
        elif msg == "STREAMING":
            self.root.after(0, self.set_status, f"Streaming signal received ({self._line_count} lines)", "green")
        elif msg.startswith("ERR:"):
            self.root.after(0, self.set_status, f"Board error: {msg[4:]}", "red")
        elif msg.startswith("FRAME:"):
            self.root.after(0, self.set_status, f"Board sent {msg[6:]} frames; waiting for decodable JPEG", "dark orange")

    def _update_frame(self, img, fps):
        tk_img = ImageTk.PhotoImage(img)
        self._tk_img = tk_img
        self.canvas.config(
            image=tk_img,
            width=DISPLAY_SIZE[0],
            height=DISPLAY_SIZE[1],
        )
        self.fps_var.set(f"{fps:.1f} fps")
        self.set_status(
            f"Streaming ({self._frames_seen} frames, {self._line_count} lines)",
            "green",
        )

    def set_status(self, msg, color="navy"):
        self.status_var.set(msg)
        self._status_color = color

    def on_close(self):
        self._running = False
        debug_print("Window close requested")
        try:
            if self._serial:
                self._serial.close()
        except Exception:
            pass
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    app = UsbCameraApp(root)
    root.mainloop()