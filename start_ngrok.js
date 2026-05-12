const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const ASSETS_DIR = path.join(ROOT_DIR, 'assets', 'blockly');

function updateFiles(newUrl) {
    console.log(`\n=======================================================`);
    console.log(`[+] Found new Ngrok URL: ${newUrl}`);
    console.log(`[+] Injecting new URL into frontend files...`);

    let count = 0;
    const urlPattern = /const\s+CONVERT_SERVER\s*=\s*['"].*?['"];/g;
    const replacement = `const CONVERT_SERVER = '${newUrl}';`;

    const filesToCheck = [];

    const trainHtml = path.join(ASSETS_DIR, 'train.html');
    if (fs.existsSync(trainHtml)) filesToCheck.push(trainHtml);

    const trainJs = path.join(ROOT_DIR, 'TrainDeployScreen.js');
    if (fs.existsSync(trainJs)) filesToCheck.push(trainJs);

    for (const filepath of filesToCheck) {
        try {
            let content = fs.readFileSync(filepath, 'utf8');
            if (urlPattern.test(content)) {
                content = content.replace(urlPattern, replacement);
                fs.writeFileSync(filepath, content, 'utf8');
                console.log(`    -> Updated ${path.basename(filepath)}`);
                count++;
            }
        } catch (err) {
            console.log(`[-] Error reading/writing ${path.basename(filepath)}: ${err.message}`);
        }
    }

    console.log(`[+] Successfully updated ${count} files!`);
    console.log(`[*] You can now start 'npx expo start --tunnel'`);
    console.log(`=======================================================\n`);
}

function getNgrokUrl() {
    return new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    for (const tunnel of (parsed.tunnels || [])) {
                        if (tunnel.public_url && tunnel.public_url.startsWith('https://')) {
                            return resolve(tunnel.public_url);
                        }
                    }
                    resolve(null);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function main() {
    console.log(`[*] Starting Ngrok Tunnel on port 5001...`);
    
    // Start ngrok process and stream output so we can see if it is downloading
    const ngrokProcess = spawn('npx --yes ngrok http 5001', {
        stdio: 'inherit',
        shell: true
    });

    console.log(`[*] Waiting for Ngrok to initialize...`);
    
    let newUrl = null;
    // Wait up to 60 seconds in case npx needs to download ngrok
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        newUrl = await getNgrokUrl();
        if (newUrl) break;
    }

    if (newUrl) {
        updateFiles(newUrl);
        console.log(`[*] Ngrok is running in the background. Press Ctrl+C to stop it.`);
        
        // Keep the process alive so ngrok doesn't die
        setInterval(() => {}, 1000000);
        
        process.on('SIGINT', () => {
            console.log(`\n[*] Stopping script...`);
            ngrokProcess.kill();
            process.exit(0);
        });
    } else {
        console.log(`[-] Failed to get Ngrok URL. Make sure npx completed successfully.`);
        ngrokProcess.kill();
        process.exit(1);
    }
}

main();
