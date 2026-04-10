import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SubmissionAICheck } from '../interface';

export interface SubmissionAICheckInput {
    domainId: string;
    pid: number;
    uid: number;
    lang: string;
    code?: string;
    hasUpload?: boolean;
}

interface ExternalAICheckPayload {
    aiCheck?: Partial<SubmissionAICheck>;
    isAI?: boolean;
    score?: number | null;
    threshold?: number | null;
    confidence?: number | null;
    provider?: string;
    message?: string;
    checkedAt?: string | Date;
}

type SubmissionAICheckProvider = 'external' | 'kaggle' | 'local';

interface KaggleAICheckConfig {
    cliCommand: string;
    kernelId: string;
    kernelTitle: string;
    datasetSource: string;
    atcProjectDir: string;
    timeoutMs: number;
    pollIntervalMs: number;
    pushTimeoutMs: number;
    statusTimeoutMs: number;
    outputTimeoutMs: number;
    workdirRoot: string;
    keepWorkdir: boolean;
    resultFilename: string;
    detectorMethod: 'entropy' | 'mean_log_likelihood' | 'log_rank' | 'lrr';
    baseModelName: string;
    inferTask: boolean;
    promptStyle: string;
    threshold: number;
    minNonEmptyLines: number;
    minNonWhitespaceChars: number;
    patternWeightMapping: Record<string, number>;
    providerName: string;
}

interface CommandOutput {
    stdout: string;
    stderr: string;
    exitCode?: number;
}

const EXTERNAL_PROVIDER = 'external-ai-check';
const KAGGLE_PROVIDER = 'kaggle-atc';
const DEFAULT_AI_CHECK_TIMEOUT_MS = 120000;
const DEFAULT_KAGGLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KAGGLE_POLL_INTERVAL_MS = 15000;
const DEFAULT_KAGGLE_PUSH_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_KAGGLE_STATUS_TIMEOUT_MS = 60000;
const DEFAULT_KAGGLE_OUTPUT_TIMEOUT_MS = 2 * 60 * 1000;

let kaggleQueue: Promise<void> = Promise.resolve();

function getExternalCheckTimeoutMs() {
    const timeoutMs = Number(process.env.HYDRO_SUBMISSION_AI_TIMEOUT_MS);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_AI_CHECK_TIMEOUT_MS;
}

function getPositiveEnvNumber(name: string, fallback: number) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanEnv(name: string, fallback: boolean) {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return fallback;
}

function parsePatternWeightMapping(patternWeightMappingStr: string) {
    const value = patternWeightMappingStr.trim();
    if (!value || value.toLowerCase() === 'none') return {};
    return Object.fromEntries(value.split(',').map((entry) => {
        const [pattern, rawWeight] = entry.split(':').map((part) => part.trim());
        const weight = Number(rawWeight);
        if (!pattern || !Number.isFinite(weight)) {
            throw new Error(`Invalid HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS entry: ${entry}`);
        }
        return [pattern, weight];
    }));
}

function mapSubmissionLanguageToATCLanguage(lang: string) {
    const normalized = lang.trim().toLowerCase();
    if (normalized.startsWith('py') || normalized.includes('python')) return 'python';
    if (normalized.startsWith('java')) return 'java';
    if (normalized.startsWith('cc') || normalized.startsWith('cpp') || normalized.includes('c++')) return 'cpp';
    return normalized;
}

function resolveSubmissionAICheckProvider(): SubmissionAICheckProvider {
    const explicit = process.env.HYDRO_SUBMISSION_AI_PROVIDER?.trim().toLowerCase();
    if (explicit === 'external') return 'external';
    if (explicit === 'kaggle') return 'kaggle';
    if (explicit === 'local' || explicit === 'mock') return 'local';
    if (process.env.HYDRO_SUBMISSION_AI_API_URL?.trim()) return 'external';
    if (process.env.HYDRO_KAGGLE_KERNEL_ID?.trim()) return 'kaggle';
    return 'local';
}

function getKaggleKernelTitle(kernelId: string) {
    const explicitTitle = process.env.HYDRO_KAGGLE_KERNEL_TITLE?.trim();
    if (explicitTitle) return explicitTitle;
    const slug = kernelId.split('/').slice(-1)[0] || 'hydro-ai-check';
    return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getKaggleConfig(): KaggleAICheckConfig {
    const kernelId = process.env.HYDRO_KAGGLE_KERNEL_ID?.trim();
    const datasetSource = process.env.HYDRO_KAGGLE_ATC_DATASET_SOURCE?.trim();
    if (!kernelId) {
        throw new Error('Missing HYDRO_KAGGLE_KERNEL_ID for the Kaggle AI check provider.');
    }
    if (!datasetSource) {
        throw new Error('Missing HYDRO_KAGGLE_ATC_DATASET_SOURCE for the Kaggle AI check provider.');
    }
    const rawMethod = process.env.HYDRO_KAGGLE_ATC_METHOD?.trim() || 'entropy';
    if (!['entropy', 'mean_log_likelihood', 'log_rank', 'lrr'].includes(rawMethod)) {
        throw new Error(`Unsupported HYDRO_KAGGLE_ATC_METHOD: ${rawMethod}`);
    }
    const threshold = Number(process.env.HYDRO_KAGGLE_ATC_THRESHOLD ?? '-0.18');
    if (!Number.isFinite(threshold)) {
        throw new Error('HYDRO_KAGGLE_ATC_THRESHOLD must be a valid number.');
    }
    return {
        cliCommand: process.env.HYDRO_KAGGLE_CLI?.trim() || 'kaggle',
        kernelId,
        kernelTitle: getKaggleKernelTitle(kernelId),
        datasetSource,
        atcProjectDir: process.env.HYDRO_KAGGLE_ATC_PROJECT_DIR?.trim() || 'ATC-main',
        timeoutMs: getPositiveEnvNumber('HYDRO_KAGGLE_TIMEOUT_MS', DEFAULT_KAGGLE_TIMEOUT_MS),
        pollIntervalMs: getPositiveEnvNumber('HYDRO_KAGGLE_POLL_INTERVAL_MS', DEFAULT_KAGGLE_POLL_INTERVAL_MS),
        pushTimeoutMs: getPositiveEnvNumber('HYDRO_KAGGLE_PUSH_TIMEOUT_MS', DEFAULT_KAGGLE_PUSH_TIMEOUT_MS),
        statusTimeoutMs: getPositiveEnvNumber('HYDRO_KAGGLE_STATUS_TIMEOUT_MS', DEFAULT_KAGGLE_STATUS_TIMEOUT_MS),
        outputTimeoutMs: getPositiveEnvNumber('HYDRO_KAGGLE_OUTPUT_TIMEOUT_MS', DEFAULT_KAGGLE_OUTPUT_TIMEOUT_MS),
        workdirRoot: process.env.HYDRO_KAGGLE_WORKDIR?.trim() || path.join(os.tmpdir(), 'hydro-kaggle-ai-check'),
        keepWorkdir: parseBooleanEnv('HYDRO_KAGGLE_KEEP_WORKDIR', false),
        resultFilename: process.env.HYDRO_KAGGLE_RESULT_FILENAME?.trim() || 'ai-check-result.json',
        detectorMethod: rawMethod as KaggleAICheckConfig['detectorMethod'],
        baseModelName: process.env.HYDRO_KAGGLE_ATC_BASE_MODEL?.trim() || 'google/codegemma-7b-it',
        inferTask: parseBooleanEnv('HYDRO_KAGGLE_ATC_INFER_TASK', true),
        promptStyle: process.env.HYDRO_KAGGLE_ATC_PROMPT_STYLE?.trim() || 'regular',
        threshold,
        minNonEmptyLines: getPositiveEnvNumber('HYDRO_KAGGLE_ATC_MIN_NONEMPTY_LINES', 8),
        minNonWhitespaceChars: getPositiveEnvNumber('HYDRO_KAGGLE_ATC_MIN_NONWHITESPACE_CHARS', 120),
        patternWeightMapping: parsePatternWeightMapping(
            process.env.HYDRO_KAGGLE_ATC_PATTERN_WEIGHTS?.trim() || 'comments:0,docstrings:0',
        ),
        providerName: KAGGLE_PROVIDER,
    };
}

function getCodeComplexityStats(code: string) {
    const nonEmptyLines = code
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .length;
    const nonWhitespaceChars = code.replace(/\s+/g, '').length;
    return { nonEmptyLines, nonWhitespaceChars };
}

function createSkippedShortCodeAICheck(
    provider: string,
    nonEmptyLines: number,
    nonWhitespaceChars: number,
    minNonEmptyLines: number,
    minNonWhitespaceChars: number,
): SubmissionAICheck {
    return {
        state: 'skipped',
        isAI: null,
        score: null,
        confidence: null,
        provider,
        message: `Skipped AI check because the submission is too short (${nonEmptyLines} non-empty lines, ${nonWhitespaceChars} non-whitespace chars; minimum ${minNonEmptyLines} lines or ${minNonWhitespaceChars} chars).`,
        checkedAt: new Date(),
    };
}

function computeAICheckConfidence(score: number | null | undefined, threshold: number | null | undefined) {
    if (!Number.isFinite(score)) return null;
    const margin = Number.isFinite(threshold) ? score - threshold : score;
    const normalized = 1 / (1 + Math.exp(-margin / 0.05));
    return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

function normalizeAICheck(payload: Partial<SubmissionAICheck>, fallbackProvider: string): SubmissionAICheck {
    const checkedAt = payload.checkedAt ? new Date(payload.checkedAt) : new Date();
    const score = Number.isFinite(payload.score) ? payload.score : null;
    const threshold = Number.isFinite(payload.threshold) ? payload.threshold : null;
    return {
        state: payload.state === 'pending' || payload.state === 'checked' || payload.state === 'skipped' || payload.state === 'error'
            ? payload.state
            : 'checked',
        isAI: typeof payload.isAI === 'boolean' ? payload.isAI : null,
        score,
        threshold,
        confidence: Number.isFinite(payload.confidence) ? payload.confidence : computeAICheckConfidence(score, threshold),
        provider: payload.provider || fallbackProvider,
        message: payload.message || '',
        checkedAt: Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt,
    };
}

export function createPendingSubmissionAICheck(
    provider = 'async-ai-check',
    message = 'Pending',
): SubmissionAICheck {
    return {
        state: 'pending',
        isAI: null,
        score: null,
        confidence: null,
        provider,
        message,
        checkedAt: new Date(),
    };
}

export function createErrorSubmissionAICheck(
    message: string,
    provider = EXTERNAL_PROVIDER,
): SubmissionAICheck {
    return {
        state: 'error',
        isAI: null,
        score: null,
        confidence: null,
        provider,
        message,
        checkedAt: new Date(),
    };
}

export function shouldDeferSubmissionAICheck() {
    return resolveSubmissionAICheckProvider() === 'kaggle';
}

export function createConfiguredPendingSubmissionAICheck() {
    if (resolveSubmissionAICheckProvider() === 'kaggle') {
        return createPendingSubmissionAICheck(
            KAGGLE_PROVIDER,
            'Pending',
        );
    }
    return createPendingSubmissionAICheck();
}

function localFallbackCheck(input: SubmissionAICheckInput): SubmissionAICheck {
    if (!input.code?.trim()) {
        return {
            state: 'skipped',
            isAI: null,
            score: null,
            confidence: null,
            provider: 'mock-ai-check',
            message: input.hasUpload
                ? 'Skipped placeholder AI check because the submission was uploaded as a file.'
                : 'Skipped placeholder AI check because there is no inline source code to inspect.',
            checkedAt: new Date(),
        };
    }

    const normalized = input.code.toLowerCase();
    const markers = [
        'generated by ai',
        'generated with ai',
        'generated by chatgpt',
        'chatgpt',
        'copilot',
        'openai',
        'claude',
        'gemini',
    ];
    const matched = markers.some((marker) => normalized.includes(marker));

    return {
        state: 'checked',
        isAI: matched,
        score: matched ? 0.92 : 0.08,
        confidence: matched ? 92 : 8,
        provider: 'mock-ai-check',
        message: matched
            ? 'Flagged by placeholder rule because the source contains an AI-related marker.'
            : 'Placeholder AI check did not flag this submission. Configure HYDRO_SUBMISSION_AI_API_URL or HYDRO_SUBMISSION_AI_PROVIDER=kaggle to use a real provider.',
        checkedAt: new Date(),
    };
}

async function externalCheck(input: SubmissionAICheckInput, apiUrl: string): Promise<SubmissionAICheck> {
    const timeoutMs = getExternalCheckTimeoutMs();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(input),
            signal: controller.signal,
        });
        const text = await response.text();
        let payload: ExternalAICheckPayload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = {};
        }
        if (!response.ok) {
            return {
                state: 'error',
                isAI: null,
                score: null,
                provider: EXTERNAL_PROVIDER,
                message: payload?.message || `AI check API returned HTTP ${response.status}.`,
                checkedAt: new Date(),
            };
        }
        if (payload.aiCheck && typeof payload.aiCheck === 'object') {
            return normalizeAICheck(payload.aiCheck, EXTERNAL_PROVIDER);
        }
        if (typeof payload.isAI === 'boolean') {
            return normalizeAICheck({
                state: 'checked',
                isAI: payload.isAI,
                score: payload.score,
                threshold: payload.threshold,
                confidence: payload.confidence,
                provider: payload.provider,
                message: payload.message,
                checkedAt: payload.checkedAt ? new Date(payload.checkedAt) : undefined,
            }, EXTERNAL_PROVIDER);
        }
        return {
            state: 'error',
            isAI: null,
            score: null,
            provider: EXTERNAL_PROVIDER,
            message: 'AI check API returned an invalid response shape.',
            checkedAt: new Date(),
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return createErrorSubmissionAICheck(`AI check API timed out after ${timeoutMs} ms.`);
        }
        return createErrorSubmissionAICheck(
            error instanceof Error ? error.message : 'Failed to call AI check API.',
        );
    } finally {
        clearTimeout(timeoutHandle);
    }
}

async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<CommandOutput> {
    return await new Promise((resolve, reject) => {
        const childEnv = {
            ...process.env,
            PYTHONUTF8: '1',
            PYTHONIOENCODING: 'utf-8',
        };
        const child = spawn(command, args, {
            cwd,
            env: childEnv,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let finished = false;
        const timeoutHandle = timeoutMs > 0
            ? setTimeout(() => {
                if (finished) return;
                finished = true;
                child.kill();
                reject(new Error(`Command timed out after ${timeoutMs} ms: ${command} ${args.join(' ')}`));
            }, timeoutMs)
            : null;

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => {
            if (finished) return;
            finished = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reject(error);
        });
        child.on('close', (code) => {
            if (finished) return;
            finished = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            const details = stderr.trim() || stdout.trim() || `exit code ${code}`;
            reject(new Error(`Command failed: ${command} ${args.join(' ')} (${details})`));
        });
    });
}

async function runCommandAllowFailure(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<CommandOutput> {
    try {
        return await runCommand(command, args, timeoutMs, cwd);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            stdout: '',
            stderr: message,
            exitCode: 1,
        };
    }
}

async function withKaggleQueue<T>(task: () => Promise<T>) {
    const previous = kaggleQueue.catch(() => undefined);
    let release!: () => void;
    kaggleQueue = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await task();
    } finally {
        release();
    }
}

function parseKaggleKernelStatus(stdout: string, stderr: string) {
    const text = `${stdout}\n${stderr}`.toLowerCase();
    if (text.includes('complete')) return 'complete';
    if (text.includes('error') || text.includes('failed') || text.includes('cancelled')) return 'error';
    if (text.includes('queued') || text.includes('running') || text.includes('pending') || text.includes('starting')) {
        return 'running';
    }
    return 'unknown';
}

async function waitForKaggleKernel(config: KaggleAICheckConfig) {
    const startedAt = Date.now();
    let lastStatusOutput = '';
    while (Date.now() - startedAt <= config.timeoutMs) {
        const { stdout, stderr, exitCode } = await runCommandAllowFailure(
            config.cliCommand,
            ['kernels', 'status', config.kernelId],
            config.statusTimeoutMs,
        );
        lastStatusOutput = `${stdout}\n${stderr}`.trim();
        const lowerStatusOutput = lastStatusOutput.toLowerCase();
        if (exitCode && (lowerStatusOutput.includes('404')
            || lowerStatusOutput.includes('not found')
            || lowerStatusOutput.includes('getkernelsessionstatus'))) {
            await sleep(config.pollIntervalMs);
            continue;
        }
        const status = parseKaggleKernelStatus(stdout, stderr);
        if (status === 'complete') return;
        if (status === 'error') {
            throw new Error(`Kaggle kernel ${config.kernelId} failed. ${lastStatusOutput}`);
        }
        await sleep(config.pollIntervalMs);
    }
    throw new Error(`Kaggle kernel ${config.kernelId} did not finish within ${config.timeoutMs} ms. Last status: ${lastStatusOutput}`);
}

function createKaggleNotebook(input: SubmissionAICheckInput, config: KaggleAICheckConfig) {
    const payload = JSON.stringify({
        code_b64: Buffer.from(input.code || '', 'utf-8').toString('base64'),
        language: mapSubmissionLanguageToATCLanguage(input.lang),
        method: config.detectorMethod,
        base_model_name: config.baseModelName,
        infer_task: config.inferTask,
        prompt_style: config.promptStyle,
        threshold: config.threshold,
        pattern_weight_mapping: config.patternWeightMapping,
        dataset_source: config.datasetSource,
        atc_project_dir: config.atcProjectDir,
        provider_name: config.providerName,
        result_filename: config.resultFilename,
    });
    const mainCodeLines = [
        `payload = json.loads(${JSON.stringify(payload)})`,
        "code = base64.b64decode(payload['code_b64']).decode('utf-8')",
        '',
        "os.environ.setdefault('HF_HUB_ETAG_TIMEOUT', '120')",
        "os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '120')",
        "project_dir = payload['atc_project_dir']",
        "dataset_owner, dataset_slug = (payload['dataset_source'].split('/', 1) + [''])[:2]",
        "search_patterns = ['/kaggle/input', '/kaggle/input/*', '/kaggle/input/*/*', '/kaggle/input/*/*/*', '/kaggle/input/*/*/*/*']",
        'candidate_dirs = []',
        'seen = set()',
        'for pattern in search_patterns:',
        '    for candidate in glob.glob(pattern):',
        '        candidate_path = Path(candidate)',
        '        if not candidate_path.is_dir():',
        '            continue',
        '        candidate_path = candidate_path.resolve()',
        '        key = str(candidate_path)',
        '        if key in seen:',
        '            continue',
        '        seen.add(key)',
        '        if (candidate_path / "requirements.txt").exists() and (candidate_path / "detection" / "run.py").exists():',
        '            candidate_dirs.append(candidate_path)',
        'if not candidate_dirs:',
        '    visible_inputs = [str(Path(path).resolve()) for path in glob.glob("/kaggle/input/*")]',
        '    raise RuntimeError(f"Could not locate an ATC project under /kaggle/input. dataset_source={payload[\'dataset_source\']!r}, visible_inputs={visible_inputs}")',
        'def candidate_score(candidate_path):',
        '    candidate_str = str(candidate_path)',
        '    score = 0',
        '    if project_dir and candidate_path.name == project_dir:',
        '        score += 8',
        '    if dataset_slug and dataset_slug in candidate_str:',
        '        score += 4',
        '    if dataset_owner and dataset_owner in candidate_str:',
        '        score += 2',
        '    if "/datasets/" in candidate_str:',
        '        score += 1',
        '    return (-score, len(candidate_str), candidate_str)',
        'src = str(sorted(candidate_dirs, key=candidate_score)[0])',
        "dst = f'/kaggle/working/{project_dir}'",
        'if os.path.exists(dst):',
        '    shutil.rmtree(dst)',
        'shutil.copytree(src, dst)',
        "detector_file = Path(dst) / 'detection' / 'detector.py'",
        "detector_source = detector_file.read_text(encoding='utf-8')",
        "patched_detector_source = detector_source.replace('device_map=\"cuda\"', 'device_map=\"auto\"')",
        'if patched_detector_source != detector_source:',
        "    detector_file.write_text(patched_detector_source, encoding='utf-8')",
        "subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '-r', os.path.join(dst, 'requirements.txt')], check=True)",
        "subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'astor'], check=True)",
        'os.chdir(dst)',
        '',
        'from detection.detector import EntropyDetector, MeanLogLikelihoodDetector, LogRankDetector, LRRDetector',
        '',
        'detectors = {',
        "    'entropy': EntropyDetector,",
        "    'mean_log_likelihood': MeanLogLikelihoodDetector,",
        "    'log_rank': LogRankDetector,",
        "    'lrr': LRRDetector,",
        '}',
        "detector_cls = detectors[payload['method']]",
        "infer_task_cfg = SimpleNamespace(debug=False, debug_file='debug_documentation.txt', use_cache=False, prompt_style=payload['prompt_style'])",
        "detector = detector_cls(model_name=payload['base_model_name'], pattern_weight_mapping=payload['pattern_weight_mapping'], infer_task_cfg=infer_task_cfg, language=payload['language'])",
        'inferred_task = None',
        "if payload['infer_task']:",
        '    score, inferred_task = detector.compute_score_infer_task(code)',
        'else:',
        '    score = detector.compute_score_without_task(code)',
        "threshold = float(payload['threshold'])",
        'is_ai = bool(score >= threshold)',
        "comparison = '>=' if is_ai else '<'",
        "message = f'Kaggle ATC score {score:.6f} {comparison} threshold {threshold:.6f}.'",
        'confidence = max(0, min(100, round(100 / (1 + math.exp(-((score - threshold) / 0.05))))))',
        'result = {',
        "    'aiCheck': {",
        "        'state': 'checked',",
        "        'isAI': is_ai,",
        "        'score': float(score),",
        "        'threshold': threshold,",
        "        'confidence': confidence,",
        "        'provider': payload['provider_name'],",
        "        'message': message,",
        "        'checkedAt': datetime.now(timezone.utc).isoformat(),",
        '    },',
        "    'score': float(score),",
        "    'threshold': threshold,",
        '}',
        'if inferred_task is not None:',
        "    result['inferredTask'] = inferred_task",
        'result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding=\'utf-8\')',
        "print(json.dumps(result, ensure_ascii=False))",
    ];
    const codeLines = [
        'import base64',
        'import glob',
        'import json',
        'import math',
        'import os',
        'import shutil',
        'import subprocess',
        'import sys',
        'import traceback',
        'from datetime import datetime, timezone',
        'from pathlib import Path',
        'from types import SimpleNamespace',
        '',
        `payload = json.loads(${JSON.stringify(payload)})`,
        "result_path = Path(f\"/kaggle/working/{payload['result_filename']}\")",
        'try:',
        ...mainCodeLines.map((line) => (line.length > 0 ? `    ${line}` : '')),
        'except Exception as exc:',
        "    error_result = {",
        "        'aiCheck': {",
        "            'state': 'error',",
        "            'isAI': None,",
        "            'score': None,",
        "            'provider': payload['provider_name'],",
        "            'message': f'{type(exc).__name__}: {exc}',",
        "            'checkedAt': datetime.now(timezone.utc).isoformat(),",
        '        },',
        "        'traceback': traceback.format_exc(),",
        '    }',
        "    result_path.write_text(json.dumps(error_result, ensure_ascii=False, indent=2), encoding='utf-8')",
        "    print(json.dumps(error_result, ensure_ascii=False))",
    ];
    return JSON.stringify({
        cells: [
            {
                cell_type: 'markdown',
                metadata: {},
                source: [
                    '# Hydro Kaggle ATC Job\n',
                    'This notebook is generated automatically by Hydro to score a single submission with ATC.\n',
                ],
            },
            {
                cell_type: 'code',
                execution_count: null,
                metadata: {},
                outputs: [],
                source: codeLines.map((line) => `${line}\n`),
            },
        ],
        metadata: {
            kernelspec: {
                display_name: 'Python 3',
                language: 'python',
                name: 'python3',
            },
            language_info: {
                name: 'python',
            },
            kaggle: {
                accelerator: 'gpu',
                internet: true,
            },
        },
        nbformat: 4,
        nbformat_minor: 5,
    }, null, 2);
}

function createKaggleKernelMetadata(config: KaggleAICheckConfig, notebookFilename: string) {
    return JSON.stringify({
        id: config.kernelId,
        title: config.kernelTitle,
        code_file: notebookFilename,
        language: 'python',
        kernel_type: 'notebook',
        is_private: true,
        enable_gpu: true,
        enable_internet: true,
        dataset_sources: [config.datasetSource],
        kernel_sources: [],
        competition_sources: [],
        model_sources: [],
    }, null, 2);
}

function normalizeKagglePayload(payload: ExternalAICheckPayload) {
    if (payload.aiCheck && typeof payload.aiCheck === 'object') {
        return normalizeAICheck(payload.aiCheck, KAGGLE_PROVIDER);
    }
    if (typeof payload.isAI === 'boolean') {
        return normalizeAICheck({
            state: 'checked',
            isAI: payload.isAI,
            score: payload.score,
            threshold: payload.threshold,
            confidence: payload.confidence,
            provider: payload.provider,
            message: payload.message,
            checkedAt: payload.checkedAt ? new Date(payload.checkedAt) : undefined,
        }, KAGGLE_PROVIDER);
    }
    throw new Error('Kaggle output is missing aiCheck/isAI fields.');
}

async function kaggleCheck(input: SubmissionAICheckInput): Promise<SubmissionAICheck> {
    if (!input.code?.trim()) {
        return {
            state: 'skipped',
            isAI: null,
            score: null,
            provider: KAGGLE_PROVIDER,
            message: input.hasUpload
                ? 'Skipped Kaggle ATC check because the submission was uploaded as a file and no inline source was available.'
                : 'Skipped Kaggle ATC check because there is no inline source code to inspect.',
            checkedAt: new Date(),
        };
    }
    const config = getKaggleConfig();
    const { nonEmptyLines, nonWhitespaceChars } = getCodeComplexityStats(input.code);
    if (nonEmptyLines < config.minNonEmptyLines || nonWhitespaceChars < config.minNonWhitespaceChars) {
        return createSkippedShortCodeAICheck(
            KAGGLE_PROVIDER,
            nonEmptyLines,
            nonWhitespaceChars,
            config.minNonEmptyLines,
            config.minNonWhitespaceChars,
        );
    }
    return await withKaggleQueue(async () => {
        const jobDir = path.join(config.workdirRoot, randomUUID());
        const notebookFilename = 'hydro-kaggle-ai-check.ipynb';
        const outputDir = path.join(jobDir, 'output');
        try {
            await fs.mkdir(jobDir, { recursive: true });
            await fs.writeFile(path.join(jobDir, notebookFilename), createKaggleNotebook(input, config), 'utf-8');
            await fs.writeFile(
                path.join(jobDir, 'kernel-metadata.json'),
                createKaggleKernelMetadata(config, notebookFilename),
                'utf-8',
            );

            await runCommand(config.cliCommand, ['kernels', 'push', '-p', jobDir], config.pushTimeoutMs);
            await waitForKaggleKernel(config);

            await fs.mkdir(outputDir, { recursive: true });
            await runCommand(
                config.cliCommand,
                ['kernels', 'output', config.kernelId, '-p', outputDir, '-o', '-q'],
                config.outputTimeoutMs,
            );

            const resultPath = path.join(outputDir, config.resultFilename);
            const raw = await fs.readFile(resultPath, 'utf-8');
            const payload = JSON.parse(raw) as ExternalAICheckPayload;
            return normalizeKagglePayload(payload);
        } finally {
            if (!config.keepWorkdir) {
                await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    });
}

export async function checkSubmissionForAI(input: SubmissionAICheckInput): Promise<SubmissionAICheck> {
    try {
        const provider = resolveSubmissionAICheckProvider();
        if (provider === 'external') {
            const apiUrl = process.env.HYDRO_SUBMISSION_AI_API_URL?.trim();
            if (!apiUrl) return createErrorSubmissionAICheck('Missing HYDRO_SUBMISSION_AI_API_URL.', EXTERNAL_PROVIDER);
            return await externalCheck(input, apiUrl);
        }
        if (provider === 'kaggle') {
            return await kaggleCheck(input);
        }
        return localFallbackCheck(input);
    } catch (error) {
        const provider = resolveSubmissionAICheckProvider() === 'kaggle' ? KAGGLE_PROVIDER : EXTERNAL_PROVIDER;
        return createErrorSubmissionAICheck(
            error instanceof Error ? error.message : 'Failed to run the AI check provider.',
            provider,
        );
    }
}
