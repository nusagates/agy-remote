#!/usr/bin/env node

/**
 * toolgates-agy CLI Worker
 * Background Worker for ToolBox Remote Coding with Google Antigravity.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

// Allow local dev HTTPS certificates (e.g. *.test in Laragon)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const localHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONFIG_DIR = path.join(os.homedir(), '.toolgates-agy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch (_) {}
}

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (!loaded.server || loaded.server === 'http://localhost') {
                loaded.server = 'https://tools.nusagates.com';
            }
            return loaded;
        } catch (e) {
            console.warn('[Config] Failed to parse config file:', e.message);
        }
    }
    return {
        server: 'https://tools.nusagates.com',
        token: '',
        pollInterval: 5000,
        projects: {
            toolbox: 'C:\\laragon\\www\\toolbox',
            auresys: 'C:\\laragon\\www\\auresys',
        },
    };
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
        console.error('[Config] Failed to save config:', e.message);
    }
}

function parseArgs(args) {
    const parsed = {
        command: 'listen',
        params: {},
    };

    for (const arg of args) {
        if (arg === 'listen' || arg === 'status' || arg === 'config' || arg === 'help') {
            parsed.command = arg;
        } else if (arg.startsWith('--')) {
            const [key, ...vals] = arg.slice(2).split('=');
            parsed.params[key] = vals.join('=') || true;
        }
    }

    return parsed;
}

function requestHttp(urlStr, options = {}, postData = null) {
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(urlStr);
            const client = urlObj.protocol === 'https:' ? https : http;

            const reqOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                rejectUnauthorized: false,
                agent: urlObj.protocol === 'https:' ? localHttpsAgent : undefined,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'toolgates-agy/1.0',
                    ...(options.headers || {}),
                },
                timeout: 15000,
            };

            if (postData) {
                const bodyStr = typeof postData === 'string' ? postData : JSON.stringify(postData);
                reqOptions.headers['Content-Type'] = 'application/json';
                reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
            }

            const req = client.request(reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(data);
                    } catch (_) {
                        json = { raw: data };
                    }

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${json?.error || json?.message || data}`));
                    }
                });
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out.'));
            });

            if (postData) {
                req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
            }

            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

// Resolve directory for a project key
function resolveProjectDir(projectKey, config) {
    if (config.projects && config.projects[projectKey]) {
        const customPath = config.projects[projectKey];
        if (fs.existsSync(customPath)) {
            return customPath;
        }
    }

    // Default Laragon check: C:\laragon\www\<projectKey>
    const laragonPath = path.join('C:\\laragon\\www', projectKey);
    if (fs.existsSync(laragonPath)) {
        return laragonPath;
    }

    // Default Linux VPS check: /var/www/<projectKey>
    const linuxPath = path.join('/var/www', projectKey);
    if (fs.existsSync(linuxPath)) {
        return linuxPath;
    }

    // Fallback: Current Working Directory
    return process.cwd();
}

function getGitStatus(cwd) {
    try {
        const out = execSync('git status --porcelain', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        return out.split('\n').filter(Boolean).map(line => line.trim());
    } catch (_) {
        return [];
    }
}

function getActiveAntigravityConversation() {
    const convDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'conversations');
    if (!fs.existsSync(convDir)) return null;

    try {
        const files = fs.readdirSync(convDir);
        const dbFiles = files.filter(f => f.endsWith('.db'));
        if (dbFiles.length === 0) return null;

        dbFiles.sort((a, b) => {
            const statA = fs.statSync(path.join(convDir, a));
            const statB = fs.statSync(path.join(convDir, b));
            return statB.mtimeMs - statA.mtimeMs;
        });

        const activeFile = dbFiles[0];
        return path.basename(activeFile, '.db');
    } catch (_) {
        return null;
    }
}

function getAntigravityServerEnv() {
    // If environment already has variables, use them directly
    if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
        return {
            ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
            ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
        };
    }

    // Auto-detect running language_server_windows_x64 instance
    try {
        const scriptPath = path.join(__dirname, '..', 'scripts', 'detect-agy.ps1');
        let out = '';
        if (fs.existsSync(scriptPath)) {
            out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore'],
            });
        } else {
            const tmpFile = path.join(os.tmpdir(), 'detect-agy.ps1');
            const psScript = [
                `$processes = Get-CimInstance Win32_Process -Filter "Name = 'language_server_windows_x64.exe'"`,
                `foreach ($p in $processes) {`,
                `    $procId = $p.ProcessId`,
                `    $cmd = $p.CommandLine`,
                `    $token = ""`,
                `    if ($cmd -match '--csrf_token\\s+([a-f0-9\\-]+)') { $token = $matches[1] }`,
                `    $conns = Get-NetTCPConnection -OwningProcess $procId -State Listen -ErrorAction SilentlyContinue`,
                `    foreach ($c in $conns) {`,
                `        Write-Output ("INFO|" + $procId + "|" + $token + "|" + $c.LocalPort)`,
                `    }`,
                `}`,
            ].join('\r\n');
            fs.writeFileSync(tmpFile, psScript, 'utf8');
            out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore'],
            });
        }

        const lines = out.split('\n').map(l => l.trim()).filter(l => l.startsWith('INFO|'));
        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length >= 4) {
                const token = parts[2];
                const port = parts[3];
                if (token && port) {
                    return {
                        ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`,
                        ANTIGRAVITY_CSRF_TOKEN: token,
                    };
                }
            }
        }
    } catch (_) {}

    return null;
}

function findAntigravityServerExe() {
    const candidates = [
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function findAgyCli() {
    // 1. Check if `agy` is in PATH
    try {
        const whichCmd = process.platform === 'win32' ? 'where agy' : 'which agy';
        const res = execSync(whichCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        if (res) {
            const firstLine = res.split('\n')[0].trim();
            if (fs.existsSync(firstLine)) return firstLine;
        }
    } catch (_) {}

    // 2. Check common Linux and Windows paths
    const home = os.homedir();
    const commonPaths = [
        path.join(home, '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
        '/usr/bin/agy',
        path.join(home, 'bin', 'agy'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'bin', 'agy.exe'),
    ];
    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function buildPromptMessage(task, projectDir, taskSpecFile) {
    const attachmentLines = (task.attachments && task.attachments.length)
        ? `\nLampiran Gambar / Media:\n` + task.attachments.map(att => `- [${att.name}](${att.url})`).join('\n')
        : '';

    return [
        `[REMOTE CODING TASK DITERIMA]`,
        `Judul: ${task.title}`,
        `Task ID: ${task.uuid}`,
        `Project: ${task.project_key} (${projectDir})`,
        task.target_files && task.target_files.length ? `Target Files: ${task.target_files.join(', ')}` : '',
        `Task Spec: ${taskSpecFile}`,
        attachmentLines,
        '',
        `Instruksi Pengguna:`,
        task.instructions,
        '',
        `Catatan: AI Agent Antigravity WAJIB membaca instruksi pengguna di atas dan mengeksekusinya pada folder proyek ${projectDir}.`,
    ].filter(Boolean).join('\n');
}

function notifyAntigravityAgent(task, projectDir, taskSpecFile) {
    const agentApiBat = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat');
    const lsExe = findAntigravityServerExe();

    if (!lsExe && !fs.existsSync(agentApiBat)) {
        return { success: false, reason: 'Antigravity agentapi binary tidak ditemukan' };
    }

    const conversationId = getActiveAntigravityConversation();
    if (!conversationId) {
        return { success: false, reason: 'Tidak ada sesi Antigravity IDE aktif yang terdeteksi' };
    }

    const detectedEnv = getAntigravityServerEnv();
    if (!detectedEnv) {
        return { success: false, reason: 'Antigravity Language Server tidak sedang berjalan atau tidak terdeteksi' };
    }

    const promptMessage = buildPromptMessage(task, projectDir, taskSpecFile);

    try {
        const mergedEnv = Object.assign({}, process.env, detectedEnv);
        let res;

        // Panggil binary language_server_windows_x64 langsung agar argument multiline tidak terpotong oleh cmd.exe
        if (lsExe) {
            res = spawnSync(lsExe, [
                'agentapi',
                'send-message',
                `--title=[Remote Task] ${task.title}`,
                conversationId,
                promptMessage,
            ], {
                env: mergedEnv,
                encoding: 'utf8',
            });
        } else {
            res = spawnSync('powershell', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command',
                `& "${agentApiBat}" send-message --title="[Remote Task] ${task.title.replace(/"/g, '`"')}" "${conversationId}" $env:TASK_PROMPT`
            ], {
                env: Object.assign({}, mergedEnv, { TASK_PROMPT: promptMessage }),
                encoding: 'utf8',
            });
        }

        if (res.status === 0) {
            return { success: true, conversationId };
        } else {
            return { success: false, reason: res.stderr || res.stdout };
        }
    } catch (err) {
        return { success: false, reason: err.message };
    }
}

function executeWithAgyCli(agyCli, task, projectDir, taskSpecFile, promptMessage, beforeGit, serverUrl, token, baseExecutionLogs) {
    return new Promise((resolve) => {
        let executionLogs = baseExecutionLogs + `[Antigravity CLI] Menjalankan perintah agy headless di ${projectDir}...\n`;
        console.log(`[Antigravity CLI] Menjalankan agy di ${projectDir}...`);

        let stdoutData = '';
        let stderrData = '';

        const args = [
            '-p', promptMessage,
            '--dangerously-skip-permissions',
        ];

        const child = spawn(agyCli, args, {
            cwd: projectDir,
            env: process.env,
            shell: false,
        });

        child.stdout.on('data', (chunk) => {
            const str = chunk.toString();
            stdoutData += str;
            process.stdout.write(str);
        });

        child.stderr.on('data', async (chunk) => {
            const str = chunk.toString();
            stderrData += str;
            process.stderr.write(str);
            try {
                await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/progress`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                }, { log: str.slice(-200) });
            } catch (_) {}
        });

        child.on('error', async (err) => {
            console.error(`[Antigravity CLI Error] ${err.message}`);
            executionLogs += `\n[Error] ${err.message}\n`;
            try {
                await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/fail`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` },
                }, { error: err.message, log: executionLogs });
            } catch (_) {}
            resolve(false);
        });

        child.on('close', async (code) => {
            console.log(`[Antigravity CLI] Selesai dengan exit code: ${code}`);
            executionLogs += `\n[Antigravity CLI] Selesai dengan kode: ${code}\n`;

            if (code === 0) {
                const afterGit = getGitStatus(projectDir);
                const modifiedFiles = afterGit
                    .filter(item => !beforeGit.has(item))
                    .map(item => item.split(/\s+/).slice(1).join(' '))
                    .filter(filePath => !filePath.startsWith('.agents/'));

                const summaryText = stdoutData.trim() || `Tugas '${task.title}' berhasil diselesaikan oleh Antigravity CLI di ${projectDir}.`;

                try {
                    await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/complete`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` },
                    }, {
                        summary: summaryText,
                        files_modified: modifiedFiles,
                        log: executionLogs,
                    });
                    console.log(`\n[TASK DONE] Status 'completed' dikirim ke server.`);
                } catch (err) {
                    console.error(`[Complete Error] ${err.message}`);
                }
                resolve(true);
            } else {
                const errorMsg = stderrData.trim() || `Antigravity CLI keluar dengan kode error ${code}.`;
                try {
                    await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/fail`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` },
                    }, {
                        error: errorMsg,
                        log: executionLogs + '\n' + errorMsg,
                    });
                } catch (_) {}
                resolve(false);
            }
        });
    });
}

async function executeTask(task, config, serverLocalPath = null) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`\n[${timestamp}] [TASK START] [${task.project_key}] ${task.title}`);
    console.log(`Instructions: ${task.instructions.slice(0, 100)}...`);

    const serverUrl = config.server.replace(/\/+$/, '');
    const token = config.token;

    // 1. Mark task as running
    try {
        await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/start`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
        }, {
            worker_id: `${os.hostname()} (${os.platform()})`,
        });
    } catch (err) {
        console.error(`[Start Error] ${err.message}`);
    }

    // 2. Resolve project directory (prefer server configured local_path, then local mapping, then fallback)
    let projectDir = (serverLocalPath && fs.existsSync(serverLocalPath))
        ? serverLocalPath
        : resolveProjectDir(task.project_key, config);
    console.log(`Project Dir: ${projectDir}`);

    if (!fs.existsSync(projectDir)) {
        console.error(`Directory not found: ${projectDir}`);
        await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/fail`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
        }, {
            error: `Direktori proyek '${task.project_key}' tidak ditemukan di ${projectDir}.`,
        });
        return;
    }

    // Capture Git baseline snapshot BEFORE this task is executed
    const beforeGit = new Set(getGitStatus(projectDir));

    // 3. Write task specification into .agents/tasks/ of target project
    const agentsTaskDir = path.join(projectDir, '.agents', 'tasks');
    try {
        if (!fs.existsSync(agentsTaskDir)) {
            fs.mkdirSync(agentsTaskDir, { recursive: true });
        }
    } catch (_) {}

    const taskSpecFile = path.join(agentsTaskDir, `task-${task.uuid}.md`);
    const taskSpecContent = [
        `# Task: ${task.title}`,
        `**Project**: ${task.project_key}`,
        `**ID**: ${task.uuid}`,
        `**Date**: ${new Date().toISOString()}`,
        task.target_files && task.target_files.length ? `**Target Files**:\n${task.target_files.map(f => `- ${f}`).join('\n')}` : '',
        '',
        '## Instructions',
        task.instructions,
    ].filter(Boolean).join('\n');

    try {
        fs.writeFileSync(taskSpecFile, taskSpecContent, 'utf8');
        console.log(`[Task Spec] Saved to ${taskSpecFile}`);
    } catch (e) {
        console.warn(`[Warning] Could not write task spec file: ${e.message}`);
    }

    // 4. Execution Log buffer
    let executionLogs = `[Worker] Dimulai pada ${new Date().toLocaleString()}\n`;
    executionLogs += `[Workspace] ${projectDir}\n`;
    executionLogs += `[Task Spec] ${taskSpecFile}\n\n`;

    // 5. Look for target files or run commands if instructions specify tests/scripts
    if (task.target_files && task.target_files.length) {
        executionLogs += `[Target Files Verified]:\n`;
        for (const file of task.target_files) {
            const fullPath = path.join(projectDir, file);
            executionLogs += `- ${file}: ${fs.existsSync(fullPath) ? 'Ditemukan' : 'Baru / Belum ada'}\n`;
        }
    }

    // 6. Notify Antigravity IDE directly or fallback to Antigravity CLI (agy)
    console.log('[Antigravity] Mengirimkan pesan tugas ke Antigravity...');
    const agentResult = notifyAntigravityAgent(task, projectDir, taskSpecFile);
    if (!agentResult.success) {
        // Cek apakah ada Antigravity CLI (agy) yang terinstall (terutama di Linux VPS / Mac / headless)
        const agyCli = findAgyCli();
        if (agyCli) {
            console.log(`[Antigravity CLI] Terdeteksi binary agy di ${agyCli}. Menjalankan tugas secara headless...`);
            const promptMessage = buildPromptMessage(task, projectDir, taskSpecFile);
            await executeWithAgyCli(agyCli, task, projectDir, taskSpecFile, promptMessage, beforeGit, serverUrl, token, executionLogs);
            return;
        }

        console.warn(`[Antigravity] Gagal mengirim pesan: ${agentResult.reason}`);
        executionLogs += `\n[Antigravity Error] ${agentResult.reason}\n`;
        try {
            await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/fail`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
            }, {
                error: agentResult.reason,
                log: executionLogs,
            });
        } catch (_) {}
        return;
    }

    const convId = agentResult.conversationId;
    console.log(`[Antigravity] Pesan berhasil dikirim ke sesi aktif: ${convId}`);
    executionLogs += `[Antigravity IDE] Tugas diterima oleh sesi ${convId}.\nSedang dieksekusi oleh AI...\n`;

    // Kirim update log awal bahwa AI mulai bekerja
    try {
        await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/progress`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
        }, { log: `[Antigravity] AI mulai memproses tugas...\n` });
    } catch (_) {}

    // 7. Pantau proses berpikir dan pengerjaan Antigravity secara realtime
    const transcriptFile = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    let lastProcessedLine = 0;
    if (fs.existsSync(transcriptFile)) {
        try {
            const initialLines = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n');
            lastProcessedLine = initialLines.length;
        } catch (_) {}
    }

    let finalAiResponse = '';
    let latestModelContent = '';
    let isFinished = false;
    let hasSeenActivity = false;
    let lastActivityTime = Date.now();
    const maxWaitMs = 15 * 60 * 1000; // Maksimal 15 menit per tugas
    const startTime = Date.now();

    while (!isFinished && (Date.now() - startTime) < maxWaitMs) {
        await new Promise(r => setTimeout(r, 2000));

        if (!fs.existsSync(transcriptFile)) continue;

        try {
            const raw = fs.readFileSync(transcriptFile, 'utf8').trim();
            if (!raw) continue;
            const allLines = raw.split('\n');

            if (allLines.length > lastProcessedLine) {
                const newLines = allLines.slice(lastProcessedLine);
                lastProcessedLine = allLines.length;

                for (const lineStr of newLines) {
                    try {
                        const entry = JSON.parse(lineStr);
                        // Ambil proses berpikir (thinking) atau tool call
                        if (entry.type === 'PLANNER_RESPONSE' && entry.thinking) {
                            hasSeenActivity = true;
                            lastActivityTime = Date.now();
                            const snippet = entry.thinking.trim().slice(0, 300);
                            const thoughtLog = `[Berpikir] ${snippet}...\n`;
                            executionLogs += thoughtLog;
                            process.stdout.write(`\r[Antigravity] ${snippet.slice(0, 50)}...   `);
                            await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/progress`, {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${token}` },
                            }, { log: thoughtLog });
                        } else if (entry.type === 'PLANNER_RESPONSE' && Array.isArray(entry.tool_calls) && entry.tool_calls.length) {
                            hasSeenActivity = true;
                            lastActivityTime = Date.now();
                            const toolsUsed = entry.tool_calls.map(tc => tc.name).join(', ');
                            const toolLog = `[Menjalankan Aksi] ${toolsUsed}\n`;
                            executionLogs += toolLog;
                            await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/progress`, {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${token}` },
                            }, { log: toolLog });
                        }

                        if (entry.source === 'MODEL' && entry.content && entry.content.trim().length > 0) {
                            hasSeenActivity = true;
                            lastActivityTime = Date.now();
                            latestModelContent = entry.content.trim();
                        }

                        // Deteksi respon final atau giliran selesai
                        if (
                            entry.source === 'MODEL' &&
                            entry.type === 'PLANNER_RESPONSE' &&
                            entry.status === 'DONE' &&
                            (!entry.tool_calls || entry.tool_calls.length === 0)
                        ) {
                            finalAiResponse = entry.content ? entry.content.trim() : latestModelContent;
                            isFinished = true;
                        }
                    } catch (_) {}
                }
            } else if (hasSeenActivity && (Date.now() - lastActivityTime > 15000)) {
                // Inactivity threshold: AI sudah beraktivitas dan tidak ada log baru selama 15 detik (giliran selesai)
                console.log(`\n[Auto-Complete] Sesi Antigravity hening selama 15 detik setelah aktivitas, menandai selesai.`);
                finalAiResponse = finalAiResponse || latestModelContent || `Tugas '${task.title}' berhasil diselesaikan oleh Antigravity.`;
                isFinished = true;
            }
        } catch (_) {}
    }

    // 8. Tugas selesai, hitung delta modifikasi file & tandai completed
    const afterGit = getGitStatus(projectDir);
    const modifiedFiles = afterGit
        .filter(item => !beforeGit.has(item))
        .map(item => item.split(/\s+/).slice(1).join(' '))
        .filter(filePath => !filePath.startsWith('.agents/'));

    const summaryText = finalAiResponse
        ? finalAiResponse
        : `Tugas '${task.title}' berhasil diselesaikan oleh sesi Antigravity IDE di ${projectDir}.`;

    try {
        await requestHttp(`${serverUrl}/api/agent-tasks/${task.uuid}/complete`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
        }, {
            summary: summaryText,
            files_modified: modifiedFiles,
            log: executionLogs,
        });
        console.log(`\n[TASK DONE] Status 'completed' dikirim ke server.`);
    } catch (err) {
        console.error(`[Complete Error] ${err.message}`);
    }
}

function setupProjectAndPermissions(cwd, config) {
    const projectName = path.basename(cwd);
    const projectKey = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const resolvedPath = path.resolve(cwd);

    // 1. Tambahkan ke config lokal jika belum ada
    config.projects = config.projects || {};
    if (!config.projects[projectKey] || config.projects[projectKey] !== resolvedPath) {
        config.projects[projectKey] = resolvedPath;
        saveConfig(config);
    }

    // 2. Auto-accept Permission di Antigravity IDE settings:
    try {
        const agySettingsFile = path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'settings.json');
        if (fs.existsSync(agySettingsFile)) {
            const rawSettings = fs.readFileSync(agySettingsFile, 'utf8');
            const settingsObj = JSON.parse(rawSettings);
            let changed = false;
            if (settingsObj['security.workspace.trust.enabled'] !== false) {
                settingsObj['security.workspace.trust.enabled'] = false;
                changed = true;
            }
            if (settingsObj['security.workspace.trust.emptyWindow'] !== true) {
                settingsObj['security.workspace.trust.emptyWindow'] = true;
                changed = true;
            }
            if (changed) {
                fs.writeFileSync(agySettingsFile, JSON.stringify(settingsObj, null, 4), 'utf8');
                console.log(`[Auto-Permission] Workspace trust disetel ke auto-approve di Antigravity IDE.`);
            }
        }
    } catch (_) {}

    // 3. Daftarkan folder di ~/.gemini/config/projects/ dengan allowWrite: true
    try {
        const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
        if (!fs.existsSync(projectsDir)) {
            fs.mkdirSync(projectsDir, { recursive: true });
        }

        const driveLetter = resolvedPath.charAt(0).toLowerCase();
        const subPath = resolvedPath.slice(2).replace(/\\/g, '/');
        const folderUri = `file:///${driveLetter}%3A${subPath}`;

        const existingFiles = fs.readdirSync(projectsDir).filter(f => f.endsWith('.json'));
        let alreadyConfigured = false;

        for (const f of existingFiles) {
            try {
                const fPath = path.join(projectsDir, f);
                const fContent = JSON.parse(fs.readFileSync(fPath, 'utf8'));
                const res = fContent?.projectResources?.resources || [];
                for (const r of res) {
                    if (r?.gitFolder?.folderUri?.toLowerCase() === folderUri.toLowerCase()) {
                        alreadyConfigured = true;
                        if (!r.gitFolder.allowWrite) {
                            r.gitFolder.allowWrite = true;
                            fs.writeFileSync(fPath, JSON.stringify(fContent, null, 2), 'utf8');
                        }
                        break;
                    }
                }
            } catch (_) {}
            if (alreadyConfigured) break;
        }

        if (!alreadyConfigured) {
            const newUuid = crypto.randomUUID ? crypto.randomUUID() : ('proj-' + Date.now());
            const newProjectConfig = {
                id: newUuid,
                name: projectName,
                projectResources: {
                    resources: [
                        {
                            gitFolder: {
                                folderUri: folderUri,
                                defaultBranch: 'main',
                                allowWrite: true
                            }
                        }
                    ]
                }
            };
            fs.writeFileSync(path.join(projectsDir, `${newUuid}.json`), JSON.stringify(newProjectConfig, null, 2), 'utf8');
            console.log(`[Auto-Permission] Direktori terdaftar di Antigravity config dengan allowWrite: true.`);
        }
    } catch (_) {}

    // 4. Pastikan folder .agents/tasks ada
    try {
        const tasksDir = path.join(resolvedPath, '.agents', 'tasks');
        if (!fs.existsSync(tasksDir)) {
            fs.mkdirSync(tasksDir, { recursive: true });
        }
    } catch (_) {}

    return { projectName, projectKey, resolvedPath };
}

async function startListening(config) {
    const rawServer = config.server || 'https://tools.nusagates.com';
    const serverUrl = rawServer.replace(/\/tasks\/?$/i, '').replace(/\/+$/, '');
    const token = config.token;
    const interval = config.pollInterval || 5000;

    if (!token) {
        console.error('\n[Error] Token agen belum ditentukan!');
        console.error('Jalankan dengan: npx toolgates-agy listen --token=tga_YOUR_TOKEN --server=https://your-toolbox.com');
        process.exit(1);
    }

    // Otomatis daftarkan direktori terminal saat ini ke Antigravity & Web ToolBox
    const currentProj = setupProjectAndPermissions(process.cwd(), config);

    try {
        await requestHttp(`${serverUrl}/api/agent-tasks/register-project`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        }, {
            name: currentProj.projectName,
            key: currentProj.projectKey,
            path: currentProj.resolvedPath
        });
        console.log(`[Auto-Register] Proyek '${currentProj.projectName}' (${currentProj.projectKey}) aktif dan terdaftar di server.`);
    } catch (err) {
        console.warn(`[Auto-Register Info] ${err.message}`);
    }

    const workerId = config.workerId || `${os.hostname()}`;
    const workerName = config.workerName || `${os.hostname()} (${os.platform()})`;
    const platform = os.platform();

    console.log('========================================================');
    console.log('  AGY Remote: Antigravity Coding Worker                 ');
    console.log('========================================================');
    console.log(`Server   : ${serverUrl}`);
    console.log(`Projects : ${projectsList}`);
    console.log(`Interval : ${interval}ms`);
    console.log(`Worker ID: ${workerId}`);
    console.log(`Mesin    : ${workerName}`);
    console.log('\nMenunggu tugas baru dari ToolBox web... (Tekan Ctrl+C untuk berhenti)\n');

    let isBusy = false;

    const poll = async () => {
        if (isBusy) return;

        try {
            const url = `${serverUrl}/api/agent-tasks/poll?projects=${encodeURIComponent(projectsList)}&worker_id=${encodeURIComponent(workerId)}&worker_name=${encodeURIComponent(workerName)}&platform=${encodeURIComponent(platform)}`;
            const res = await requestHttp(url, {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'X-Worker-Id': workerId,
                    'X-Worker-Name': workerName,
                    'X-Worker-Platform': platform,
                },
            });

            if (res && res.task) {
                isBusy = true;
                await executeTask(res.task, config, res.local_path);
                isBusy = false;
            }
        } catch (err) {
            // Log once per failure, avoid spamming if server is temporarily unreachable
            const timeStr = new Date().toLocaleTimeString();
            process.stdout.write(`\r[${timeStr}] Polling... (${err.message.slice(0, 40)})   `);
        }
    };

    // Run first poll immediately, then loop
    await poll();
    if (config.once) {
        console.log('\n[Once Mode] Polling selesai, keluar.');
        return;
    }
    setInterval(poll, interval);
}

// Main CLI Entry
async function main() {
    const args = process.argv.slice(2);
    const parsed = parseArgs(args);
    const config = loadConfig();

    // Override with CLI flags
    if (parsed.params.server) {
        config.server = String(parsed.params.server).replace(/\/tasks\/?$/i, '').replace(/\/+$/, '');
    }
    if (parsed.params.token) config.token = parsed.params.token;
    if (parsed.params.interval) config.pollInterval = parseInt(parsed.params.interval, 10);
    if (parsed.params['worker-id']) config.workerId = String(parsed.params['worker-id']);
    if (parsed.params['worker-name']) config.workerName = String(parsed.params['worker-name']);
    
    // --once should only apply per invocation, never persisted
    const runOnce = !!parsed.params.once;
    delete config.once;

    // Save updated parameters to persistent config
    if (parsed.params.server || parsed.params.token) {
        saveConfig(config);
    }

    if (runOnce) {
        config.once = true;
    }

    switch (parsed.command) {
        case 'listen':
            await startListening(config);
            break;

        case 'status':
            console.log('Configuration:');
            console.log(JSON.stringify(config, null, 2));
            break;

        case 'config':
            if (parsed.params['add-project']) {
                const [pKey, pPath] = parsed.params['add-project'].split(':');
                if (pKey && pPath) {
                    config.projects = config.projects || {};
                    config.projects[pKey] = pPath;
                    saveConfig(config);
                    console.log(`Proyek '${pKey}' dipetakan ke '${pPath}'.`);
                }
            } else {
                console.log('Config Path:', CONFIG_FILE);
                console.log(JSON.stringify(config, null, 2));
            }
            break;

        case 'help':
        default:
            console.log(`
ToolGates-AGY: Antigravity Remote Coding Worker

Penggunaan:
  npx toolgates-agy listen [opsi]
  node bin/cli.js listen [opsi]

Opsi:
  --server=<url>       URL server ToolBox (contoh: https://toolbox.my.id)
  --token=<token>      Token agen dari halaman Remote Coding ToolBox
  --interval=<ms>      Interval polling dalam milidetik (default: 5000)
  --add-project=key:path  Petakan proyek baru (contoh: auresys:C:\\laragon\\www\\auresys)

Perintah Lain:
  toolgates-agy status   Tampilkan konfigurasi aktif
  toolgates-agy config   Lihat atau edit konfigurasi
`);
            break;
    }
}

main().catch((err) => {
    console.error('[Fatal Error]', err.message);
    process.exit(1);
});
