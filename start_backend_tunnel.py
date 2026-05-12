import os
import re
import subprocess
import sys

# Directory containing the HTML files
ASSETS_DIR = os.path.join(os.path.dirname(__file__), 'assets', 'blockly')

def update_html_files(new_url):
    print(f"\n=======================================================")
    print(f"[+] Found new Cloudflare URL: {new_url}")
    print(f"[+] Injecting new URL into HTML files...")
    
    count = 0
    # Regex to match ANY existing trycloudflare URL or localhost:5002
    url_pattern = re.compile(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com|http://localhost:5002')
    
    if not os.path.exists(ASSETS_DIR):
        print(f"[-] Error: Could not find directory {ASSETS_DIR}")
        return

    for filename in os.listdir(ASSETS_DIR):
        if filename.endswith('.html'):
            filepath = os.path.join(ASSETS_DIR, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Check if it has a trycloudflare URL to replace
                if url_pattern.search(content):
                    new_content = url_pattern.sub(new_url, content)
                    with open(filepath, 'w', encoding='utf-8') as f:
                        f.write(new_content)
                    count += 1
            except Exception as e:
                print(f"[-] Error reading/writing {filename}: {e}")
                
    print(f"[+] Successfully updated {count} HTML files!")
    print(f"[*] You can now start 'npx expo start --tunnel'")
    print(f"=======================================================\n")

def main():
    print("[*] Starting Windows Agent on port 5002...")
    
    # Path to the virtual environment's python
    python_path = os.path.join(os.path.dirname(__file__), 'backend', 'venv', 'Scripts', 'python.exe')
    if not os.path.exists(python_path):
        print(f"[-] Error: Could not find python at {python_path}")
        print("[-] Please ensure your python virtual environment is setup correctly.")
        return

    # Start the FastAPI agent that handles USB serial and proxies to Docker
    agent_process = subprocess.Popen(
        [python_path, '-m', 'uvicorn', 'backend.windows_agent:app', '--host', '0.0.0.0', '--port', '5002'],
        shell=False,
        stdout=sys.stdout,
        stderr=sys.stderr
    )

    print("[*] Starting Cloudflare Tunnel to port 5002...")
    
    # Start cloudflared process pointing to the Windows Agent
    process = subprocess.Popen(
        ['npx', '--yes', 'cloudflared', 'tunnel', '--url', 'http://localhost:5002'],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=True
    )

    url_found = False
    url_pattern = re.compile(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com')

    # Read output line by line as it is generated
    try:
        for line in process.stdout:
            # Print the cloudflare logs so the user can still see them
            sys.stdout.write(line)
            sys.stdout.flush()
            
            # Look for the URL if we haven't found it yet
            if not url_found:
                match = url_pattern.search(line)
                if match:
                    new_url = match.group(0)
                    update_html_files(new_url)
                    url_found = True
                    
    except KeyboardInterrupt:
        print("\n[*] Stopping tunnel and Windows Agent...")
        process.terminate()
        agent_process.terminate()

if __name__ == '__main__':
    main()
