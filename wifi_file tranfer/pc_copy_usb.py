"""
pc_copy_usb.py  — runs on WINDOWS PC
Copies files directly to the CanMV board's 'data' drive via USB.
No WiFi needed. Board just needs to be plugged in via USB.
"""

import tkinter as tk
from tkinter import filedialog, messagebox
import shutil
import os
import string

def find_canmv_drive():
    """Scan all drives and find the one labeled 'CanMV' (data partition)."""
    import ctypes
    drives = []
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    for letter in string.ascii_uppercase:
        if bitmask & 1:
            drives.append(letter + ":\\")
        bitmask >>= 1

    for drive in drives:
        try:
            vol_buf = ctypes.create_unicode_buffer(261)
            ctypes.windll.kernel32.GetVolumeInformationW(
                drive, vol_buf, 261, None, None, None, None, 0)
            label = vol_buf.value.strip()
            # CanMV data partition is usually labeled 'data' or 'CanMV'
            if label.lower() in ('sdcard', 'data', 'canmv'):
                return drive, label
        except Exception:
            pass
    return None, None


class CopyApp:
    def __init__(self, root):
        self.root = root
        root.title("USB File Copy → K230 /data")
        root.geometry("520x280")
        root.resizable(False, False)

        tk.Label(root, text="K230 USB File Copy", font=("Arial", 14, "bold")).pack(pady=10)

        # Drive detection
        drive_frame = tk.Frame(root)
        drive_frame.pack(pady=4)
        tk.Label(drive_frame, text="CanMV Drive:").pack(side=tk.LEFT)
        self.drive_var = tk.StringVar(value="Detecting...")
        self.drive_entry = tk.Entry(drive_frame, textvariable=self.drive_var, width=10)
        self.drive_entry.pack(side=tk.LEFT, padx=4)
        tk.Button(drive_frame, text="Detect", command=self.detect_drive).pack(side=tk.LEFT)

        # File selection
        file_frame = tk.Frame(root)
        file_frame.pack(pady=8, padx=20, fill=tk.X)
        tk.Label(file_frame, text="File:", width=6).pack(side=tk.LEFT)
        self.file_var = tk.StringVar(value="(no file selected)")
        tk.Label(file_frame, textvariable=self.file_var, anchor='w',
                 relief=tk.SUNKEN, width=42).pack(side=tk.LEFT, padx=4)
        tk.Button(file_frame, text="Browse...", command=self.browse_file).pack(side=tk.LEFT)

        # Status
        self.status_var = tk.StringVar(value="Plug in USB cable, then click Detect.")
        self.status_label = tk.Label(root, textvariable=self.status_var,
                                     wraplength=480, fg="navy", font=("Arial", 9))
        self.status_label.pack(pady=6)

        # Copy button
        self.copy_btn = tk.Button(root, text="Copy to K230 /data",
                                  font=("Arial", 11, "bold"),
                                  bg="#e07b00", fg="white",
                                  command=self.do_copy, state=tk.DISABLED)
        self.copy_btn.pack(pady=8)

        self.selected_file = None
        self.drive_path = None
        self.detect_drive()

    def detect_drive(self):
        drive, label = find_canmv_drive()
        if drive:
            self.drive_path = drive
            self.drive_var.set(drive)
            self.set_status(f"Found CanMV drive at {drive}  (label: {label})", "green")
        else:
            self.drive_path = None
            self.drive_var.set("Not found")
            self.set_status("CanMV drive not found. Plug in USB and click Detect.", "red")

    def browse_file(self):
        path = filedialog.askopenfilename(title="Select file to copy to K230")
        if path:
            self.selected_file = path
            self.file_var.set(os.path.basename(path))
            if self.drive_path:
                self.copy_btn.config(state=tk.NORMAL)
            self.set_status(f"Ready: {os.path.basename(path)}", "navy")

    def do_copy(self):
        if not self.selected_file or not self.drive_path:
            return
        try:
            dest = os.path.join(self.drive_path, os.path.basename(self.selected_file))
            size_mb = os.path.getsize(self.selected_file) / (1024 * 1024)
            self.set_status(f"Copying {size_mb:.1f} MB ...", "navy")
            self.root.update()
            shutil.copy2(self.selected_file, dest)
            self.set_status(f"Done!  Saved to {dest}", "green")
        except Exception as e:
            self.set_status(f"Error: {e}", "red")

    def set_status(self, msg, color="navy"):
        self.status_var.set(msg)
        self.status_label.config(fg=color)


if __name__ == '__main__':
    root = tk.Tk()
    app = CopyApp(root)
    root.mainloop()
