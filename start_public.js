const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const ASSETS_DIR = path.join(ROOT_DIR, 'assets', 'blockly');

function updateFiles(newUrl) {
    console.log(`\n=======================================================`);
    console.log(`[+] Found new Cloudflare URL: ${newUrl}`);
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

function main() {
    console.log(`[*] Starting Cloudflared Tunnel on port 5001...`);
    
    // Start cloudflared process
    // We don't use stdio: inherit because we need to parse the output to find the URL
    const tunnelProcess = spawn('npx --yes cloudflared tunnel --url http://localhost:5001', {
        shell: true
    });

    let urlFound = false;
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    // Cloudflared typically logs everything to stderr
    tunnelProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Print output so user can see it
        process.stdout.write(output);

        if (!urlFound) {
            const match = output.match(urlRegex);
            if (match) {
                const newUrl = match[0];
                updateFiles(newUrl);
                urlFound = true;
                console.log(`[*] Cloudflare tunnel is running in the background. Press Ctrl+C to stop it.`);
            }
        }
    });

    tunnelProcess.stdout.on('data', (data) => {
        const output = data.toString();
        process.stdout.write(output);

        if (!urlFound) {
            const match = output.match(urlRegex);
            if (match) {
                const newUrl = match[0];
                updateFiles(newUrl);
                urlFound = true;
                console.log(`[*] Cloudflare tunnel is running in the background. Press Ctrl+C to stop it.`);
            }
        }
    });

    tunnelProcess.on('close', (code) => {
        console.log(`[-] Tunnel closed with code ${code}`);
        process.exit(code);
    });

    process.on('SIGINT', () => {
        console.log(`\n[*] Stopping script...`);
        tunnelProcess.kill();
        process.exit(0);
    });
}

main();
