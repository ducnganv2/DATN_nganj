const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backendHost = process.env.HYDRO_DEV_BACKEND_HOST || '127.0.0.1';
const backendPort = process.env.HYDRO_DEV_BACKEND_PORT || '2333';
const frontendPort = process.env.HYDRO_DEV_FRONTEND_PORT || '8000';
const node = process.execPath;

const children = new Set();
let shuttingDown = false;

function writePrefixed(stream, prefix, chunk) {
    const lines = chunk.toString().split(/\r?\n/);
    const trailingNewline = /\r?\n$/.test(chunk.toString());
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i] && i === lines.length - 1 && trailingNewline) continue;
        stream.write(`[${prefix}] ${lines[i]}\n`);
    }
}

function spawnProcess(name, args) {
    const child = spawn(node, args, {
        cwd: root,
        env: {
            ...process.env,
            FORCE_COLOR: '1',
        },
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    children.add(child);
    child.stdout.on('data', (chunk) => writePrefixed(process.stdout, name, chunk));
    child.stderr.on('data', (chunk) => writePrefixed(process.stderr, name, chunk));
    child.on('close', () => {
        children.delete(child);
    });
    return child;
}

function stopChildren(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) child.kill();
    setTimeout(() => process.exit(exitCode), 200);
}

async function startFrontend() {
    await new Promise((resolve, reject) => {
        const iconfont = spawnProcess('ui:iconfont', [
            path.join('packages', 'ui-default', 'build'),
            '--iconfont',
        ]);
        iconfont.on('exit', (code) => {
            if (code === 0) resolve(null);
            else reject(new Error(`Iconfont build exited with code ${code}`));
        });
    });

    const frontend = spawnProcess('ui', [
        '--trace-deprecation',
        path.join('packages', 'ui-default', 'build'),
        '--dev',
    ]);
    frontend.on('exit', (code) => {
        if (!shuttingDown) {
            console.error(`[ui] exited with code ${code}`);
            stopChildren(code || 1);
        }
    });
}

async function main() {
    const backendDisplayHost = backendHost === '0.0.0.0' ? '127.0.0.1' : backendHost;

    console.log(`Backend:  http://${backendDisplayHost}:${backendPort}`);
    console.log(`Frontend: http://localhost:${frontendPort}`);
    console.log('Ensure MongoDB is running before starting dev mode.');

    const backend = spawnProcess('api', [
        '--trace-warnings',
        '--async-stack-traces',
        '--trace-deprecation',
        path.join('packages', 'hydrooj', 'bin', 'hydrooj'),
        '--debug',
        '--watch',
        '--host',
        backendHost,
        '--port',
        backendPort,
    ]);
    backend.on('exit', (code) => {
        if (!shuttingDown) {
            console.error(`[api] exited with code ${code}`);
            stopChildren(code || 1);
        }
    });

    try {
        await startFrontend();
    } catch (error) {
        console.error(`[dev] ${error.message}`);
        stopChildren(1);
    }
}

process.on('SIGINT', () => stopChildren(0));
process.on('SIGTERM', () => stopChildren(0));

main().catch((error) => {
    console.error(`[dev] ${error.stack || error.message}`);
    stopChildren(1);
});
