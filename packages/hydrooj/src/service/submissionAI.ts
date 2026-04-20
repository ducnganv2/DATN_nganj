import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AICheckCacheDoc, SubmissionAICheck } from '../interface';
import db from './db';

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
type KaggleATCRuntimeMode = 'prebuilt';
type KaggleATCDevicePreference = 'auto' | 'cuda' | 'cpu';

interface KaggleKernelTarget {
    kernelId: string;
    kernelTitle: string;
}

interface KaggleAICheckConfig {
    cliCommand: string;
    kernelIds: string[];
    datasetSource: string;
    extraDatasetSources: string[];
    modelSources: string[];
    kernelSources: string[];
    atcProjectDir: string;
    runtimeMode: KaggleATCRuntimeMode;
    prebuiltPath: string | null;
    timeoutMs: number;
    pollIntervalMs: number;
    pushTimeoutMs: number;
    statusTimeoutMs: number;
    outputTimeoutMs: number;
    enableInternet: boolean;
    workdirRoot: string;
    keepWorkdir: boolean;
    resultFilename: string;
    detectorMethod: 'entropy' | 'mean_log_likelihood' | 'log_rank' | 'lrr';
    devicePreference: KaggleATCDevicePreference;
    allowCpuFallback: boolean;
    installP100Torch: boolean;
    p100TorchWheelPath: string | null;
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
const DEFAULT_AI_CHECK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AI_CHECK_CACHE_MAX_ENTRIES = 512;
const DEFAULT_KAGGLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KAGGLE_POLL_INTERVAL_MS = 5000;
const DEFAULT_KAGGLE_PUSH_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_KAGGLE_STATUS_TIMEOUT_MS = 60000;
const DEFAULT_KAGGLE_OUTPUT_TIMEOUT_MS = 2 * 60 * 1000;
const KAGGLE_TITLE_SEPARATOR_REGEX = /[-_]+/g;
const KAGGLE_TITLE_WORD_REGEX = /\b\w/g;
const CODE_LINE_SPLIT_REGEX = /\r?\n/;
const CODE_WHITESPACE_REGEX = /\s+/g;

const kaggleQueues = new Map<string, Promise<void>>();
const kaggleKernelPendingCounts = new Map<string, number>();
let kaggleKernelSelectionCursor = 0;
const aiCheckResultCache = new Map<string, { expiresAt: number, value: SubmissionAICheck }>();
const aiCheckInflightCache = new Map<string, Promise<SubmissionAICheck>>();
const aiCheckPersistentCacheColl = db.collection('aiCheck.cache');
let aiCheckPersistentCacheReady: Promise<void> | null = null;

function getExternalCheckTimeoutMs() {
    const timeoutMs = Number(process.env.HYDRO_SUBMISSION_AI_TIMEOUT_MS);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_AI_CHECK_TIMEOUT_MS;
}

function getPositiveEnvNumber(name: string, fallback: number) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAICheckCacheTtlMs() {
    return getPositiveEnvNumber('HYDRO_SUBMISSION_AI_CACHE_TTL_MS', DEFAULT_AI_CHECK_CACHE_TTL_MS);
}

function getAICheckCacheMaxEntries() {
    return Math.max(1, Math.floor(getPositiveEnvNumber('HYDRO_SUBMISSION_AI_CACHE_MAX_ENTRIES', DEFAULT_AI_CHECK_CACHE_MAX_ENTRIES)));
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

function parseCommaSeparatedEnv(name: string) {
    const value = process.env[name]?.trim();
    if (!value) return [];
    return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function parseKaggleRuntimeMode() {
    const value = process.env.HYDRO_KAGGLE_ATC_RUNTIME_MODE?.trim().toLowerCase();
    if (!value) return 'prebuilt';
    if (value === 'copy' || value === 'prebuilt') return 'prebuilt';
    throw new TypeError(`Unsupported HYDRO_KAGGLE_ATC_RUNTIME_MODE: ${value}`);
}

function parseKaggleDevicePreference() {
    const value = process.env.HYDRO_KAGGLE_ATC_DEVICE?.trim().toLowerCase();
    if (!value) return 'auto';
    if (value === 'auto' || value === 'cuda' || value === 'cpu') return value as KaggleATCDevicePreference;
    throw new TypeError(`Unsupported HYDRO_KAGGLE_ATC_DEVICE: ${value}`);
}

function isLikelyMountedKagglePath(value: string) {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith('/kaggle/input/')
        || normalized.startsWith('/kaggle/working/')
        || normalized.startsWith('./')
        || normalized.startsWith('../');
}

function resolveKaggleInternetEnabled(modelSources: string[], baseModelName: string) {
    const explicit = process.env.HYDRO_KAGGLE_ENABLE_INTERNET?.trim();
    if (explicit) return parseBooleanEnv('HYDRO_KAGGLE_ENABLE_INTERNET', true);
    if (modelSources.length > 0) return false;
    if (isLikelyMountedKagglePath(baseModelName)) return false;
    return true;
}

function getKaggleWaitTimeoutMs() {
    const rawValue = process.env.HYDRO_KAGGLE_TIMEOUT_MS?.trim();
    if (!rawValue) return DEFAULT_KAGGLE_TIMEOUT_MS;
    if (['0', 'false', 'off', 'none', 'infinite', 'infinity'].includes(rawValue.toLowerCase())) {
        return Number.POSITIVE_INFINITY;
    }
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KAGGLE_TIMEOUT_MS;
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
    if (process.env.HYDRO_KAGGLE_KERNEL_IDS?.trim()) return 'kaggle';
    if (process.env.HYDRO_KAGGLE_KERNEL_ID?.trim()) return 'kaggle';
    return 'local';
}

function getKaggleKernelTitle(kernelId: string) {
    const explicitTitle = process.env.HYDRO_KAGGLE_KERNEL_TITLE?.trim();
    if (explicitTitle) return explicitTitle;
    const slug = kernelId.split('/').slice(-1)[0] || 'hydro-ai-check';
    return slug.replace(KAGGLE_TITLE_SEPARATOR_REGEX, ' ').replace(KAGGLE_TITLE_WORD_REGEX, (letter) => letter.toUpperCase());
}

function getKaggleKernelIds() {
    const kernelIds = parseCommaSeparatedEnv('HYDRO_KAGGLE_KERNEL_IDS');
    if (kernelIds.length) return kernelIds;
    const kernelId = process.env.HYDRO_KAGGLE_KERNEL_ID?.trim();
    if (!kernelId) {
        throw new TypeError('Missing HYDRO_KAGGLE_KERNEL_ID or HYDRO_KAGGLE_KERNEL_IDS for the Kaggle AI check provider.');
    }
    return [kernelId];
}

function createKaggleKernelTargets(kernelIds: string[]): KaggleKernelTarget[] {
    return kernelIds.map((kernelId) => ({
        kernelId,
        kernelTitle: getKaggleKernelTitle(kernelId),
    }));
}

function getKaggleConfig(): KaggleAICheckConfig {
    const kernelIds = getKaggleKernelIds();
    const datasetSource = process.env.HYDRO_KAGGLE_ATC_DATASET_SOURCE?.trim();
    if (!datasetSource) {
        throw new TypeError('Missing HYDRO_KAGGLE_ATC_DATASET_SOURCE for the Kaggle AI check provider.');
    }
    const rawMethod = process.env.HYDRO_KAGGLE_ATC_METHOD?.trim() || 'entropy';
    if (!['entropy', 'mean_log_likelihood', 'log_rank', 'lrr'].includes(rawMethod)) {
        throw new TypeError(`Unsupported HYDRO_KAGGLE_ATC_METHOD: ${rawMethod}`);
    }
    const threshold = Number(process.env.HYDRO_KAGGLE_ATC_THRESHOLD ?? '-0.185');
    if (!Number.isFinite(threshold)) {
        throw new TypeError('HYDRO_KAGGLE_ATC_THRESHOLD must be a valid number.');
    }
    const modelSources = parseCommaSeparatedEnv('HYDRO_KAGGLE_MODEL_SOURCES');
    const kernelSources = parseCommaSeparatedEnv('HYDRO_KAGGLE_KERNEL_SOURCES');
    const extraDatasetSources = parseCommaSeparatedEnv('HYDRO_KAGGLE_EXTRA_DATASET_SOURCES');
    const devicePreference = parseKaggleDevicePreference();
    const allowCpuFallback = parseBooleanEnv('HYDRO_KAGGLE_ATC_ALLOW_CPU_FALLBACK', true);
    const installP100Torch = parseBooleanEnv('HYDRO_KAGGLE_INSTALL_P100_TORCH', false);
    const p100TorchWheelPath = process.env.HYDRO_KAGGLE_P100_TORCH_WHEEL_PATH?.trim() || null;
    const baseModelName = process.env.HYDRO_KAGGLE_ATC_BASE_MODEL?.trim() || 'codellama/CodeLlama-7b-Instruct-hf';
    const enableInternet = resolveKaggleInternetEnabled(modelSources, baseModelName);
    if (!enableInternet && !modelSources.length && !isLikelyMountedKagglePath(baseModelName)) {
        throw new TypeError(
            'HYDRO_KAGGLE_ENABLE_INTERNET=false requires HYDRO_KAGGLE_MODEL_SOURCES or HYDRO_KAGGLE_ATC_BASE_MODEL pointing to /kaggle/input or another mounted local path.',
        );
    }
    return {
        cliCommand: process.env.HYDRO_KAGGLE_CLI?.trim() || 'kaggle',
        kernelIds,
        datasetSource,
        extraDatasetSources,
        modelSources,
        kernelSources,
        atcProjectDir: process.env.HYDRO_KAGGLE_ATC_PROJECT_DIR?.trim() || 'ATC-main',
        runtimeMode: parseKaggleRuntimeMode(),
        prebuiltPath: process.env.HYDRO_KAGGLE_ATC_PREBUILT_PATH?.trim() || null,
        timeoutMs: getKaggleWaitTimeoutMs(),
        pollIntervalMs: getPositiveEnvNumber('HYDRO_KAGGLE_POLL_INTERVAL_MS', DEFAULT_KAGGLE_POLL_INTERVAL_MS),
        pushTimeoutMs: getPositiveEnvNumber('HYDRO_KAGGLE_PUSH_TIMEOUT_MS', DEFAULT_KAGGLE_PUSH_TIMEOUT_MS),
        statusTimeoutMs: getPositiveEnvNumber('HYDRO_KAGGLE_STATUS_TIMEOUT_MS', DEFAULT_KAGGLE_STATUS_TIMEOUT_MS),
        outputTimeoutMs: getPositiveEnvNumber('HYDRO_KAGGLE_OUTPUT_TIMEOUT_MS', DEFAULT_KAGGLE_OUTPUT_TIMEOUT_MS),
        enableInternet,
        workdirRoot: process.env.HYDRO_KAGGLE_WORKDIR?.trim() || path.join(os.tmpdir(), 'hydro-kaggle-ai-check'),
        keepWorkdir: parseBooleanEnv('HYDRO_KAGGLE_KEEP_WORKDIR', false),
        resultFilename: process.env.HYDRO_KAGGLE_RESULT_FILENAME?.trim() || 'ai-check-result.json',
        detectorMethod: rawMethod as KaggleAICheckConfig['detectorMethod'],
        devicePreference,
        allowCpuFallback,
        installP100Torch,
        p100TorchWheelPath,
        baseModelName,
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
        .split(CODE_LINE_SPLIT_REGEX)
        .map((line) => line.trim())
        .filter(Boolean)
        .length;
    const nonWhitespaceChars = code.replace(CODE_WHITESPACE_REGEX, '').length;
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

function getCodeHash(code?: string) {
    return createHash('sha256').update(code || '').digest('hex');
}

function getAICheckCacheId(cacheKey: string) {
    return createHash('sha256').update(cacheKey).digest('hex');
}

function isReusableAICheck(aiCheck: SubmissionAICheck) {
    return aiCheck.state === 'checked' || aiCheck.state === 'skipped';
}

function pruneAICheckCache(now = Date.now()) {
    for (const [key, entry] of aiCheckResultCache) {
        if (entry.expiresAt <= now) aiCheckResultCache.delete(key);
    }
    const maxEntries = getAICheckCacheMaxEntries();
    while (aiCheckResultCache.size > maxEntries) {
        const oldestKey = aiCheckResultCache.keys().next().value;
        if (!oldestKey) break;
        aiCheckResultCache.delete(oldestKey);
    }
}

function getCachedAICheck(cacheKey: string) {
    pruneAICheckCache();
    const cached = aiCheckResultCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        aiCheckResultCache.delete(cacheKey);
        return null;
    }
    return cached.value;
}

function setCachedAICheck(cacheKey: string, aiCheck: SubmissionAICheck) {
    if (!isReusableAICheck(aiCheck)) return;
    aiCheckResultCache.set(cacheKey, {
        value: aiCheck,
        expiresAt: Date.now() + getAICheckCacheTtlMs(),
    });
    pruneAICheckCache();
}

function createAICheckCacheKey(
    provider: SubmissionAICheckProvider,
    input: SubmissionAICheckInput,
    extra: Record<string, unknown> = {},
) {
    return JSON.stringify({
        provider,
        lang: input.lang,
        hasUpload: !!input.hasUpload,
        codeHash: getCodeHash(input.code),
        ...extra,
    });
}

async function ensurePersistentAICheckCache() {
    aiCheckPersistentCacheReady ||= db.ensureIndexes(
        aiCheckPersistentCacheColl,
        { key: { expireAt: -1 }, name: 'expire', expireAfterSeconds: 0 },
        { key: { updateAt: -1 }, name: 'updateAt' },
    ).catch(() => undefined);
    await aiCheckPersistentCacheReady;
}

async function getPersistentCachedAICheck(cacheKey: string) {
    try {
        await ensurePersistentAICheckCache();
        const doc = await aiCheckPersistentCacheColl.findOne({ _id: getAICheckCacheId(cacheKey) });
        if (!doc) return null;
        if (doc.expireAt.getTime() <= Date.now()) {
            void aiCheckPersistentCacheColl.deleteOne({ _id: doc._id }).catch(() => undefined);
            return null;
        }
        const aiCheck = doc.aiCheck;
        setCachedAICheck(cacheKey, aiCheck);
        return aiCheck;
    } catch {
        return null;
    }
}

async function setPersistentCachedAICheck(cacheKey: string, aiCheck: SubmissionAICheck) {
    if (!isReusableAICheck(aiCheck)) return;
    try {
        await ensurePersistentAICheckCache();
        const now = new Date();
        const payload: AICheckCacheDoc = {
            _id: getAICheckCacheId(cacheKey),
            key: cacheKey,
            aiCheck,
            updateAt: now,
            expireAt: new Date(now.getTime() + getAICheckCacheTtlMs()),
        };
        await aiCheckPersistentCacheColl.findOneAndUpdate(
            { _id: payload._id },
            { $set: payload },
            { upsert: true, returnDocument: 'after' },
        );
    } catch {
        // Ignore cache persistence errors and keep the AI check flow working.
    }
}

async function runAICheckWithCache(cacheKey: string, task: () => Promise<SubmissionAICheck>) {
    const cached = getCachedAICheck(cacheKey);
    if (cached) return cached;

    const inflight = aiCheckInflightCache.get(cacheKey);
    if (inflight) return await inflight;

    const persistentCached = await getPersistentCachedAICheck(cacheKey);
    if (persistentCached) return persistentCached;

    const inflightAfterPersistentLookup = aiCheckInflightCache.get(cacheKey);
    if (inflightAfterPersistentLookup) return await inflightAfterPersistentLookup;

    const promise = (async () => {
        const result = await task();
        setCachedAICheck(cacheKey, result);
        await setPersistentCachedAICheck(cacheKey, result);
        return result;
    })();
    aiCheckInflightCache.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        aiCheckInflightCache.delete(cacheKey);
    }
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

async function withKaggleKernelQueue<T>(kernelId: string, task: () => Promise<T>) {
    const previous = kaggleQueues.get(kernelId)?.catch(() => undefined) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    kaggleQueues.set(kernelId, current);
    await previous;
    try {
        return await task();
    } finally {
        release();
        if (kaggleQueues.get(kernelId) === current) kaggleQueues.delete(kernelId);
    }
}

function reserveKaggleKernel(config: KaggleAICheckConfig) {
    const targets = createKaggleKernelTargets(config.kernelIds);
    const startIndex = kaggleKernelSelectionCursor++ % targets.length;
    let selected = targets[startIndex];
    let selectedPending = kaggleKernelPendingCounts.get(selected.kernelId) || 0;
    for (let offset = 1; offset < targets.length; offset++) {
        const target = targets[(startIndex + offset) % targets.length];
        const pending = kaggleKernelPendingCounts.get(target.kernelId) || 0;
        if (pending < selectedPending) {
            selected = target;
            selectedPending = pending;
        }
    }
    kaggleKernelPendingCounts.set(selected.kernelId, selectedPending + 1);
    return selected;
}

function releaseKaggleKernel(kernelId: string) {
    const current = kaggleKernelPendingCounts.get(kernelId) || 0;
    if (current <= 1) {
        kaggleKernelPendingCounts.delete(kernelId);
        return;
    }
    kaggleKernelPendingCounts.set(kernelId, current - 1);
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

async function waitForKaggleKernel(config: KaggleAICheckConfig, target: KaggleKernelTarget) {
    const startedAt = Date.now();
    let lastStatusOutput = '';
    while (!Number.isFinite(config.timeoutMs) || Date.now() - startedAt <= config.timeoutMs) {
        const { stdout, stderr, exitCode } = await runCommandAllowFailure(
            config.cliCommand,
            ['kernels', 'status', target.kernelId],
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
            throw new Error(`Kaggle kernel ${target.kernelId} failed. ${lastStatusOutput}`);
        }
        await sleep(config.pollIntervalMs);
    }
    throw new Error(`Kaggle kernel ${target.kernelId} did not finish within ${config.timeoutMs} ms. Last status: ${lastStatusOutput}`);
}

function createKaggleNotebook(input: SubmissionAICheckInput, config: KaggleAICheckConfig) {
    const payload = JSON.stringify({
        code_b64: Buffer.from(input.code || '', 'utf-8').toString('base64'),
        language: mapSubmissionLanguageToATCLanguage(input.lang),
        method: config.detectorMethod,
        device: config.devicePreference,
        allow_cpu_fallback: config.allowCpuFallback,
        install_p100_torch: config.installP100Torch,
        p100_torch_wheel_path: config.p100TorchWheelPath,
        base_model_name: config.baseModelName,
        infer_task: config.inferTask,
        prompt_style: config.promptStyle,
        threshold: config.threshold,
        pattern_weight_mapping: config.patternWeightMapping,
        dataset_source: config.datasetSource,
        atc_project_dir: config.atcProjectDir,
        runtime_mode: config.runtimeMode,
        prebuilt_path: config.prebuiltPath,
        provider_name: config.providerName,
        result_filename: config.resultFilename,
    });
    const mainCodeLines = [
        `payload = json.loads(${JSON.stringify(payload)})`,
        "code = base64.b64decode(payload['code_b64']).decode('utf-8')",
        '',
        "os.environ.setdefault('HF_HUB_ETAG_TIMEOUT', '120')",
        "os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '120')",
        "os.environ.setdefault('PYTORCH_NVML_BASED_CUDA_CHECK', '1')",
        "os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')",
        "os.environ.setdefault('TRANSFORMERS_NO_TF', '1')",
        "os.environ.setdefault('TRANSFORMERS_NO_FLAX', '1')",
        '',
        'def run_python_module(args):',
        '    subprocess.run([sys.executable, "-m", *args], check=True)',
        '',
        'def get_nvidia_smi_name():',
        '    try:',
        '        completed = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], check=False, capture_output=True, text=True, timeout=10)',
        '        return completed.stdout.strip()',
        '    except Exception:',
        "        return ''",
        '',
        "gpu_name = get_nvidia_smi_name()",
        '',
        'def has_local_safetensors_model(model_name):',
        '    try:',
        '        model_path = Path(model_name).expanduser().resolve()',
        '        if not model_path.exists():',
        '            return False',
        '        return bool(list(model_path.glob("*.safetensors")) or (model_path / "model.safetensors.index.json").exists())',
        '    except Exception:',
        '        return False',
        '',
        'def find_local_p100_torch_wheel_dir():',
        "    patterns = [",
        "        '/kaggle/input/**/torch-2.6.0*cu124*cp312*.whl',",
        "        '/kaggle/input/**/torch-2.6.0+cu124*.whl',",
        "        '/kaggle/input/**/torch-2.6.0*.whl',",
        '    ]',
        '    for pattern in patterns:',
        '        matches = glob.glob(pattern, recursive=True)',
        '        if matches:',
        '            return str(Path(matches[0]).resolve().parent)',
        '    return None',
        '',
        "if payload.get('install_p100_torch') and 'P100' in gpu_name:",
        '    print(f"Detected {gpu_name}; installing PyTorch 2.6.0 CUDA 12.4 wheel for P100 compatibility.", flush=True)',
        '    run_python_module(["pip", "uninstall", "-y", "-q", "torchvision", "torchaudio", "torchao"])',
        "    wheel_path = payload.get('p100_torch_wheel_path') or find_local_p100_torch_wheel_dir()",
        '    if wheel_path:',
        '        wheel_dir = Path(wheel_path).expanduser().resolve()',
        '        if not wheel_dir.is_dir():',
        '            raise RuntimeError(f"Configured P100 torch wheel path does not exist: {wheel_dir}")',
        '        print(f"Installing PyTorch from local Kaggle wheel path: {wheel_dir}", flush=True)',
        '        run_python_module(["pip", "install", "-q", "--no-warn-conflicts", "--force-reinstall", "--no-cache-dir", "--no-index", "--find-links", str(wheel_dir), "torch==2.6.0"])',
        '    else:',
        '        run_python_module(["pip", "install", "-q", "--no-warn-conflicts", "--force-reinstall", "--no-cache-dir", "--index-url", "https://download.pytorch.org/whl/cu124", "torch==2.6.0"])',
        'import torch',
        "project_dir = payload['atc_project_dir']",
        "prebuilt_path = payload.get('prebuilt_path')",
        "dataset_owner, dataset_slug = (payload['dataset_source'].split('/', 1) + [''])[:2]",
        "search_patterns = ['/kaggle/input', '/kaggle/input/*', '/kaggle/input/*/*', '/kaggle/input/*/*/*', '/kaggle/input/*/*/*/*']",
        'candidate_dirs = []',
        'seen = set()',
        'def is_atc_project(candidate_path):',
        '    return (candidate_path / "detection" / "run.py").exists() and (candidate_path / "detection" / "detector.py").exists()',
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
        '        if is_atc_project(candidate_path):',
        '            candidate_dirs.append(candidate_path)',
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
        'runtime_path = None',
        'runtime_resolution_note = None',
        'if prebuilt_path:',
        '    candidate_path = Path(prebuilt_path).expanduser().resolve()',
        '    if candidate_path.is_dir() and is_atc_project(candidate_path):',
        '        runtime_path = candidate_path',
        "        runtime_resolution_note = f'Using configured prebuilt path: {candidate_path}'",
        '    else:',
        "        runtime_resolution_note = f'Configured prebuilt path was unusable: {candidate_path}'",
        'if runtime_path is None:',
        '    if not candidate_dirs:',
        '        visible_inputs = [str(Path(path).resolve()) for path in glob.glob("/kaggle/input/*")]',
        '        raise RuntimeError(f"Could not locate an ATC project under /kaggle/input. dataset_source={payload[\'dataset_source\']!r}, prebuilt_path={prebuilt_path!r}, visible_inputs={visible_inputs}")',
        '    runtime_path = sorted(candidate_dirs, key=candidate_score)[0]',
        '    if runtime_resolution_note:',
        "        runtime_resolution_note += f'; fallback runtime_path={runtime_path}'",
        '    else:',
        "        runtime_resolution_note = f'Auto-detected runtime_path={runtime_path}'",
        'os.chdir(str(runtime_path))',
        'if str(runtime_path) not in sys.path:',
        '    sys.path.insert(0, str(runtime_path))',
        '',
        'def is_cuda_runtime_error(exc):',
        "    error_text = f'{type(exc).__name__}: {exc}'.lower()",
        "    error_markers = ('cuda', 'acceleratorerror', 'cublas', 'cudnn', 'nccl', 'no kernel image', 'device-side assert')",
        '    return any(marker in error_text for marker in error_markers)',
        '',
        'def patch_runtime_module(module_name, module_path, device_name):',
        "    module_source = module_path.read_text(encoding='utf-8')",
        "    module_source = module_source.replace(\"\\\"python\\\": '^\\\\s*(#.*)$'\", \"\\\"python\\\": r'^\\\\s*(#.*)$'\")",
        "    module_source = module_source.replace('torch_dtype=torch.float16', 'dtype=torch.float16')",
        "    module_source = module_source.replace('logits = output.logits[:, :-1]  # Shape: (batch_size=1, seq_length, vocab_size)', 'logits = output.logits[:, :-1].float()  # Shape: (batch_size=1, seq_length, vocab_size)')",
        "    module_source = module_source.replace('probs = F.softmax(logits, dim=-1)  # Shape: (1, seq_length, vocab_size)\\n\\n            # Compute entropy for each token\\n            entropy = -(probs * probs.log()).sum(dim=-1)  # Shape: (1, seq_length)', 'log_probs = F.log_softmax(logits, dim=-1)  # Shape: (1, seq_length, vocab_size)\\n            probs = log_probs.exp()  # Shape: (1, seq_length, vocab_size)\\n\\n            # Compute entropy for each token\\n            entropy = -(probs * log_probs).sum(dim=-1)  # Shape: (1, seq_length)\\n            entropy = torch.nan_to_num(entropy, nan=0.0, posinf=0.0, neginf=0.0)')",
        "    model_device_map = 'auto' if device_name == 'cuda' else device_name",
        "    module_source = module_source.replace('device_map=\"cuda\"', f'device_map=\"{model_device_map}\"')",
        "    module_source = module_source.replace(\"device_map='cuda'\", f\"device_map='{model_device_map}'\")",
        "    causal_lm_line = f'self.model = AutoModelForCausalLM.from_pretrained(self.model_name, dtype=torch.float16, device_map=\"{model_device_map}\")'",
        "    safetensors_patch = '        _safetensors_kwargs = {}\\n        try:\\n            from pathlib import Path as _HydroPath\\n            _model_path = _HydroPath(self.model_name)\\n            if _model_path.exists() and (list(_model_path.glob(\"*.safetensors\")) or (_model_path / \"model.safetensors.index.json\").exists()):\\n                _safetensors_kwargs[\"use_safetensors\"] = True\\n        except Exception:\\n            pass\\n'",
        "    safetensors_patch += f'        self.model = AutoModelForCausalLM.from_pretrained(self.model_name, dtype=torch.float16, device_map=\"{model_device_map}\", **_safetensors_kwargs)'",
        "    module_source = module_source.replace('        ' + causal_lm_line, safetensors_patch)",
        "    module_source = module_source.replace('.to(\"cuda\")', f'.to(\"{device_name}\")')",
        "    module_source = module_source.replace(\".to('cuda')\", f\".to('{device_name}')\")",
        "    attention_mask_line = f'attention_mask = raw_input.ne(self.tokenizer.eos_token_id).to(\"{device_name}\")'",
        "    attention_mask_patch = f'raw_input = raw_input[\"input_ids\"] if hasattr(raw_input, \"data\") and \"input_ids\" in raw_input else raw_input\\n            attention_mask = raw_input.ne(self.tokenizer.eos_token_id).to(\"{device_name}\")'",
        "    module_source = module_source.replace(attention_mask_line, attention_mask_patch)",
        "    if device_name == 'cpu':",
        "        module_source = module_source.replace('dtype=torch.float16', 'dtype=torch.float32')",
        '    module_spec = importlib.util.spec_from_loader(module_name, loader=None)',
        '    patched_module = importlib.util.module_from_spec(module_spec)',
        '    patched_module.__file__ = str(module_path)',
        '    patched_module.__package__ = module_name.rsplit(".", 1)[0]',
        '    sys.modules[module_name] = patched_module',
        "    exec(compile(module_source, str(module_path), 'exec'), patched_module.__dict__)",
        '    return patched_module',
        '',
        'def prepare_runtime_modules(device_name):',
        "    sys.modules.pop('detection.detector', None)",
        "    sys.modules.pop('detection.utils.detectgpt', None)",
        "    patch_runtime_module('detection.utils.detectgpt', runtime_path / 'detection' / 'utils' / 'detectgpt.py', device_name)",
        "    return patch_runtime_module('detection.detector', runtime_path / 'detection' / 'detector.py', device_name)",
        '',
        "preferred_device = (payload.get('device') or 'auto').strip().lower()",
        "allow_cpu_fallback = bool(payload.get('allow_cpu_fallback', True))",
        "if preferred_device not in ('auto', 'cuda', 'cpu'):",
        '    raise RuntimeError(f"Unsupported device preference: {preferred_device!r}")',
        'cuda_skip_reason = None',
        'try:',
        '    cuda_arch_list = list(torch.cuda.get_arch_list())',
        'except Exception:',
        '    cuda_arch_list = []',
        'def should_try_cuda():',
        '    global cuda_skip_reason',
        "    if 'P100' in gpu_name and 'sm_60' not in cuda_arch_list:",
        "        cuda_skip_reason = f'Detected {gpu_name}; current PyTorch lacks sm_60, so CUDA was skipped and CPU was used directly.'",
        '        return False',
        '    if not torch.cuda.is_available():',
        "        cuda_skip_reason = 'CUDA is not available in this Kaggle runtime.'",
        '        return False',
        '    return True',
        'device_candidates = []',
        "if preferred_device == 'cpu':",
        "    device_candidates = ['cpu']",
        "elif preferred_device == 'cuda':",
        '    if should_try_cuda():',
        "        device_candidates.append('cuda')",
        '    if allow_cpu_fallback:',
        "        device_candidates.append('cpu')",
        'else:',
        '    if should_try_cuda():',
        "        device_candidates.append('cuda')",
        "    device_candidates.append('cpu')",
        'if not device_candidates:',
        "    raise RuntimeError(cuda_skip_reason or 'No usable device candidate is available.')",
        'score = None',
        'inferred_task = None',
        'used_device = None',
        'fallback_reason = None',
        'last_device_error = None',
        'for device_name in device_candidates:',
        '    try:',
        '        detector_module = prepare_runtime_modules(device_name)',
        '        detectors = {',
        "            'entropy': detector_module.EntropyDetector,",
        "            'mean_log_likelihood': detector_module.MeanLogLikelihoodDetector,",
        "            'log_rank': detector_module.LogRankDetector,",
        "            'lrr': detector_module.LRRDetector,",
        '        }',
        "        detector_cls = detectors[payload['method']]",
        "        infer_task_cfg = SimpleNamespace(debug=False, debug_file='debug_documentation.txt', use_cache=False, prompt_style=payload['prompt_style'])",
        "        detector = detector_cls(model_name=payload['base_model_name'], pattern_weight_mapping=payload['pattern_weight_mapping'], infer_task_cfg=infer_task_cfg, language=payload['language'])",
        "        if payload['infer_task']:",
        '            score, inferred_task = detector.compute_score_infer_task(code)',
        '        else:',
        '            score = detector.compute_score_without_task(code)',
        '        score = float(score)',
        '        if not math.isfinite(score):',
        "            raise FloatingPointError(f'Detector returned non-finite score on {device_name}: {score}')",
        '        used_device = device_name',
        '        break',
        '    except Exception as device_exc:',
        '        last_device_error = device_exc',
        '        if device_name == "cuda" and allow_cpu_fallback and (is_cuda_runtime_error(device_exc) or isinstance(device_exc, FloatingPointError)):',
        "            fallback_reason = f'{type(device_exc).__name__}: {device_exc}'",
        '            gc.collect()',
        '            try:',
        '                torch.cuda.empty_cache()',
        '            except Exception:',
        '                pass',
        '            continue',
        '        raise',
        'if score is None:',
        "    raise last_device_error or RuntimeError('Detector did not produce a score.')",
        "threshold = float(payload['threshold'])",
        'is_ai = bool(score >= threshold)',
        "comparison = '>=' if is_ai else '<'",
        "message = f'Kaggle ATC score {score:.6f} {comparison} threshold {threshold:.6f} on {used_device}.'",
        'if runtime_resolution_note:',
        "    message += f' {runtime_resolution_note}'",
        'if cuda_skip_reason and used_device == "cpu":',
        "    message += f' {cuda_skip_reason}'",
        'if fallback_reason:',
        "    message += f' CPU fallback was used after CUDA failure: {fallback_reason}'",
        'confidence = None',
        'if math.isfinite(score) and math.isfinite(threshold):',
        '    confidence = max(0, min(100, round(100 / (1 + math.exp(-((score - threshold) / 0.05))))))',
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
        'print(json.dumps(result, ensure_ascii=False))',
    ];
    const codeLines = [
        'import base64',
        'import gc',
        'import glob',
        'import importlib.util',
        'import json',
        'import math',
        'import os',
        'import subprocess',
        'import sys',
        'import traceback',
        'from datetime import datetime, timezone',
        'from pathlib import Path',
        'from types import SimpleNamespace',
        '',
        `payload = json.loads(${JSON.stringify(payload)})`,
        'result_path = Path(f"/kaggle/working/{payload[\'result_filename\']}")',
        'try:',
        ...mainCodeLines.map((line) => (line.length > 0 ? `    ${line}` : '')),
        'except Exception as exc:',
        '    error_result = {',
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
        '    print(json.dumps(error_result, ensure_ascii=False))',
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
                internet: config.enableInternet,
            },
        },
        nbformat: 4,
        nbformat_minor: 5,
    }, null, 2);
}

function createKaggleKernelMetadata(config: KaggleAICheckConfig, target: KaggleKernelTarget, notebookFilename: string) {
    const datasetSources = [config.datasetSource, ...config.extraDatasetSources];
    return JSON.stringify({
        id: target.kernelId,
        title: target.kernelTitle,
        code_file: notebookFilename,
        language: 'python',
        kernel_type: 'notebook',
        is_private: true,
        enable_gpu: true,
        enable_internet: config.enableInternet,
        dataset_sources: [...new Set(datasetSources)],
        kernel_sources: config.kernelSources,
        competition_sources: [],
        model_sources: config.modelSources,
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
    const target = reserveKaggleKernel(config);
    return await withKaggleKernelQueue(target.kernelId, async () => {
        const jobDir = path.join(config.workdirRoot, randomUUID());
        const notebookFilename = 'hydro-kaggle-ai-check.ipynb';
        const outputDir = path.join(jobDir, 'output');
        try {
            await fs.mkdir(jobDir, { recursive: true });
            await fs.writeFile(path.join(jobDir, notebookFilename), createKaggleNotebook(input, config), 'utf-8');
            await fs.writeFile(
                path.join(jobDir, 'kernel-metadata.json'),
                createKaggleKernelMetadata(config, target, notebookFilename),
                'utf-8',
            );

            await runCommand(config.cliCommand, ['kernels', 'push', '-p', jobDir], config.pushTimeoutMs);
            await waitForKaggleKernel(config, target);

            await fs.mkdir(outputDir, { recursive: true });
            await runCommand(
                config.cliCommand,
                ['kernels', 'output', target.kernelId, '-p', outputDir, '-o', '-q'],
                config.outputTimeoutMs,
            );

            const resultPath = path.join(outputDir, config.resultFilename);
            const raw = await fs.readFile(resultPath, 'utf-8');
            const payload = JSON.parse(raw) as ExternalAICheckPayload;
            return normalizeKagglePayload(payload);
        } finally {
            releaseKaggleKernel(target.kernelId);
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
            const cacheKey = createAICheckCacheKey(provider, input, { apiUrl });
            return await runAICheckWithCache(cacheKey, () => externalCheck(input, apiUrl));
        }
        if (provider === 'kaggle') {
            const config = getKaggleConfig();
            const cacheKey = createAICheckCacheKey(provider, input, {
                kernelIds: config.kernelIds,
                datasetSource: config.datasetSource,
                extraDatasetSources: config.extraDatasetSources,
                modelSources: config.modelSources,
                kernelSources: config.kernelSources,
                atcProjectDir: config.atcProjectDir,
                runtimeMode: config.runtimeMode,
                prebuiltPath: config.prebuiltPath,
                detectorMethod: config.detectorMethod,
                devicePreference: config.devicePreference,
                allowCpuFallback: config.allowCpuFallback,
                installP100Torch: config.installP100Torch,
                p100TorchWheelPath: config.p100TorchWheelPath,
                baseModelName: config.baseModelName,
                inferTask: config.inferTask,
                promptStyle: config.promptStyle,
                threshold: config.threshold,
                patternWeightMapping: config.patternWeightMapping,
                minNonEmptyLines: config.minNonEmptyLines,
                minNonWhitespaceChars: config.minNonWhitespaceChars,
            });
            return await runAICheckWithCache(cacheKey, () => kaggleCheck(input));
        }
        const cacheKey = createAICheckCacheKey(provider, input);
        return await runAICheckWithCache(cacheKey, () => Promise.resolve(localFallbackCheck(input)));
    } catch (error) {
        const provider = resolveSubmissionAICheckProvider() === 'kaggle' ? KAGGLE_PROVIDER : EXTERNAL_PROVIDER;
        return createErrorSubmissionAICheck(
            error instanceof Error ? error.message : 'Failed to run the AI check provider.',
            provider,
        );
    }
}
