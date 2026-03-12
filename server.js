require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { readConfig, writeConfig } = require('./bot-config');

const app = express();
const PORT = process.env.PORT || process.env.UI_PORT || 3000;

const STATS_FILE = path.join(__dirname, 'daily-stats.json');
const APPLIED_LOG = path.join(__dirname, 'applied_jobs.md');
const BASE_PROFILE_DIR = path.join(__dirname, 'chrome_profile');
const AGENT_PROFILE_ROOT = path.join(__dirname, 'chrome_profiles');
const MAX_GLOBAL_LOG_LINES = 800;
const MAX_AGENT_LOG_LINES = 80;
const MAX_AGENT_BRANCHES = 12;
const PROFILE_COPY_SKIP = new Set([
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'lockfile',
    'LOCK',
    'DevToolsActivePort'
]);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sseClients = [];
let orchestrator = createOrchestratorState();
let demoTimers = [];

function createOrchestratorState() {
    return {
        runId: 0,
        running: false,
        stopRequested: false,
        startedAt: null,
        endedAt: null,
        requestedAgents: 0,
        plannedAgents: 0,
        logs: [],
        agents: {}
    };
}

function stripAnsi(value) {
    return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function getConfig() {
    return readConfig();
}

function saveConfig(config) {
    writeConfig(config);
}

function getDailyStats() {
    const today = new Date().toISOString().split('T')[0];
    let daily = { date: today, easyApplyCount: 0, externalApplyCount: 0, skippedCount: 0, rateLimitedCount: 0 };
    if (fs.existsSync(STATS_FILE)) {
        try {
            const stored = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            if (stored.date === today) daily = stored;
        } catch (error) {
        }
    }
    return daily;
}

function getTotalStats() {
    let totalApplied = 0;
    let totalExternal = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    if (fs.existsSync(APPLIED_LOG)) {
        const lines = fs.readFileSync(APPLIED_LOG, 'utf8')
            .split('\n')
            .filter(line => line.trim().startsWith('-'));

        lines.forEach(line => {
            if (/Status: \*\*APPLIED\*\*/.test(line)) totalApplied++;
            else if (/Status: \*\*APPLIED_EXTERNAL/.test(line)) totalExternal++;
            else if (/SKIPPED|INELIGIBLE|COMPLEX|PARTIAL/.test(line)) totalSkipped++;
            else if (/FAILED|ERROR/.test(line)) totalFailed++;
        });
    }

    return {
        totalApplied,
        totalExternal,
        totalSkipped,
        totalFailed,
        totalAll: totalApplied + totalExternal
    };
}

function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    sseClients.forEach(client => {
        try {
            client.write(data);
        } catch (error) {
        }
    });
}

function getAgentSnapshot(agent) {
    return {
        id: agent.id,
        index: agent.index,
        pid: agent.pid,
        status: agent.status,
        keywords: agent.keywords,
        currentKeyword: agent.currentKeyword,
        headless: agent.headless,
        userDataDir: agent.userDataDir,
        startedAt: agent.startedAt,
        endedAt: agent.endedAt,
        lastEventAt: agent.lastEventAt,
        lastMessage: agent.lastMessage,
        currentActivity: agent.currentActivity,
        error: agent.error,
        exitCode: agent.exitCode,
        metrics: { ...agent.metrics },
        branches: (agent.branches || []).slice(0, MAX_AGENT_BRANCHES),
        logs: agent.logs.slice(-MAX_AGENT_LOG_LINES)
    };
}

function getOrchestratorSnapshot() {
    const agents = Object.values(orchestrator.agents)
        .sort((a, b) => a.index - b.index)
        .map(getAgentSnapshot);

    const activeAgents = agents.filter(agent => ['queued', 'starting', 'running'].includes(agent.status)).length;

    return {
        runId: orchestrator.runId,
        running: orchestrator.running,
        stopRequested: orchestrator.stopRequested,
        startedAt: orchestrator.startedAt,
        endedAt: orchestrator.endedAt,
        requestedAgents: orchestrator.requestedAgents,
        plannedAgents: orchestrator.plannedAgents,
        activeAgents,
        logs: orchestrator.logs.slice(-MAX_GLOBAL_LOG_LINES),
        agents
    };
}

function broadcastState() {
    const snapshot = getOrchestratorSnapshot();
    broadcast({ type: 'status', running: snapshot.running });
    broadcast({ type: 'orchestrator', state: snapshot });
}

function appendGlobalLog(message, agentId = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        agentId,
        message
    };
    orchestrator.logs.push(entry);
    if (orchestrator.logs.length > MAX_GLOBAL_LOG_LINES) {
        orchestrator.logs = orchestrator.logs.slice(-MAX_GLOBAL_LOG_LINES);
    }
    broadcast({ type: 'log', ...entry });
}

function updateAgent(agent, updates) {
    Object.assign(agent, updates, { lastEventAt: new Date().toISOString() });
    broadcast({ type: 'agent', agent: getAgentSnapshot(agent) });
}

function refreshAgentBranches(agent) {
    agent.branches = Object.values(agent.branchMap || {})
        .sort((a, b) => new Date(b.lastUpdatedAt || b.startedAt || 0) - new Date(a.lastUpdatedAt || a.startedAt || 0))
        .slice(0, MAX_AGENT_BRANCHES);
}

function partitionKeywords(keywords, requestedAgents) {
    const lanes = Array.from(
        { length: Math.max(1, Math.min(requestedAgents, keywords.length || 1)) },
        () => []
    );

    keywords.forEach((keyword, index) => {
        lanes[index % lanes.length].push(keyword);
    });

    return lanes.filter(lane => lane.length > 0);
}

function copyProfileRecursive(sourceDir, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        if (PROFILE_COPY_SKIP.has(entry.name)) continue;

        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            copyProfileRecursive(sourcePath, targetPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

function ensureAgentProfile(agentId) {
    const targetDir = path.join(AGENT_PROFILE_ROOT, agentId);
    if (fs.existsSync(targetDir)) return targetDir;

    fs.mkdirSync(AGENT_PROFILE_ROOT, { recursive: true });

    if (fs.existsSync(BASE_PROFILE_DIR)) {
        copyProfileRecursive(BASE_PROFILE_DIR, targetDir);
    } else {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    return targetDir;
}

function applyResultMetrics(agent, status) {
    if (/^APPLIED_EXTERNAL/.test(status)) agent.metrics.external += 1;
    else if (status === 'APPLIED') agent.metrics.applied += 1;
    else if (/RATE.?LIMIT/i.test(status)) agent.metrics.rateLimited += 1;
    else if (/SKIPPED|INELIGIBLE|COMPLEX|PARTIAL/i.test(status)) agent.metrics.skipped += 1;
    else if (/FAILED|ERROR/i.test(status)) agent.metrics.failed += 1;
}

function handleAgentEvent(agent, event) {
    if (!event || typeof event !== 'object') return;

    if (event.kind === 'status') {
        updateAgent(agent, {
            status: event.status || agent.status,
            startedAt: agent.startedAt || (event.status === 'starting' || event.status === 'running' ? event.timestamp : null),
            endedAt: ['completed', 'failed', 'stopped'].includes(event.status) ? event.timestamp : agent.endedAt,
            error: event.error || agent.error
        });
        return;
    }

    if (event.kind === 'activity') {
        updateAgent(agent, {
            currentActivity: {
                stage: event.stage || 'working',
                message: event.message || agent.lastMessage,
                companyName: event.companyName || null,
                jobTitle: event.jobTitle || null,
                jobUrl: event.jobUrl || null,
                keyword: event.keyword || null,
                updatedAt: event.timestamp
            },
            lastMessage: event.message || agent.lastMessage
        });
        return;
    }

    if (event.kind === 'branch') {
        const branchMap = agent.branchMap || {};
        const existing = branchMap[event.branchId] || {
            id: event.branchId,
            branchType: event.branchType || 'task',
            title: event.title || 'Task Branch',
            status: 'active',
            startedAt: event.timestamp
        };

        branchMap[event.branchId] = {
            ...existing,
            ...('branchType' in event ? { branchType: event.branchType || existing.branchType } : {}),
            ...('title' in event ? { title: event.title || existing.title } : {}),
            ...('detail' in event ? { detail: event.detail } : {}),
            ...('companyName' in event ? { companyName: event.companyName } : {}),
            ...('jobTitle' in event ? { jobTitle: event.jobTitle } : {}),
            ...('jobUrl' in event ? { jobUrl: event.jobUrl } : {}),
            ...('fieldCount' in event ? { fieldCount: event.fieldCount } : {}),
            ...('decisionCount' in event ? { decisionCount: event.decisionCount } : {}),
            ...('errorCount' in event ? { errorCount: event.errorCount } : {}),
            status: event.status || existing.status,
            lastUpdatedAt: event.timestamp,
            endedAt: ['completed', 'failed'].includes(event.status) ? event.timestamp : existing.endedAt || null
        };

        agent.branchMap = branchMap;
        refreshAgentBranches(agent);
        updateAgent(agent, {
            branches: agent.branches,
            lastMessage: event.detail || existing.detail || agent.lastMessage
        });
        return;
    }

    if (event.kind === 'keyword') {
        updateAgent(agent, {
            currentKeyword: event.status === 'completed' ? null : event.keyword,
            lastMessage: `${event.status === 'completed' ? 'Finished' : 'Working'} keyword: ${event.keyword}`
        });
        return;
    }

    if (event.kind === 'result') {
        applyResultMetrics(agent, event.status || '');
        updateAgent(agent, {
            currentActivity: {
                stage: 'result',
                message: `${event.status}: ${event.jobTitle || 'Unknown role'} @ ${event.companyName || 'Unknown company'}`,
                companyName: event.companyName || null,
                jobTitle: event.jobTitle || null,
                jobUrl: event.jobUrl || null,
                updatedAt: event.timestamp
            },
            lastMessage: `${event.status}: ${event.jobTitle || 'Unknown role'} @ ${event.companyName || 'Unknown company'}`
        });
    }
}

function consumeProcessChunk(agent, chunk, isErrorStream = false) {
    const key = isErrorStream ? 'stderrBuffer' : 'stdoutBuffer';
    agent[key] += chunk;
    const lines = agent[key].split(/\r?\n/);
    agent[key] = lines.pop() || '';

    lines.forEach(line => {
        if (!line.trim()) return;

        if (line.startsWith('[AGENT_EVENT] ')) {
            try {
                handleAgentEvent(agent, JSON.parse(line.slice(14)));
            } catch (error) {
                appendGlobalLog(`[SERVER] Failed to parse agent event for ${agent.id}: ${error.message}`, agent.id);
            }
            return;
        }

        const cleanLine = stripAnsi(line);
        agent.logs.push(cleanLine);
        if (agent.logs.length > MAX_AGENT_LOG_LINES) {
            agent.logs = agent.logs.slice(-MAX_AGENT_LOG_LINES);
        }

        updateAgent(agent, {
            lastMessage: cleanLine,
            status: agent.status === 'queued' ? 'starting' : agent.status
        });

        appendGlobalLog(cleanLine, agent.id);
    });
}

function finalizeRunIfDone() {
    const liveAgents = Object.values(orchestrator.agents).filter(agent => agent.process && !agent.process.killed && agent.exitCode === null);
    if (liveAgents.length > 0) return;

    orchestrator.running = false;
    orchestrator.endedAt = new Date().toISOString();
    broadcastState();
}

function clearDemoTimers() {
    demoTimers.forEach(timer => clearTimeout(timer));
    demoTimers = [];
}

function scheduleDemo(delayMs, fn) {
    const timer = setTimeout(() => {
        demoTimers = demoTimers.filter(entry => entry !== timer);
        fn();
    }, delayMs);
    demoTimers.push(timer);
}

function createDemoAgent(index, keywords) {
    const agentId = `agent-${index}`;
    const timestamp = new Date().toISOString();
    return {
        id: agentId,
        index,
        pid: null,
        process: null,
        keywords,
        currentKeyword: keywords[0] || null,
        headless: true,
        userDataDir: path.join(AGENT_PROFILE_ROOT, agentId),
        status: 'queued',
        startedAt: timestamp,
        endedAt: null,
        lastEventAt: timestamp,
        lastMessage: 'Queued',
        currentActivity: null,
        error: null,
        exitCode: null,
        stdoutBuffer: '',
        stderrBuffer: '',
        branchMap: {},
        branches: [],
        logs: [],
        metrics: {
            applied: 0,
            external: 0,
            skipped: 0,
            failed: 0,
            rateLimited: 0
        }
    };
}

function emitDemoEvent(agent, event) {
    const timestampedEvent = {
        ...event,
        timestamp: event.timestamp || new Date().toISOString()
    };

    if (timestampedEvent.kind === 'result') {
        appendGlobalLog(
            `[DEMO] ${agent.id} ${timestampedEvent.status} ${timestampedEvent.jobTitle || 'role'} @ ${timestampedEvent.companyName || 'company'}`,
            agent.id
        );
    } else if (timestampedEvent.kind === 'activity' && timestampedEvent.message) {
        appendGlobalLog(`[DEMO] ${agent.id} ${timestampedEvent.message}`, agent.id);
    }

    handleAgentEvent(agent, timestampedEvent);
}

function startDemoOrchestrator() {
    if (orchestrator.running) {
        return { success: false, message: 'Pipeline is already running.' };
    }

    clearDemoTimers();
    const config = getConfig();
    const activeKw = (config.activeKeywords || []).filter(Boolean);
    const kw1 = activeKw[0] || 'keyword 1';
    const kw2 = activeKw[1] || activeKw[0] || 'keyword 2';
    const kw3 = activeKw[2] || activeKw[0] || 'keyword 3';
    const agentCount = Math.min(3, Math.max(1, activeKw.length || 1));

    orchestrator = createOrchestratorState();
    orchestrator.runId = Date.now();
    orchestrator.running = true;
    orchestrator.startedAt = new Date().toISOString();
    orchestrator.requestedAgents = agentCount;
    orchestrator.plannedAgents = agentCount;

    const kwList = [kw1, kw2, kw3].slice(0, agentCount);
    const demoAgents = kwList.map((kw, i) => createDemoAgent(i + 1, [kw]));

    demoAgents.forEach(agent => {
        orchestrator.agents[agent.id] = agent;
        broadcast({ type: 'agent', agent: getAgentSnapshot(agent) });
    });

    appendGlobalLog('[DEMO] Starting synthetic showcase run. No real job applications will be opened or submitted.');
    broadcastState();

    const fakeCompanies = ['Pixel Rocket', 'Replay Systems', 'Boomstack', 'Regression Labs', 'NovaTech', 'Arclight'];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const allSequences = [
        (agent, kw) => [
            [800,   { kind: 'status', status: 'starting' }],
            [1600,  { kind: 'status', status: 'running' }],
            [2400,  { kind: 'keyword', keyword: kw, status: 'active' }],
            [3200,  { kind: 'activity', stage: 'working', message: `Scanning mock listings for ${kw}`, keyword: kw }],
            [5000,  { kind: 'branch', branchId: `demo-${agent.index}-branch`, branchType: 'screen', title: 'Resume match', detail: 'Checking stack fit', status: 'active' }],
            [7000,  { kind: 'result', status: 'APPLIED', jobTitle: kw, companyName: pick(fakeCompanies), jobUrl: 'https://example.test/job' }],
            [14000, { kind: 'activity', stage: 'working', message: `Queueing next fake ${kw} job`, keyword: kw }],
            [30000, { kind: 'status', status: 'completed' }],
        ],
        (agent, kw) => [
            [1200,  { kind: 'status', status: 'starting' }],
            [2000,  { kind: 'status', status: 'running' }],
            [2800,  { kind: 'keyword', keyword: kw, status: 'active' }],
            [4000,  { kind: 'activity', stage: 'working', message: `Filling fake ${kw} form`, keyword: kw }],
            [6000,  { kind: 'branch', branchId: `demo-${agent.index}-branch`, branchType: 'apply', title: 'Application branch', detail: 'Validating mock form', status: 'active' }],
            [14500, { kind: 'result', status: 'FAILED', jobTitle: kw, companyName: pick(fakeCompanies), jobUrl: 'https://example.test/job' }],
            [17000, { kind: 'activity', stage: 'working', message: `Recovering after rejected ${kw} shot`, keyword: kw }],
            [22000, { kind: 'result', status: 'APPLIED_EXTERNAL', jobTitle: `Senior ${kw}`, companyName: pick(fakeCompanies), jobUrl: 'https://example.test/job' }],
            [30000, { kind: 'status', status: 'completed' }],
        ],
        (agent, kw) => [
            [1500,  { kind: 'status', status: 'starting' }],
            [2400,  { kind: 'status', status: 'running' }],
            [3600,  { kind: 'keyword', keyword: kw, status: 'active' }],
            [5500,  { kind: 'activity', stage: 'working', message: `Evaluating demo ${kw} posting`, keyword: kw }],
            [8000,  { kind: 'branch', branchId: `demo-${agent.index}-branch`, branchType: 'ai', title: 'AI assist', detail: 'Generating mock answers', status: 'active' }],
            [28000, { kind: 'result', status: 'APPLIED', jobTitle: kw, companyName: pick(fakeCompanies), jobUrl: 'https://example.test/job' }],
            [34000, { kind: 'status', status: 'completed' }],
        ],
    ];

    const sequences = demoAgents.map((agent, i) => ({
        agent,
        steps: allSequences[i % allSequences.length](agent, kwList[i])
    }));

    sequences.forEach(({ agent, steps }) => {
        steps.forEach(([delayMs, event]) => {
            scheduleDemo(delayMs, () => emitDemoEvent(agent, event));
        });
    });

    scheduleDemo(36000, () => {
        clearDemoTimers();
        orchestrator.running = false;
        orchestrator.endedAt = new Date().toISOString();
        appendGlobalLog('[DEMO] Synthetic showcase finished.');
        broadcastState();
    });

    return {
        success: true,
        state: getOrchestratorSnapshot()
    };
}

function spawnAgent(index, keywords, config) {
    const agentId = `agent-${index}`;
    const userDataDir = ensureAgentProfile(agentId);
    const agent = {
        id: agentId,
        index,
        pid: null,
        process: null,
        keywords,
        currentKeyword: null,
        headless: !!config.headless,
        userDataDir,
        status: 'queued',
        startedAt: null,
        endedAt: null,
        lastEventAt: null,
        lastMessage: 'Queued',
        currentActivity: null,
        error: null,
        exitCode: null,
        stdoutBuffer: '',
        stderrBuffer: '',
        branchMap: {},
        branches: [],
        logs: [],
        metrics: {
            applied: 0,
            external: 0,
            skipped: 0,
            failed: 0,
            rateLimited: 0
        }
    };

    const child = spawn(process.execPath, ['index.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            AGENT_ID: agentId,
            AGENT_INDEX: String(index),
            ACTIVE_KEYWORDS_JSON: JSON.stringify(keywords),
            APPLY_MODE: config.applyMode,
            HEADLESS: String(!!config.headless),
            USER_DATA_DIR: userDataDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    agent.pid = child.pid;
    agent.process = child;
    agent.status = 'starting';
    agent.startedAt = new Date().toISOString();
    orchestrator.agents[agentId] = agent;

    child.stdout.on('data', data => consumeProcessChunk(agent, data.toString(), false));
    child.stderr.on('data', data => consumeProcessChunk(agent, `[ERR] ${data.toString()}`, true));

    child.on('exit', code => {
        agent.exitCode = code;
        const stopDriven = orchestrator.stopRequested;
        updateAgent(agent, {
            status: stopDriven ? 'stopped' : code === 0 ? 'completed' : 'failed',
            endedAt: new Date().toISOString(),
            error: code === 0 || stopDriven ? null : `Process exited with code ${code}`
        });
        appendGlobalLog(`[SERVER] ${agent.id} exited with code ${code}`, agent.id);
        finalizeRunIfDone();
    });

    child.on('error', error => {
        agent.exitCode = 1;
        updateAgent(agent, {
            status: 'failed',
            endedAt: new Date().toISOString(),
            error: error.message
        });
        appendGlobalLog(`[SERVER] ${agent.id} failed to start: ${error.message}`, agent.id);
        finalizeRunIfDone();
    });

    broadcast({ type: 'agent', agent: getAgentSnapshot(agent) });
    appendGlobalLog(`[SERVER] Spawned ${agent.id} for keywords: ${keywords.join(', ')}`, agent.id);
}

function startOrchestrator() {
    if (orchestrator.running) {
        return { success: false, message: 'Pipeline is already running.' };
    }

    const config = getConfig();
    const activeKeywords = (config.activeKeywords || []).filter(Boolean);
    if (activeKeywords.length === 0) {
        return { success: false, message: 'Add at least one active keyword before starting.' };
    }

    const requestedAgents = Math.max(1, Number.parseInt(config.maxConcurrentAgents || 1, 10) || 1);
    const lanes = partitionKeywords(activeKeywords, requestedAgents);

    orchestrator = createOrchestratorState();
    orchestrator.runId = Date.now();
    orchestrator.running = true;
    orchestrator.startedAt = new Date().toISOString();
    orchestrator.requestedAgents = requestedAgents;
    orchestrator.plannedAgents = lanes.length;

    appendGlobalLog(`[SERVER] Starting Symphony-style run with ${lanes.length} agent(s) across ${activeKeywords.length} keyword lane(s).`);
    lanes.forEach((keywords, index) => spawnAgent(index + 1, keywords, config));
    broadcastState();

    return {
        success: true,
        state: getOrchestratorSnapshot()
    };
}

function stopOrchestrator() {
    if (!orchestrator.running) {
        return { success: false, message: 'No pipeline running.' };
    }

    orchestrator.stopRequested = true;
    clearDemoTimers();
    Object.values(orchestrator.agents).forEach(agent => {
        if (!agent.process) {
            updateAgent(agent, {
                status: 'stopped',
                endedAt: new Date().toISOString(),
                exitCode: agent.exitCode ?? 0
            });
            return;
        }
        if (agent.exitCode !== null) return;
        try {
            agent.process.kill('SIGTERM');
            setTimeout(() => {
                if (agent.process && agent.exitCode === null) {
                    agent.process.kill('SIGKILL');
                }
            }, 3000);
        } catch (error) {
        }
    });

    appendGlobalLog('[SERVER] Stop requested for all agents.');
    const liveAgents = Object.values(orchestrator.agents).filter(agent => agent.process && agent.exitCode === null);
    if (liveAgents.length === 0) {
        orchestrator.running = false;
        orchestrator.endedAt = new Date().toISOString();
    }
    broadcastState();
    return { success: true };
}

app.get('/api/config', (req, res) => {
    res.json(getConfig());
});

app.post('/api/config', (req, res) => {
    const updated = { ...getConfig(), ...req.body };
    saveConfig(updated);
    res.json({ success: true, config: updated });
});

app.get('/api/stats', (req, res) => {
    const daily = getDailyStats();
    const totals = getTotalStats();
    res.json({ daily, ...totals });
});

app.get('/api/status', (req, res) => {
    const snapshot = getOrchestratorSnapshot();
    res.json({
        running: snapshot.running,
        activeAgents: snapshot.activeAgents,
        plannedAgents: snapshot.plannedAgents
    });
});

app.get('/api/orchestrator', (req, res) => {
    res.json(getOrchestratorSnapshot());
});

app.post('/api/start', (req, res) => {
    const result = startOrchestrator();
    if (!result.success) {
        return res.status(409).json(result);
    }
    res.json(result);
});

app.post('/api/demo/start', (req, res) => {
    const result = startDemoOrchestrator();
    if (!result.success) {
        return res.status(409).json(result);
    }
    res.json(result);
});

app.post('/api/stop', (req, res) => {
    res.json(stopOrchestrator());
});

app.post('/api/agent/:id/focus', (req, res) => {
    const agent = orchestrator.agents[req.params.id];
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found.' });
    if (!agent.pid) return res.status(400).json({ success: false, message: 'Agent has no PID (demo agent or not running).' });
    if (agent.headless) return res.status(400).json({ success: false, message: 'Agent is running headless — no browser window to show.' });

    const ps = `
        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class WinApi {
            [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
            [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        }
"@
        $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${agent.userDataDir.replace(/\\/g, '\\\\')}*' }
        foreach ($p in $procs) {
            $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
            if ($proc -and $proc.MainWindowHandle -ne 0) {
                [WinApi]::ShowWindow($proc.MainWindowHandle, 9)
                [WinApi]::SetForegroundWindow($proc.MainWindowHandle)
                break
            }
        }
    `.trim();

    const { exec } = require('child_process');
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 5000 }, (err) => {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true });
    });
});

app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'status', running: orchestrator.running })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'orchestrator', state: getOrchestratorSnapshot() })}\n\n`);

    sseClients.push(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(': heartbeat\n\n');
        } catch (error) {
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients = sseClients.filter(client => client !== res);
    });
});

app.get('/api/logs/history', (req, res) => {
    if (!fs.existsSync(APPLIED_LOG)) return res.json({ lines: [] });
    const lines = fs.readFileSync(APPLIED_LOG, 'utf8')
        .split('\n')
        .filter(line => line.trim())
        .slice(-100);
    res.json({ lines });
});

app.listen(PORT, () => {
    console.log('\x1b[32m');
    console.log('┌───────────────────────────────────────────┐');
    console.log('│  AutoApply Symphony Dashboard            │');
    console.log(`│  Open: http://localhost:${PORT}               │`);
    console.log('└───────────────────────────────────────────┘');
    console.log('\x1b[0m');
});
