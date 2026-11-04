const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const exporter = require('./exporter.js');

const PORT = parseInt(process.env.PORT || '8090', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

// Candidate paths where brain & agent definitions can live
const BRAIN_CANDIDATES = [
  '/root/.gemini/antigravity-cli/brain',
  '/app/data/mirror/brain',
  path.join(__dirname, 'data', 'mirror', 'brain'),
  '/agy-data/brain'
];

const AGENTS_CANDIDATES = [
  '/root/.gemini/config/agents',
  '/app/data/mirror/agents',
  path.join(__dirname, 'data', 'mirror', 'agents'),
  '/agy-data/agents'
];

// Cache for parsed transcripts: cid -> { mtimeMs, size, parsed }
const transcriptCache = new Map();
let lastDockerSyncTime = 0;
let dockerSyncInFlight = false;
let dockerStatus = { connected: false, containerName: null, lastSync: null };

/**
 * Trigger incremental sync inside the antigravity container via /var/run/docker.sock
 * if we are running in a separate container on the host.
 */
function triggerDockerSyncIfNeeded() {
  if (fs.existsSync('/root/.gemini/antigravity-cli/brain')) {
    dockerStatus = { connected: true, containerName: 'local-direct', lastSync: new Date().toISOString() };
    return Promise.resolve();
  }
  if (!fs.existsSync(DOCKER_SOCKET)) {
    return Promise.resolve();
  }
  const now = Date.now();
  if (dockerSyncInFlight || now - lastDockerSyncTime < 2000) {
    return Promise.resolve();
  }
  dockerSyncInFlight = true;
  lastDockerSyncTime = now;

  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: '/containers/json',
        method: 'GET',
        timeout: 1500
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const containers = JSON.parse(raw);
            const agy = containers.find((c) => {
              const names = (c.Names || []).join(' ').toLowerCase();
              const mounts = c.Mounts || [];
              return (
                names.includes('antigravity') ||
                mounts.some((m) => m.Destination === '/root/.gemini/antigravity-cli')
              );
            });
            if (!agy) {
              dockerSyncInFlight = false;
              return resolve();
            }
            dockerStatus.connected = true;
            dockerStatus.containerName = (agy.Names && agy.Names[0] || agy.Id).replace(/^\//, '');

            // Create exec instance to run sync_from_agy.py --once
            const execPayload = JSON.stringify({
              AttachStdout: true,
              AttachStderr: true,
              Cmd: ['python3', '/workspace/agent-monitor/sync_from_agy.py', '--once']
            });
            const execReq = http.request(
              {
                socketPath: DOCKER_SOCKET,
                path: `/containers/${agy.Id}/exec`,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(execPayload)
                },
                timeout: 2000
              },
              (execRes) => {
                let execRaw = '';
                execRes.on('data', (d) => (execRaw += d));
                execRes.on('end', () => {
                  try {
                    const execObj = JSON.parse(execRaw);
                    if (!execObj.Id) {
                      dockerSyncInFlight = false;
                      return resolve();
                    }
                    const startPayload = JSON.stringify({ Detach: false, Tty: false });
                    const startReq = http.request(
                      {
                        socketPath: DOCKER_SOCKET,
                        path: `/exec/${execObj.Id}/start`,
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Content-Length': Buffer.byteLength(startPayload)
                        },
                        timeout: 3000
                      },
                      (startRes) => {
                        startRes.on('data', () => {});
                        startRes.on('end', () => {
                          dockerStatus.lastSync = new Date().toISOString();
                          dockerSyncInFlight = false;
                          resolve();
                        });
                      }
                    );
                    startReq.on('error', () => {
                      dockerSyncInFlight = false;
                      resolve();
                    });
                    startReq.write(startPayload);
                    startReq.end();
                  } catch (e) {
                    dockerSyncInFlight = false;
                    resolve();
                  }
                });
              }
            );
            execReq.on('error', () => {
              dockerSyncInFlight = false;
              resolve();
            });
            execReq.write(execPayload);
            execReq.end();
          } catch (e) {
            dockerSyncInFlight = false;
            resolve();
          }
        });
      }
    );
    req.on('error', () => {
      dockerSyncInFlight = false;
      resolve();
    });
    req.end();
  });
}

function getBrainDir() {
  for (const dir of BRAIN_CANDIDATES) {
    if (fs.existsSync(dir)) {
      try {
        const entries = fs.readdirSync(dir);
        if (entries.length > 0) return dir;
      } catch (e) {}
    }
  }
  return BRAIN_CANDIDATES[1];
}

function getAgentsDir() {
  for (const dir of AGENTS_CANDIDATES) {
    if (fs.existsSync(dir)) return dir;
  }
  return AGENTS_CANDIDATES[1];
}

function resolveTranscriptPath(brainDir, cid) {
  const direct = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(direct)) return direct;
  const mirrored = path.join(brainDir, cid, 'transcript.jsonl');
  if (fs.existsSync(mirrored)) return mirrored;
  return null;
}

function parseAgentMarkdown(filePath, scope = 'global') {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    let name = path.basename(path.dirname(filePath));
    let description = '';
    let model = 'inherit';
    let tools = [];
    let body = raw;

    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (fmMatch) {
      const fm = fmMatch[1];
      body = fmMatch[2].trim();
      const nameM = fm.match(/^name:\s*(.+)$/m);
      if (nameM) name = nameM[1].trim();
      const descM = fm.match(/^description:\s*(.+)$/m);
      if (descM) description = descM[1].trim();
      const modelM = fm.match(/^model:\s*(.+)$/m);
      if (modelM) model = modelM[1].trim();
      const toolMatches = [...fm.matchAll(/^\s*-\s*([a-zA-Z0-9_-]+)\s*$/gm)];
      tools = toolMatches.map((m) => m[1]);
    }
    return { name, description, model, tools, systemPrompt: body, scope };
  } catch (e) {
    return null;
  }
}

function loadAllAgentProfiles() {
  const profiles = [];
  const seen = new Set();
  const agentsDir = getAgentsDir();
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const mdPath = path.join(agentsDir, entry.name, 'agent.md');
        if (fs.existsSync(mdPath)) {
          const parsed = parseAgentMarkdown(mdPath, 'global');
          if (parsed && !seen.has(parsed.name)) {
            seen.add(parsed.name);
            profiles.push(parsed);
          }
        }
      }
    }
  }
  return profiles;
}

function cleanUserInput(text) {
  if (!text) return '';
  const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (m) return m[1].trim();
  return text.trim();
}

function unwrapArg(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'string') return String(val);
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch (e) {
      s = s.slice(1, -1);
    }
  } else if (s.startsWith('"')) {
    s = s.slice(1);
  }
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseSystemMessage(text) {
  if (!text || !text.includes('<SYSTEM_MESSAGE>')) return null;
  const innerMatch = text.match(/<SYSTEM_MESSAGE>\s*([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/);
  const body = innerMatch ? innerMatch[1].trim() : text;
  const msgMatch = body.match(/^\[Message\]\s+timestamp=([^\s]+)\s+sender=([^\s]+)\s+priority=([^\s]+)\s+content=([\s\S]*)$/);
  if (msgMatch) {
    return {
      timestamp: msgMatch[1],
      sender: msgMatch[2],
      priority: msgMatch[3],
      content: msgMatch[4].replace(/<\/SYSTEM_MESSAGE>\s*$/, '').trim()
    };
  }
  return null;
}

const IGNORED_WORKSPACE_DIRS = new Set([
  '.pytest_cache',
  'venv',
  'test_venv',
  'node_modules',
  '.git',
  'agent-monitor'
]);

function detectProjectsFromText(text, projectCounts) {
  if (!text) return;
  const regex = /\/workspace\/([^/\s"'`<>\\]+)/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const folder = m[1].trim();
    if (
      folder &&
      !folder.startsWith('.') &&
      !IGNORED_WORKSPACE_DIRS.has(folder) &&
      !folder.endsWith('.py') &&
      !folder.endsWith('.js') &&
      !folder.endsWith('.md') &&
      !folder.endsWith('.json')
    ) {
      projectCounts.set(folder, (projectCounts.get(folder) || 0) + 1);
    }
  }
}

function parseTranscriptFile(cid, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return null;
  }

  const cached = transcriptCache.get(cid);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed;
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const steps = [];
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line));
    } catch (e) {}
  }

  let firstTimestamp = null;
  let lastTimestamp = null;
  let parentIdFromStep0 = null;
  let initialTaskPrompt = null;
  let firstUserPrompt = null;
  let activeModel = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastActionSummary = '';
  let killedSubagents = false;
  let lastKillTimestamp = null;

  const projectCounts = new Map();
  const subagentInvocations = []; // { stepIndex, timestamp, typeName, role, model, prompt, workspace, childId }
  const outgoingMessages = []; // { stepIndex, timestamp, recipient, content, summary }
  const incomingMessages = []; // { stepIndex, timestamp, sender, content, priority }
  const definedAgents = []; // { stepIndex, timestamp, name, description, systemPrompt }
  const userInteractions = []; // { stepIndex, timestamp, kind: 'USER_PROMPT' | 'AGENT_TO_USER', content }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const ts = s.created_at || null;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    if (s.input_tokens) totalInputTokens += s.input_tokens;
    if (s.output_tokens) totalOutputTokens += s.output_tokens;

    const rawContent = s.content || '';
    detectProjectsFromText(rawContent, projectCounts);

    // Check model change in user settings metadata
    const modelChangeMatch = rawContent.match(/changed setting `Model Selection` from [^\n]+? to ([^\n.]+)/);
    if (modelChangeMatch) {
      activeModel = modelChangeMatch[1].trim();
    }

    if (s.type === 'USER_INPUT') {
      const cleanedPrompt = cleanUserInput(rawContent);
      if (!firstUserPrompt) {
        firstUserPrompt = cleanedPrompt;
      }
      if (cleanedPrompt) {
        userInteractions.push({
          stepIndex: s.step_index ?? i,
          timestamp: ts,
          kind: 'USER_PROMPT',
          content: cleanedPrompt
        });
      }
    }

    if (s.type === 'PLANNER_RESPONSE' && rawContent.trim().length > 0) {
      userInteractions.push({
        stepIndex: s.step_index ?? i,
        timestamp: ts,
        kind: 'AGENT_TO_USER',
        content: rawContent.trim()
      });
    }

    if (s.type === 'SYSTEM_MESSAGE') {
      const sysMsg = parseSystemMessage(rawContent);
      if (sysMsg) {
        // Ignore internal background command task wakeups like "<cid>/task-94"
        if (!sysMsg.sender.includes('/task-')) {
          if (i === 0) {
            parentIdFromStep0 = sysMsg.sender;
            initialTaskPrompt = sysMsg.content;
          }
          incomingMessages.push({
            stepIndex: s.step_index ?? i,
            timestamp: sysMsg.timestamp || ts,
            sender: sysMsg.sender,
            content: sysMsg.content,
            priority: sysMsg.priority
          });
        }
      }
    }

    if (s.type === 'GENERIC' && rawContent.includes('Successfully killed')) {
      killedSubagents = true;
      lastKillTimestamp = ts;
    }

    const toolCalls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
    for (const tc of toolCalls) {
      const tName = tc.name || '';
      const args = tc.args || {};
      detectProjectsFromText(JSON.stringify(args), projectCounts);

      if (tName === 'invoke_subagent') {
        const roleVal = unwrapArg(args.Role || args.TypeName || 'Subagent');
        const typeVal = unwrapArg(args.TypeName || 'subagent');
        const modelVal = unwrapArg(args.Model || 'inherit');
        const promptVal = unwrapArg(args.Prompt || '');
        const wsVal = unwrapArg(args.Workspace || 'inherit');
        subagentInvocations.push({
          stepIndex: s.step_index ?? i,
          timestamp: ts,
          typeName: typeVal,
          role: roleVal,
          model: modelVal,
          prompt: promptVal,
          workspace: wsVal,
          childId: null,
          failed: false
        });
        lastActionSummary = `Alt ajan başlatıldı: ${roleVal}`;
      } else if (tName === 'send_message') {
        const recVal = unwrapArg(args.Recipient || '');
        const msgVal = unwrapArg(args.Message || '');
        const sumVal = unwrapArg(args.toolSummary || 'Mesaj gönderildi');
        outgoingMessages.push({
          stepIndex: s.step_index ?? i,
          timestamp: ts,
          recipient: recVal,
          content: msgVal,
          summary: sumVal
        });
        lastActionSummary = `Mesaj gönderildi -> ${recVal.slice(0, 8)}`;
      } else if (tName === 'define_subagent') {
        const nameVal = unwrapArg(args.Name || 'custom-agent');
        definedAgents.push({
          stepIndex: s.step_index ?? i,
          timestamp: ts,
          name: nameVal,
          description: unwrapArg(args.Description || ''),
          systemPrompt: unwrapArg(args.SystemPrompt || '')
        });
        lastActionSummary = `Yeni ajan tanımlandı: ${nameVal}`;
      } else if (tName) {
        const pathArg = unwrapArg(args.Path || '');
        const sumArg = unwrapArg(args.toolSummary || '');
        const targetFile = pathArg ? path.basename(pathArg) : '';
        lastActionSummary = `${tName}${targetFile ? `: ${targetFile}` : sumArg ? ` (${sumArg})` : ''}`;
      }
    }

    // Mark failed invoke_subagent steps if GENERIC output shows an execution error
    if (s.type === 'GENERIC' && rawContent.includes('Encountered error in step execution') && rawContent.includes('subagent')) {
      const unmatched = subagentInvocations.find((inv) => !inv.childId && !inv.failed && inv.stepIndex <= (s.step_index ?? i));
      if (unmatched) {
        unmatched.failed = true;
      }
    }

    // Match GENERIC outputs that contain "Created the following subagent: { "conversationId": "..." }"
    if (s.type === 'GENERIC' && rawContent.includes('Created the following subagent:')) {
      const cidMatch = rawContent.match(/"conversationId"\s*:\s*"([^"]+)"/);
      if (cidMatch) {
        const createdCid = cidMatch[1];
        const unmatched = subagentInvocations.find((inv) => !inv.childId && !inv.failed && inv.stepIndex <= (s.step_index ?? i));
        if (unmatched) {
          unmatched.childId = createdCid;
        }
      }
    }
  }

  // Determine base turn state of this agent/conversation
  const lastStep = steps[steps.length - 1];
  const lastStepHasToolCalls = Boolean(
    lastStep && lastStep.type === 'PLANNER_RESPONSE' && Array.isArray(lastStep.tool_calls) && lastStep.tool_calls.length > 0
  );
  const finishedTurn = Boolean(
    lastStep && lastStep.type === 'PLANNER_RESPONSE' && (!lastStep.tool_calls || lastStep.tool_calls.length === 0)
  );

  const parsed = {
    id: cid,
    mtimeMs: stat.mtimeMs,
    stepCount: steps.length,
    firstTimestamp,
    lastTimestamp: lastTimestamp || new Date(stat.mtimeMs).toISOString(),
    parentIdFromStep0,
    initialTaskPrompt,
    firstUserPrompt,
    activeModel,
    totalInputTokens,
    totalOutputTokens,
    lastActionSummary,
    killedSubagents,
    lastKillTimestamp,
    lastStepHasToolCalls,
    finishedTurn,
    projectCounts: Object.fromEntries(projectCounts),
    subagentInvocations,
    outgoingMessages,
    incomingMessages,
    definedAgents,
    userInteractions
  };

  transcriptCache.set(cid, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

function computeDynamicStatus(conv, parentConv = null) {
  if (!conv) return 'completed';
  // If parent explicitly killed subagents after this subagent started, it is completed/terminated
  if (parentConv && parentConv.lastKillTimestamp && conv.firstTimestamp) {
    if (new Date(parentConv.lastKillTimestamp).getTime() >= new Date(conv.firstTimestamp).getTime()) {
      return 'completed';
    }
  }
  const ageSeconds = (Date.now() - conv.mtimeMs) / 1000;
  if (conv.finishedTurn && ageSeconds > 12) {
    return 'completed';
  }
  if (ageSeconds < 40) {
    return 'running';
  }
  if (conv.lastStepHasToolCalls && ageSeconds < 180) {
    return 'running';
  }
  return 'completed';
}

function buildWorldState() {
  const brainDir = getBrainDir();
  const allConvMap = new Map();

  if (fs.existsSync(brainDir)) {
    for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cid = entry.name;
      const tPath = resolveTranscriptPath(brainDir, cid);
      if (!tPath) continue;
      const parsed = parseTranscriptFile(cid, tPath);
      if (parsed && parsed.stepCount > 0) {
        allConvMap.set(cid, parsed);
      }
    }
  }

  // Link parent-child relationships across all conversations
  const parentOf = new Map(); // childId -> { parentId, invocation }
  const childrenOf = new Map(); // parentId -> [childId, ...]

  for (const [cid, conv] of allConvMap.entries()) {
    for (const inv of conv.subagentInvocations) {
      if (inv.childId && allConvMap.has(inv.childId)) {
        parentOf.set(inv.childId, { parentId: cid, invocation: inv });
        if (!childrenOf.has(cid)) childrenOf.set(cid, []);
        if (!childrenOf.get(cid).includes(inv.childId)) {
          childrenOf.get(cid).push(inv.childId);
        }
      }
    }
  }

  // Fallback linkage via child's step 0 SYSTEM_MESSAGE sender
  for (const [cid, conv] of allConvMap.entries()) {
    if (conv.parentIdFromStep0 && allConvMap.has(conv.parentIdFromStep0) && !parentOf.has(cid)) {
      const pConv = allConvMap.get(conv.parentIdFromStep0);
      // Try matching by prompt prefix
      const matchedInv = pConv.subagentInvocations.find(
        (inv) =>
          !inv.childId &&
          conv.initialTaskPrompt &&
          inv.prompt &&
          conv.initialTaskPrompt.slice(0, 80) === inv.prompt.slice(0, 80)
      );
      if (matchedInv) matchedInv.childId = cid;
      parentOf.set(cid, {
        parentId: conv.parentIdFromStep0,
        invocation: matchedInv || {
          typeName: 'subagent',
          role: 'Subagent',
          model: 'inherit',
          prompt: conv.initialTaskPrompt || '',
          workspace: 'inherit',
          timestamp: conv.firstTimestamp
        }
      });
      if (!childrenOf.has(conv.parentIdFromStep0)) childrenOf.set(conv.parentIdFromStep0, []);
      if (!childrenOf.get(conv.parentIdFromStep0).includes(cid)) {
        childrenOf.get(conv.parentIdFromStep0).push(cid);
      }
    }
  }

  // Group into Root Sessions (each root conversation + all its descendant subagents)
  const sessions = [];
  for (const [cid, conv] of allConvMap.entries()) {
    if (parentOf.has(cid)) continue; // Only start from root conversations

    // Collect all descendants via BFS with depth tracking
    const descendantIds = [];
    const depthOf = new Map([[cid, 0]]);
    const queue = [...(childrenOf.get(cid) || []).map((k) => ({ id: k, depth: 1 }))];
    const visited = new Set([cid]);
    while (queue.length > 0) {
      const { id: curr, depth } = queue.shift();
      if (visited.has(curr)) continue;
      visited.add(curr);
      depthOf.set(curr, depth);
      descendantIds.push(curr);
      const kids = childrenOf.get(curr) || [];
      for (const k of kids) queue.push({ id: k, depth: depth + 1 });
    }

    // Aggregate project counts across root + descendants
    const mergedProjects = new Map();
    const allIdsInSession = [cid, ...descendantIds];
    let latestMtime = conv.mtimeMs;
    let totalSteps = 0;
    let totalTokens = 0;

    for (const id of allIdsInSession) {
      const c = allConvMap.get(id);
      if (!c) continue;
      if (c.mtimeMs > latestMtime) latestMtime = c.mtimeMs;
      totalSteps += c.stepCount;
      totalTokens += (c.totalInputTokens || 0) + (c.totalOutputTokens || 0);
      for (const [proj, cnt] of Object.entries(c.projectCounts || {})) {
        mergedProjects.set(proj, (mergedProjects.get(proj) || 0) + cnt);
      }
    }

    // Pick top project name
    let projectName = 'Genel / Sohbet';
    let bestCount = 0;
    for (const [proj, cnt] of mergedProjects.entries()) {
      if (cnt > bestCount) {
        bestCount = cnt;
        projectName = proj;
      }
    }

    // Build agent nodes list for this session
    const agents = [];
    const childStatuses = descendantIds.map((dId) => {
      const dConv = allConvMap.get(dId);
      const link = parentOf.get(dId);
      const pConv = link ? allConvMap.get(link.parentId) : conv;
      return computeDynamicStatus(dConv, pConv);
    });
    const ownRootStatus = computeDynamicStatus(conv, null);
    const rootStatus =
      childStatuses.some((st) => st === 'running') || ownRootStatus === 'running'
        ? 'running'
        : 'completed';

    agents.push({
      id: cid,
      isRoot: true,
      depth: 0,
      parentId: null,
      role: 'Ana Orkestratör (Main Agent)',
      typeName: 'orchestrator',
      model: conv.activeModel || 'Gemini (Main)',
      workspace: '/workspace',
      status: rootStatus,
      stepCount: conv.stepCount,
      firstTimestamp: conv.firstTimestamp,
      lastTimestamp: conv.lastTimestamp,
      lastActionSummary: conv.lastActionSummary || 'Kullanıcı ile iletişimde',
      tokens: (conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0)
    });

    for (let idx = 0; idx < descendantIds.length; idx++) {
      const dId = descendantIds[idx];
      const dConv = allConvMap.get(dId);
      const link = parentOf.get(dId);
      const inv = link ? link.invocation : {};
      const dStatus = childStatuses[idx];

      // Extract worktree or branch hint from prompt if present
      let workspaceLabel = inv.workspace || 'inherit';
      const wtMatch = (inv.prompt || '').match(/\/\.worktrees\/([a-zA-Z0-9_-]+)/);
      const branchMatch = (inv.prompt || '').match(/branch\s+`([^`]+)`/i);
      if (branchMatch) {
        workspaceLabel = branchMatch[1];
      } else if (wtMatch) {
        workspaceLabel = wtMatch[1];
      }

      agents.push({
        id: dId,
        isRoot: false,
        depth: depthOf.get(dId) || 1,
        parentId: link ? link.parentId : cid,
        role: inv.role || 'Subagent',
        typeName: inv.typeName || 'subagent',
        model: inv.model || 'inherit',
        workspace: workspaceLabel,
        status: dStatus,
        stepCount: dConv.stepCount,
        firstTimestamp: inv.timestamp || dConv.firstTimestamp,
        lastTimestamp: dConv.lastTimestamp,
        lastActionSummary: dConv.lastActionSummary || 'Görev işleniyor',
        tokens: (dConv.totalInputTokens || 0) + (dConv.totalOutputTokens || 0),
        taskPrompt: inv.prompt || dConv.initialTaskPrompt || ''
      });
    }

    // Build unified inter-agent messages list for this session
    const messages = [];
    const seenMessageKeys = new Set();

    const userMeta = {
      id: 'USER',
      role: '👤 Kullanıcı (User)',
      typeName: 'user',
      model: '',
      isRoot: false,
      isUser: true
    };

    const getAgentMeta = (agentId) => {
      if (agentId === 'USER') return userMeta;
      const found = agents.find((a) => a.id === agentId);
      if (found) return { id: found.id, role: found.role, typeName: found.typeName, model: found.model, isRoot: found.isRoot };
      return { id: agentId, role: `Ajan (${agentId.slice(0, 8)})`, typeName: 'agent', model: 'inherit', isRoot: false };
    };

    // 0. User <-> Root Orchestrator interactions (USER_PROMPT and AGENT_TO_USER)
    for (const ui of conv.userInteractions || []) {
      if (ui.kind === 'USER_PROMPT') {
        messages.push({
          id: `user-in:${cid}:${ui.stepIndex}`,
          kind: 'USER_PROMPT',
          flowType: 'USER_TO_AGENT',
          stepOrder: ui.stepIndex,
          timestamp: ui.timestamp || conv.firstTimestamp,
          sender: userMeta,
          recipient: getAgentMeta(cid),
          content: ui.content
        });
      } else if (ui.kind === 'AGENT_TO_USER') {
        messages.push({
          id: `user-out:${cid}:${ui.stepIndex}`,
          kind: 'AGENT_TO_USER',
          flowType: 'AGENT_TO_USER',
          stepOrder: ui.stepIndex,
          timestamp: ui.timestamp || conv.lastTimestamp,
          sender: getAgentMeta(cid),
          recipient: userMeta,
          content: ui.content
        });
      }
    }

    // 1. Task delegations (invoke_subagent)
    for (const id of allIdsInSession) {
      const c = allConvMap.get(id);
      if (!c) continue;
      for (const inv of c.subagentInvocations) {
        if (!inv.childId) continue;
        const key = `delegate:${id}:${inv.childId}:${inv.stepIndex}`;
        seenMessageKeys.add(key);
        messages.push({
          id: key,
          kind: 'TASK_DELEGATION',
          flowType: 'AGENT_TO_AGENT',
          timestamp: inv.timestamp || c.firstTimestamp,
          sender: getAgentMeta(id),
          recipient: getAgentMeta(inv.childId),
          model: inv.model || 'inherit',
          workspace: inv.workspace || 'inherit',
          content: inv.prompt || ''
        });
      }
    }

    // 2. Explicit send_message calls from any agent in the session
    for (const id of allIdsInSession) {
      const c = allConvMap.get(id);
      if (!c) continue;
      for (const out of c.outgoingMessages) {
        if (!out.recipient) continue;
        const sig = `${id}->${out.recipient}:${(out.content || '').slice(0, 120)}`;
        if (seenMessageKeys.has(sig)) continue;
        seenMessageKeys.add(sig);
        messages.push({
          id: `msg:${id}:${out.stepIndex}`,
          kind: 'AGENT_MESSAGE',
          flowType: 'AGENT_TO_AGENT',
          timestamp: out.timestamp || c.lastTimestamp,
          sender: getAgentMeta(id),
          recipient: getAgentMeta(out.recipient),
          summary: out.summary,
          content: out.content || ''
        });
      }
    }

    // 3. Incoming SYSTEM_MESSAGEs between agents that weren't already captured
    for (const id of allIdsInSession) {
      const c = allConvMap.get(id);
      if (!c) continue;
      for (const inc of c.incomingMessages) {
        if (inc.stepIndex === 0) continue; // Step 0 is initial task delegation already added above
        const sig = `${inc.sender}->${id}:${(inc.content || '').slice(0, 120)}`;
        if (seenMessageKeys.has(sig)) continue;
        seenMessageKeys.add(sig);
        messages.push({
          id: `sys:${id}:${inc.stepIndex}`,
          kind: 'AGENT_MESSAGE',
          flowType: 'AGENT_TO_AGENT',
          timestamp: inc.timestamp || c.lastTimestamp,
          sender: getAgentMeta(inc.sender),
          recipient: getAgentMeta(id),
          content: inc.content || ''
        });
      }
    }

    messages.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return (a.stepOrder ?? 0) - (b.stepOrder ?? 0);
    });

    const title =
      (conv.firstUserPrompt || '').split('\n')[0].slice(0, 95) ||
      `Oturum ${cid.slice(0, 8)}`;

    sessions.push({
      id: cid,
      title,
      project: projectName,
      isMultiAgent: agents.length > 1,
      agentCount: agents.length,
      messageCount: messages.length,
      totalSteps,
      totalTokens,
      status: rootStatus,
      mtimeMs: latestMtime,
      lastUpdated: new Date(latestMtime).toISOString(),
      agents,
      messages
    });
  }

  // Sort sessions: active multi-agent or most recently updated first
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Collect distinct project list with counts
  const projectMap = new Map();
  for (const s of sessions) {
    const prev = projectMap.get(s.project) || { name: s.project, sessionCount: 0, multiAgentCount: 0, lastMtime: 0 };
    prev.sessionCount += 1;
    if (s.isMultiAgent) prev.multiAgentCount += 1;
    if (s.mtimeMs > prev.lastMtime) prev.lastMtime = s.mtimeMs;
    projectMap.set(s.project, prev);
  }
  const projects = Array.from(projectMap.values()).sort((a, b) => b.lastMtime - a.lastMtime);

  return {
    serverTime: new Date().toISOString(),
    dockerStatus,
    brainDir,
    projects,
    sessions,
    agentProfiles: loadAllAgentProfiles()
  };
}

function getAgentDetail(cid) {
  const brainDir = getBrainDir();
  const tPath = resolveTranscriptPath(brainDir, cid);
  if (!tPath) return null;

  let content;
  try {
    content = fs.readFileSync(tPath, 'utf8');
  } catch (e) {
    return null;
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const steps = [];
  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      let displayContent = raw.content || '';
      let sysMeta = null;
      if (raw.type === 'USER_INPUT') {
        displayContent = cleanUserInput(displayContent);
      } else if (raw.type === 'SYSTEM_MESSAGE') {
        sysMeta = parseSystemMessage(displayContent);
        if (sysMeta) displayContent = sysMeta.content;
      }

      steps.push({
        stepIndex: raw.step_index,
        source: raw.source,
        type: raw.type,
        status: raw.status,
        createdAt: raw.created_at,
        content: displayContent,
        thinking: raw.thinking || null,
        sysMeta,
        inputTokens: raw.input_tokens || 0,
        outputTokens: raw.output_tokens || 0,
        toolCalls: (raw.tool_calls || []).map((tc) => ({
          name: tc.name,
          args: tc.args
        }))
      });
    } catch (e) {}
  }

  return { id: cid, stepCount: steps.length, steps };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '/';

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
  }

  if (pathname === '/api/state') {
    await triggerDockerSyncIfNeeded();
    const state = buildWorldState();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(state));
  }

  if (pathname.startsWith('/api/agent/')) {
    const cid = pathname.replace('/api/agent/', '').trim();
    await triggerDockerSyncIfNeeded();
    const detail = getAgentDetail(cid);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Agent transcript not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(detail));
  }

  if (pathname.startsWith('/api/export/')) {
    const sessionId = pathname.replace('/api/export/', '').trim();
    await triggerDockerSyncIfNeeded();
    const state = buildWorldState();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Session not found' }));
    }

    const format = (parsedUrl.query.format || 'html').toLowerCase();
    const flows = parsedUrl.query.flows || 'all';
    const agentId = parsedUrl.query.agentId || null;
    const order = (parsedUrl.query.order || 'asc').toLowerCase();
    const search = parsedUrl.query.search || null;
    const isDownload = parsedUrl.query.download === '1' || parsedUrl.query.download === 'true';
    const isPrint = parsedUrl.query.print === '1' || parsedUrl.query.print === 'true';

    const prepared = exporter.filterAndPrepareExportData(session, {
      flows,
      agentId,
      order,
      search
    });

    const safeTitle = (session.title || 'oturum')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gi, '_')
      .slice(0, 30);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const baseFilename = `${safeTitle}_${session.id.slice(0, 8)}_${dateStamp}`;

    if (format === 'json') {
      const jsonStr = exporter.generateJsonExport(session, prepared, { format, flows, agentId, order, search });
      const filename = `${baseFilename}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': isDownload ? `attachment; filename="${filename}"` : 'inline'
      });
      return res.end(jsonStr);
    }

    if (format === 'md' || format === 'markdown') {
      const mdStr = exporter.generateMarkdownExport(session, prepared, { format, flows, agentId, order, search });
      const filename = `${baseFilename}.md`;
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': isDownload ? `attachment; filename="${filename}"` : 'inline'
      });
      return res.end(mdStr);
    }

    if (format === 'txt' || format === 'text') {
      const txtStr = exporter.generateTextExport(session, prepared, { format, flows, agentId, order, search });
      const filename = `${baseFilename}.txt`;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': isDownload ? `attachment; filename="${filename}"` : 'inline'
      });
      return res.end(txtStr);
    }

    // Default: Standalone HTML report
    const htmlStr = exporter.generateHtmlReport(session, prepared, {
      autoPrint: isPrint,
      format,
      flows,
      agentId,
      order,
      search
    });
    const filename = `${baseFilename}.html`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': isDownload ? `attachment; filename="${filename}"` : 'inline'
    });
    return res.end(htmlStr);
  }

  // Static files in /public
  let filePath = pathname === '/' ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'public', pathname);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain; charset=utf-8' });
    return fs.createReadStream(filePath).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`🚀 Antigravity Multi-Agent Monitor listening on http://${HOST}:${PORT}`);
});
