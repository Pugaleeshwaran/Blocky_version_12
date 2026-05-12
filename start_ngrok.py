import os
import re
import subprocess
import sys
import time
import urllib.request
import json

# Directory containing the HTML and JS files
ASSETS_DIR = os.path.join(os.path.dirname(__file__), 'assets', 'blockly')
ROOT_DIR = os.path.dirname(__file__)

def update_files(new_url):
    print(f"\n=======================================================")
    print(f"[+] Found new Ngrok URL: {new_url}")
    print(f"[+] Injecting new URL into frontend files...")
    
    count = 0
    # Regex to match CONVERT_SERVER assignment
    url_pattern = re.compile(r"const\s+CONVERT_SERVER\s*=\s*['\"].*?['\"];")
    replacement = f"const CONVERT_SERVER = '{new_url}';"
    
    files_to_check = []
    
    # Check assets/blockly/train.html
    train_html = os.path.join(ASSETS_DIR, 'train.html')
    if os.path.exists(train_html):
        files_to_check.append(train_html)
                
    # Check TrainDeployScreen.js
    train_js = os.path.join(ROOT_DIR, 'TrainDeployScreen.js')
    if os.path.exists(train_js):
        files_to_check.append(train_js)

    for filepath in files_to_check:
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            
            if url_pattern.search(content):
                new_content = url_pattern.sub(replacement, content)
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                print(f"    -> Updated {os.path.basename(filepath)}")
                count += 1
        except Exception as e:
            print(f"[-] Error reading/writing {os.path.basename(filepath)}: {e}")
                
    print(f"[+] Successfully updated {count} files!")
    print(f"[*] You can now start 'npx expo start --tunnel'")
    print(f"=======================================================\n")

def get_ngrok_url():
    try:
        req = urllib.request.Request("http://127.0.0.1:4040/api/tunnels")
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            for tunnel in data.get('tunnels', []):
                if tunnel.get('public_url', '').startswith('https://'):
                    return tunnel['public_url']
    except Exception:
        return None
    return None

def main():
    print("[*] Starting Ngrok Tunnel on port 5001...")
    
    # Start ngrok process silently
    try:
        process = subprocess.Popen(
            ['ngrok', 'http', '5001'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    except FileNotFoundError:
        print("[-] Error: 'ngrok' command not found. Please install ngrok or add it to your PATH.")
        return

    print("[*] Waiting for Ngrok to initialize...")
    new_url = None
    # Poll for up to 10 seconds
    for _ in range(10):
        time.sleep(1)
        new_url = get_ngrok_url()
        if new_url:
            break

    if new_url:
        update_files(new_url)
        print("[*] Ngrok is running in the background. Press Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n[*] Stopping Ngrok tunnel...")
            process.terminate()
    else:
        print("[-] Failed to get Ngrok URL. Is another instance of ngrok already running?")
        process.terminate()

if __name__ == '__main__':
    main()
