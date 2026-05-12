import urequests
import os
import time

# Mock KPU / NN functions to represent nncase bindings in Kendryte API
class KPU:
    def __init__(self):
        pass
    def load_kmodel(self, path):
        print(f"Loading .kmodel from {path}")
        return True
    def forward(self, img):
        # returns dummy bounding boxes
        return [{"class": 1, "score": 0.95, "x": 10, "y": 20, "w": 100, "h": 200}]

BACKEND_URL = "http://192.168.1.100:8000" # Update with FastAPI server IP
MODEL_PATH = "/sharefs/model.kmodel"

def download_model():
    print(f"Attempting to download model from {BACKEND_URL}/download_model")
    try:
        response = urequests.get(f"{BACKEND_URL}/download_model")
        if response.status_code == 200:
            with open(MODEL_PATH, "wb") as f:
                f.write(response.content)
            print("Successfully downloaded new model to K230.")
            return True
        else:
            print(f"Model not found on server (status {response.status_code}).")
            return False
    except Exception as e:
        print(f"Error downloading model: {e}")
        return False

def run_inference():
    if not os.path.exists(MODEL_PATH):
        print("No model found. Aborting inference.")
        return

    kpu = KPU()
    kpu.load_kmodel(MODEL_PATH)

    print("Starting camera / inference loop...")
    # Loop over camera pseudo-code
    for _ in range(5):
        # img = camera.read()
        print("Capturing frame...")
        results = kpu.forward("dummy_img")
        print(f"Detected: {results}")
        time.sleep(1)

if __name__ == "__main__":
    downloaded = download_model()
    if downloaded:
        run_inference()
