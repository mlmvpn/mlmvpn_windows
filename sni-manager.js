const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let sniProcess = null;

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar') ? __dirname.replace(/\.asar/gi, '.asar.unpacked') : __dirname;
}

class SniManager {
    constructor() {
        const exeDir = getUnpackedDir();
        this.sniDir = path.join(exeDir, 'core', 'sni-spoofer');
        this.logPath = path.join(this.sniDir, 'sni_results.json');
        this.pythonExe = path.join(exeDir, 'core', 'python', 'tools', 'python.exe');
        this.scriptPath = path.join(this.sniDir, 'check_sni.py');
    }
}

function startSniEngine(configObj, onLog) {
    stopSniEngine();
    
    const exeDir = getUnpackedDir();
    const sniDir = path.join(exeDir, 'core', 'sni-spoofer');
    const configPath = path.join(sniDir, 'config.json');
    const mainScript = path.join(sniDir, 'main.py');
    const pythonExe = path.join(exeDir, 'core', 'python', 'tools', 'python.exe');

    if (!fs.existsSync(mainScript)) {
        throw new Error('فایل main.py در موتور SNI پیدا نشد!');
    }

    if (!fs.existsSync(pythonExe)) {
        throw new Error('مفسر پایتون در مسیر core/python پیدا نشد!');
    }

    // Write config
    fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2));
    activeSniConfig = configObj;

    try {
        sniProcess = spawn(pythonExe, ['-u', 'main.py'], { 
            cwd: sniDir,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        bindSniEvents(onLog);
    } catch(e) {
        throw new Error('خطا در اجرای موتور SNI: ' + e.message);
    }

    function bindSniEvents(onLogCb) {
        if (!sniProcess) return;
        sniProcess.stdout.on('data', (data) => onLogCb(data.toString()));
        sniProcess.stderr.on('data', (data) => onLogCb(data.toString()));
        sniProcess.on('error', (err) => onLogCb(`SNI Process Error: ${err.message}`));
        sniProcess.on('close', (code) => {
            onLogCb(`SNI Spoofer exited with code ${code}`);
            sniProcess = null;
        });
    }

    return true;
}

let activeSniConfig = null;

function getActiveSniConfig() {
    if (activeSniConfig) return activeSniConfig;
    const exeDir = getUnpackedDir();
    const configPath = path.join(exeDir, 'core', 'sni-spoofer', 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (e) {}
    return null;
}

function stopSniEngine() {
    if (sniProcess) {
        // on windows python process child killing can be tricky, 
        // using taskkill to ensure it dies
        try {
            const { execSync } = require('child_process');
            execSync(`taskkill /pid ${sniProcess.pid} /T /F`, { stdio: 'ignore' });
        } catch(e) {}
        
        sniProcess = null;
        activeSniConfig = null;
    }
}

/** Is the engine process up? (getActiveSniConfig() also answers from the saved file.) */
function isSniRunning() { return !!sniProcess; }

module.exports = { startSniEngine, stopSniEngine, getActiveSniConfig, isSniRunning };
