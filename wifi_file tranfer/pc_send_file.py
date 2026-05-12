"""
pc_send_file.py  — runs on WINDOWS PC
1. Opens a file picker so you can choose any file
2. Sends it to the K230 board over WiFi
3. File is saved to /sdcard/ on the board

Requirements: pip install requests  (tkinter is built-in)
"""

import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import threading
import requests
import os

# ---- change this if K230 board IP is different ----
K230_IP   = '192.168.4.1'
K230_PORT = 8080
# ----------------------------------------------------

UPLOAD_URL = f'http://{K230_IP}:{K230_PORT}/upload'


class SenderApp:
    def __init__(self, root):
        self.root = root
        root.title("WiFi File Transfer → K230 SD Card")
        root.geometry("520x300")
        root.resizable(False, False)

        # Title
        tk.Label(root, text="K230 WiFi File Sender", font=("Arial", 14, "bold")).pack(pady=10)

        # Board IP
        ip_frame = tk.Frame(root)
        ip_frame.pack(pady=4)
        tk.Label(ip_frame, text="K230 IP:", width=10).pack(side=tk.LEFT)
        self.ip_var = tk.StringVar(value=K230_IP)
        tk.Entry(ip_frame, textvariable=self.ip_var, width=18).pack(side=tk.LEFT, padx=4)
        tk.Label(ip_frame, text="Port:").pack(side=tk.LEFT)
        self.port_var = tk.StringVar(value=str(K230_PORT))
        tk.Entry(ip_frame, textvariable=self.port_var, width=6).pack(side=tk.LEFT, padx=4)

        # File selection
        file_frame = tk.Frame(root)
        file_frame.pack(pady=8, padx=20, fill=tk.X)
        tk.Label(file_frame, text="File:", width=10).pack(side=tk.LEFT)
        self.file_var = tk.StringVar(value="(no file selected)")
        tk.Label(file_frame, textvariable=self.file_var, anchor='w',
                 relief=tk.SUNKEN, width=38).pack(side=tk.LEFT, padx=4)
        tk.Button(file_frame, text="Browse...", command=self.browse_file).pack(side=tk.LEFT)

        # Progress bar
        self.progress = ttk.Progressbar(root, length=460, mode='indeterminate')
        self.progress.pack(pady=8)

        # Status label
        self.status_var = tk.StringVar(value="Connect PC to  YAHBOOM-K230  WiFi, then select a file.")
        self.status_label = tk.Label(root, textvariable=self.status_var, wraplength=480,
                                     fg="navy", font=("Arial", 9))
        self.status_label.pack(pady=4)

        # Send button
        self.send_btn = tk.Button(root, text="Send to K230 SD Card",
                                  font=("Arial", 11, "bold"),
                                  bg="#e07b00", fg="white",
                                  command=self.start_send, state=tk.DISABLED)
        self.send_btn.pack(pady=8)

        self.selected_file = None

    def browse_file(self):
        path = filedialog.askopenfilename(title="Select file to send to K230")
        if path:
            self.selected_file = path
            self.file_var.set(os.path.basename(path))
            self.send_btn.config(state=tk.NORMAL)
            self.status_var.set(f"Ready to send: {os.path.basename(path)}")

    def start_send(self):
        if not self.selected_file:
            return
        self.send_btn.config(state=tk.DISABLED)
        self.progress.start(10)
        self.status_var.set("Sending...")
        t = threading.Thread(target=self.do_send, daemon=True)
        t.start()

    def do_send(self):
        try:
            ip   = self.ip_var.get().strip()
            port = self.port_var.get().strip()
            url  = f'http://{ip}:{port}/upload'

            filename = os.path.basename(self.selected_file)
            file_size = os.path.getsize(self.selected_file)

            with open(self.selected_file, 'rb') as f:
                headers = {
                    'X-Filename': filename,
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': str(file_size),
                }
                resp = requests.post(url, data=f, headers=headers, timeout=60)

            if resp.status_code == 200:
                self.set_status(f"Done!  '{filename}'  saved to K230 /sdcard/", "green")
            else:
                self.set_status(f"Board error {resp.status_code}: {resp.text}", "red")

        except requests.exceptions.ConnectionError:
            self.set_status(
                "Cannot connect.  Make sure:\n"
                "1) PC is connected to  YAHBOOM-K230  WiFi\n"
                "2) k230_receive_server.py is running on the board", "red")
        except Exception as e:
            self.set_status(f"Error: {e}", "red")
        finally:
            self.root.after(0, self._send_done)

    def set_status(self, msg, color="navy"):
        self.root.after(0, lambda m=msg, c=color: (
            self.status_var.set(m),
            self.status_label.config(fg=c)
        ))

    def _send_done(self):
        self.progress.stop()
        self.send_btn.config(state=tk.NORMAL)


if __name__ == '__main__':
    root = tk.Tk()
    app = SenderApp(root)
    root.mainloop()
