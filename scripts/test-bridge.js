const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const agentApiBat = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat');
const env = Object.assign({}, process.env, {
    ANTIGRAVITY_LS_ADDRESS: 'localhost:52073',
    ANTIGRAVITY_CSRF_TOKEN: 'd6719d30-573b-4990-a4c9-ac4287b4616f'
});

try {
    const res = execSync(`"${agentApiBat}" send-message --title="[Test Bridge] Alert" "0ab6809d-3d22-4adf-aa73-678e50966f70" "Halo dari background worker test"`, {
        env,
        encoding: 'utf8'
    });
    console.log('OUTPUT:\n', res);
} catch (e) {
    console.error('ERROR:\n', e.message, e.stdout, e.stderr);
}
