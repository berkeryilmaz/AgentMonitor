const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
let exporter;
try {
  exporter = require('./exporter.js');
} catch (_err) {
  exporter = createInlineExporter();
}

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

// --- Inline Exporter Fallback (for containers without ./exporter.js mounted) ---
function createInlineExporter() {
/**
 * Antigravity Multi-Agent Monitor - Message Export & Print-Ready Report Module
 *
 * Provides chronological message flow filtering, temporal delta calculations,
 * and 4 high-fidelity export formats:
 * 1. HTML: Standalone, responsive screen reader + ink-optimized @media print document
 * 2. Markdown: Rich GitHub-flavored markdown with hierarchy tables and quote blocks
 * 3. Plain Text: 80-100 column box-drawn ASCII log with timeline headers
 * 4. JSON: Structured export schema with session metadata and enriched message events
 */

const TR_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
];

/**
 * Escapes HTML characters safely
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Formats an ISO string into DD.MM.YYYY HH:mm:ss, dateOnly, timeOnly
 */
function formatDateTimeTurkish(isoString) {
  if (!isoString) {
    return { formattedDate: 'Bilinmiyor', dateOnly: '-', timeOnly: '-', iso: '', timestampMs: 0, dateLong: '-' };
  }
  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    return { formattedDate: String(isoString), dateOnly: '-', timeOnly: '-', iso: String(isoString), timestampMs: 0, dateLong: String(isoString) };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  return {
    formattedDate: `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`,
    dateOnly: `${day}.${month}.${year}`,
    timeOnly: `${hours}:${minutes}:${seconds}`,
    iso: d.toISOString(),
    timestampMs: d.getTime(),
    dateLong: `${day} ${TR_MONTHS[d.getMonth()]} ${year}`
  };
}

/**
 * Formats duration in milliseconds to human-readable Turkish string
 */
function formatDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms <= 0) return '0sn';
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);

  if (hr > 0) return `${hr}sa ${min}dk ${sec}sn`;
  if (min > 0) return `${min}dk ${sec}sn`;
  return `${sec}sn`;
}

/**
 * Formats elapsed time delta from start
 */
function formatDeltaFromStart(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms <= 0) return '+00:00';
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);

  if (hr > 0) return `+${hr}sa ${String(min).padStart(2, '0')}dk`;
  if (min > 0) return `+${min}dk ${String(sec).padStart(2, '0')}sn`;
  return `+${sec}sn`;
}

/**
 * Formats elapsed time delta from previous message
 */
function formatDeltaFromPrev(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '-';
  if (ms <= 1000) return '+0sn sonra';
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);

  if (hr > 0) return `+${hr}sa ${min}dk sonra`;
  if (min > 0) return `+${min}dk ${sec}sn sonra`;
  return `+${sec}sn sonra`;
}

/**
 * Returns Turkish hierarchy label based on agent depth
 */
function getAgentHierarchyLabel(agent) {
  if (!agent) return 'Bilinmeyen Ajan';
  if (agent.isRoot || agent.depth === 0) return 'L0 Ana Orkestratör (Root)';
  const d = agent.depth || 1;
  if (d === 1) return 'L1 Alt Ajan (Subagent)';
  if (d === 2) return 'L2 Alt-Alt Ajan (Sub-subagent)';
  return `L${d} Alt Ajan (Seviye ${d})`;
}

/**
 * Flow configurations & Turkish descriptions
 */
const FLOW_CONFIG = {
  USER_PROMPT: {
    flowType: 'USER_TO_AGENT',
    flowLabelTr: '👤 Kullanıcı ➔ Ajan (User to Agent)',
    flowShortTr: 'Kullanıcı ➔ Ajan',
    badgeClass: 'badge-u2a',
    accentColor: '#0284c7',
    bgLight: '#f0f9ff',
    borderLight: '#bae6fd',
    icon: '👤'
  },
  AGENT_TO_USER: {
    flowType: 'AGENT_TO_USER',
    flowLabelTr: '🤖 Ajan ➔ Kullanıcı (Agent to User)',
    flowShortTr: 'Ajan ➔ Kullanıcı',
    badgeClass: 'badge-a2u',
    accentColor: '#7c3aed',
    bgLight: '#f5f3ff',
    borderLight: '#ddd6fe',
    icon: '🤖'
  },
  TASK_DELEGATION: {
    flowType: 'AGENT_TO_AGENT',
    flowLabelTr: '🚀 Ajan ➔ Alt Ajan Görev Ataması (Agent to Agent - invoke_subagent)',
    flowShortTr: 'Görev Ataması (invoke_subagent)',
    badgeClass: 'badge-task',
    accentColor: '#4f46e5',
    bgLight: '#eef2ff',
    borderLight: '#c7d2fe',
    icon: '🚀'
  },
  AGENT_MESSAGE: {
    flowType: 'AGENT_TO_AGENT',
    flowLabelTr: '📩 Alt Ajan ➔ Ajan Rapor/Mesaj (Agent to Agent - send_message)',
    flowShortTr: 'Ajan Raporu (send_message)',
    badgeClass: 'badge-report',
    accentColor: '#059669',
    bgLight: '#ecfdf5',
    borderLight: '#a7f3d0',
    icon: '📩'
  }
};

/**
 * Lightweight safe markdown to HTML parser for export view
 */
function renderMarkdownToHtml(rawText) {
  if (!rawText) return '';
  let text = escapeHtml(rawText);

  // Fenced code blocks ```lang ... ```
  text = text.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
    const langBadge = lang ? `<span class="code-lang">${lang}</span>` : '';
    return `<div class="code-block-wrapper">${langBadge}<pre class="code-block"><code>${code.trim()}</code></pre></div>`;
  });

  // Inline code `code`
  text = text.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

  // Bold **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Headings #, ##, ###
  text = text.replace(/^###\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
  text = text.replace(/^##\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  text = text.replace(/^#\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');

  // Blockquotes > quote
  text = text.replace(/^&gt;\s+(.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');

  // Bullet items
  text = text.replace(/^[\s]*[-*]\s+(.+)$/gm, '<li class="md-li">$1</li>');

  // Paragraphs & lines
  const lines = text.split('\n');
  let insidePre = false;
  const processed = lines.map((line) => {
    if (line.includes('<pre')) insidePre = true;
    if (line.includes('</pre>')) {
      insidePre = false;
      return line;
    }
    if (insidePre) return line;
    if (
      line.startsWith('<h2') ||
      line.startsWith('<h3') ||
      line.startsWith('<h4') ||
      line.startsWith('<blockquote') ||
      line.startsWith('<li') ||
      line.startsWith('<div class="code-block')
    ) {
      return line;
    }
    if (!line.trim()) return '<div class="md-spacer"></div>';
    return `<p class="md-p">${line}</p>`;
  });

  return processed.join('\n');
}

/**
 * Filter and prepare chronological message data with exact dates & deltas
 */
function filterAndPrepareExportData(session, options = {}) {
  const allMessages = Array.isArray(session?.messages) ? [...session.messages] : [];

  // Parse flow filters
  let flowFilters = ['all'];
  if (options.flows) {
    if (Array.isArray(options.flows)) {
      flowFilters = options.flows.map((f) => String(f).trim().toLowerCase());
    } else if (typeof options.flows === 'string') {
      flowFilters = options.flows
        .split(',')
        .map((f) => f.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  if (flowFilters.length === 0) flowFilters = ['all'];

  const rawAgentId = options.agentId ? String(options.agentId).trim() : '';
  const agentIdFilter = rawAgentId && rawAgentId.toLowerCase() !== 'all' ? rawAgentId : null;
  const searchQuery = options.search ? String(options.search).trim().toLowerCase() : null;
  const order = (options.order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

  // 1. Sort strictly in chronological order (oldest to newest) to establish the true timeline
  allMessages.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return (a.stepOrder ?? 0) - (b.stepOrder ?? 0);
  });

  const firstValidTs = allMessages.find((m) => m.timestamp && !isNaN(new Date(m.timestamp).getTime()));
  const sessionFirstMs = firstValidTs ? new Date(firstValidTs.timestamp).getTime() : 0;
  let prevMsgMs = sessionFirstMs;

  // 2. Enrich all messages with sequence, exact dates, and deltas
  const enrichedSessionMessages = allMessages.map((m, idx) => {
    const cfg = FLOW_CONFIG[m.kind] || {
      flowType: m.flowType || 'AGENT_TO_AGENT',
      flowLabelTr: m.kind,
      flowShortTr: m.kind,
      badgeClass: 'badge-default',
      accentColor: '#64748b',
      bgLight: '#f8fafc',
      borderLight: '#cbd5e1',
      icon: '💬'
    };

    const dateMeta = formatDateTimeTurkish(m.timestamp);
    const currentMs = dateMeta.timestampMs || prevMsgMs;
    const deltaFromStartMs = sessionFirstMs > 0 ? Math.max(0, currentMs - sessionFirstMs) : 0;
    const deltaFromPrevMs = idx === 0 ? 0 : Math.max(0, currentMs - prevMsgMs);

    prevMsgMs = currentMs;

    return {
      ...m,
      globalSeqNumber: idx + 1,
      flowType: cfg.flowType,
      flowLabelTr: cfg.flowLabelTr,
      flowShortTr: cfg.flowShortTr,
      badgeClass: cfg.badgeClass,
      accentColor: cfg.accentColor,
      bgLight: cfg.bgLight,
      borderLight: cfg.borderLight,
      icon: cfg.icon,
      formattedDate: dateMeta.formattedDate,
      dateOnly: dateMeta.dateOnly,
      timeOnly: dateMeta.timeOnly,
      dateLong: dateMeta.dateLong,
      isoTimestamp: dateMeta.iso,
      deltaFromStartMs,
      deltaFromStart: formatDeltaFromStart(deltaFromStartMs),
      deltaFromPrevMs,
      deltaFromPrev: idx === 0 ? 'Başlangıç' : formatDeltaFromPrev(deltaFromPrevMs)
    };
  });

  // 3. Filter messages
  const filtered = enrichedSessionMessages.filter((m) => {
    // Flow filter
    if (!flowFilters.includes('all')) {
      const k = m.kind;
      const ft = m.flowType;
      const matchU2A = (flowFilters.includes('u2a') || flowFilters.includes('user_to_agent')) && k === 'USER_PROMPT';
      const matchA2U = (flowFilters.includes('a2u') || flowFilters.includes('agent_to_user')) && k === 'AGENT_TO_USER';
      const matchA2A = (flowFilters.includes('a2a') || flowFilters.includes('agent_to_agent')) && (k === 'TASK_DELEGATION' || k === 'AGENT_MESSAGE');
      const matchKind = flowFilters.includes(k.toLowerCase()) || flowFilters.includes(ft.toLowerCase());

      if (!matchU2A && !matchA2U && !matchA2A && !matchKind) {
        return false;
      }
    }

    // Agent ID filter
    if (agentIdFilter) {
      const sId = m.sender ? m.sender.id : '';
      const rId = m.recipient ? m.recipient.id : '';
      if (sId !== agentIdFilter && rId !== agentIdFilter) {
        return false;
      }
    }

    // Text search query
    if (searchQuery) {
      const contentText = (m.content || '').toLowerCase();
      const senderRole = (m.sender && m.sender.role ? m.sender.role : '').toLowerCase();
      const recipientRole = (m.recipient && m.recipient.role ? m.recipient.role : '').toLowerCase();
      const summaryText = (m.summary || '').toLowerCase();
      const modelText = (m.model || '').toLowerCase();

      const matched =
        contentText.includes(searchQuery) ||
        senderRole.includes(searchQuery) ||
        recipientRole.includes(searchQuery) ||
        summaryText.includes(searchQuery) ||
        modelText.includes(searchQuery);

      if (!matched) return false;
    }

    return true;
  });

  // 4. Assign sequential export sequence numbers
  filtered.forEach((m, idx) => {
    m.seqNumber = idx + 1;
  });

  // 5. Apply display order (asc or desc)
  if (order === 'desc') {
    filtered.reverse();
  }

  // 6. Compute breakdown and timing metadata
  const userToAgentCount = filtered.filter((m) => m.kind === 'USER_PROMPT').length;
  const agentToUserCount = filtered.filter((m) => m.kind === 'AGENT_TO_USER').length;
  const agentToAgentTaskCount = filtered.filter((m) => m.kind === 'TASK_DELEGATION').length;
  const agentToAgentReportCount = filtered.filter((m) => m.kind === 'AGENT_MESSAGE').length;

  let firstMessageAt = null;
  let lastMessageAt = null;
  let totalDurationMs = 0;

  if (enrichedSessionMessages.length > 0) {
    firstMessageAt = enrichedSessionMessages[0].formattedDate;
    lastMessageAt = enrichedSessionMessages[enrichedSessionMessages.length - 1].formattedDate;
    const startMs = enrichedSessionMessages[0].deltaFromStartMs || 0;
    const endMs = enrichedSessionMessages[enrichedSessionMessages.length - 1].deltaFromStartMs || 0;
    totalDurationMs = Math.max(0, endMs - startMs);
  }

  // Prepare Participating Agents list with hierarchy
  const rawAgents = Array.isArray(session?.agents) ? session.agents : [];
  const participatingAgents = rawAgents.map((ag) => ({
    ...ag,
    hierarchyLabel: getAgentHierarchyLabel(ag),
    firstTimestampFormatted: ag.firstTimestamp ? formatDateTimeTurkish(ag.firstTimestamp).formattedDate : '-',
    lastTimestampFormatted: ag.lastTimestamp ? formatDateTimeTurkish(ag.lastTimestamp).formattedDate : '-'
  }));

  return {
    options: {
      flows: flowFilters,
      agentId: agentIdFilter,
      order,
      search: searchQuery
    },
    summary: {
      firstMessageAt,
      lastMessageAt,
      totalDurationMs,
      totalDurationFormatted: formatDuration(totalDurationMs),
      userToAgentCount,
      agentToUserCount,
      agentToAgentTaskCount,
      agentToAgentReportCount,
      totalExportedMessages: filtered.length,
      totalSessionMessages: allMessages.length
    },
    agents: participatingAgents,
    messages: filtered
  };
}

/**
 * 1. HTML Report Generator (Standalone, Reader & Print-Ready)
 */
function generateHtmlReport(session, prepared, options = {}) {
  const sessTitle = session?.title || `Oturum ${session?.id?.slice(0, 8) || ''}`;
  const projectName = session?.project || 'Genel';
  const sessionId = session?.id || '';
  const nowMeta = formatDateTimeTurkish(new Date().toISOString());
  const autoPrint = Boolean(options.autoPrint);

  const { summary, agents, messages } = prepared;

  // Build participating agents rows
  const agentRowsHtml = agents
    .map(
      (a) => `
      <tr>
        <td><span class="badge ${a.isRoot ? 'badge-root' : 'badge-sub'}">${escapeHtml(a.hierarchyLabel)}</span></td>
        <td class="font-bold">${escapeHtml(a.role)}</td>
        <td><code>${escapeHtml(a.typeName || 'agent')}</code></td>
        <td><span class="model-badge model-${escapeHtml(a.model || 'inherit')}">${escapeHtml(a.model || 'inherit')}</span></td>
        <td><code class="text-xs">${escapeHtml(a.workspace || '-')}</code></td>
        <td class="text-center font-mono">${a.stepCount ?? '-'}</td>
        <td class="font-mono text-xs">${a.firstTimestampFormatted}</td>
        <td class="font-mono text-xs">${a.lastTimestampFormatted}</td>
        <td><span class="status-pill status-${a.status}">${a.status === 'running' ? 'Çalışıyor' : 'Tamamlandı'}</span></td>
      </tr>`
    )
    .join('\n');

  // Build timeline message cards with date boundaries
  let lastDateOnly = null;
  const messagesHtml = messages
    .map((m) => {
      let dateDividerHtml = '';
      if (m.dateOnly && m.dateOnly !== lastDateOnly) {
        lastDateOnly = m.dateOnly;
        dateDividerHtml = `
          <div class="date-divider page-break-avoid">
            <span class="date-divider-badge">📅 ${escapeHtml(m.dateLong || m.dateOnly)}</span>
          </div>`;
      }

      const formattedContent = renderMarkdownToHtml(m.content || '');

      return `
        ${dateDividerHtml}
        <article class="msg-card page-break-avoid ${m.badgeClass}" style="--accent: ${m.accentColor}; --bg-tint: ${m.bgLight}; --border-tint: ${m.borderLight};">
          <header class="msg-header">
            <div class="msg-header-left">
              <span class="seq-badge">#${m.seqNumber}</span>
              <span class="flow-pill ${m.badgeClass}">${m.icon} ${escapeHtml(m.flowLabelTr)}</span>
              ${m.model && m.kind === 'TASK_DELEGATION' ? `<span class="model-badge model-${escapeHtml(m.model)}">Model: ${escapeHtml(m.model)}</span>` : ''}
            </div>
            <div class="msg-header-right">
              <span class="time-main font-mono">🕒 ${escapeHtml(m.formattedDate)}</span>
              <span class="time-delta" title="Oturum başlangıcından bu yana geçen süre">Başlangıç: ${escapeHtml(m.deltaFromStart)}</span>
              <span class="time-delta-prev" title="Önceki adımdan bu yana geçen süre">Önceki: ${escapeHtml(m.deltaFromPrev)}</span>
            </div>
          </header>

          <div class="msg-route">
            <div class="route-party">
              <span class="route-label">Gönderen:</span>
              <span class="party-name ${m.sender?.isUser ? 'party-user' : 'party-agent'}">${escapeHtml(m.sender?.role || m.sender?.id || 'Bilinmiyor')}</span>
              ${m.sender?.model ? `<span class="party-model">(${escapeHtml(m.sender.model)})</span>` : ''}
            </div>
            <span class="route-arrow">➔</span>
            <div class="route-party">
              <span class="route-label">Alıcı:</span>
              <span class="party-name ${m.recipient?.isUser ? 'party-user' : 'party-agent'}">${escapeHtml(m.recipient?.role || m.recipient?.id || 'Bilinmiyor')}</span>
              ${m.recipient?.model ? `<span class="party-model">(${escapeHtml(m.recipient.model)})</span>` : ''}
            </div>
          </div>

          <div class="msg-body">
            ${formattedContent}
          </div>
        </article>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(sessTitle)} - Mesaj Akış Raporu</title>
  <style>
    :root {
      --base-font-size: 14px;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --border-darker: #cbd5e1;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
    }

    body.dark-theme {
      --bg: #090d16;
      --card-bg: #0f172a;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --border: #1e293b;
      --border-darker: #334155;
    }

    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: var(--base-font-size);
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.6;
      margin: 0;
      padding: 0;
      transition: background-color 0.2s, color 0.2s;
    }

    .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }

    /* Top Floating Navigation Bar */
    .top-nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(15, 23, 42, 0.95);
      color: #f8fafc;
      backdrop-filter: blur(10px);
      padding: 10px 24px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid #334155;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .nav-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .nav-brand { font-weight: 700; font-size: 14px; color: #818cf8; display: flex; align-items: center; gap: 6px; }
    .nav-title { font-weight: 600; font-size: 13px; color: #cbd5e1; }
    .nav-badge { background: #1e293b; border: 1px solid #475569; padding: 2px 8px; border-radius: 6px; font-size: 11px; }

    .nav-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .font-ctrl { display: flex; align-items: center; gap: 4px; background: #1e293b; padding: 3px 8px; border-radius: 8px; border: 1px solid #475569; font-size: 12px; }
    .btn-ctrl { background: #334155; border: none; color: #fff; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-weight: 700; }
    .btn-ctrl:hover { background: #475569; }

    .btn-action {
      background: #1e293b;
      color: #f1f5f9;
      border: 1px solid #475569;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
    }
    .btn-action:hover { background: #334155; border-color: #64748b; }
    .btn-primary { background: #4f46e5; border-color: #6366f1; color: #fff; }
    .btn-primary:hover { background: #4338ca; }

    /* Main Container */
    .container {
      max-width: 1140px;
      margin: 28px auto 60px;
      padding: 0 20px;
    }

    /* Document Header Card */
    .doc-header {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 28px;
      margin-bottom: 24px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.04);
    }
    .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
    .doc-title { font-size: 22px; font-weight: 800; margin: 0 0 6px; color: var(--text); }
    .doc-sub { font-size: 13px; color: var(--text-muted); display: flex; gap: 16px; flex-wrap: wrap; }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 14px;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
    }
    .meta-item {
      background: var(--bg);
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .meta-label { font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted); margin-bottom: 4px; }
    .meta-value { font-size: 14px; font-weight: 700; color: var(--text); }

    /* Stat Cards */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 2px 8px rgba(0,0,0,0.02);
    }
    .stat-num { font-size: 24px; font-weight: 800; }
    .stat-desc { font-size: 11px; color: var(--text-muted); font-weight: 600; margin-top: 2px; }

    /* Section Cards */
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 28px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.03);
    }
    .section-title { font-size: 16px; font-weight: 700; margin: 0 0 16px; display: flex; align-items: center; gap: 8px; color: var(--text); }

    /* Agents Table */
    .table-responsive { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
    th { background: var(--bg); padding: 10px 12px; font-weight: 700; color: var(--text-muted); border-bottom: 2px solid var(--border); }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }

    /* Badges */
    .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .badge-root { background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; }
    .badge-sub { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .model-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; font-family: monospace; }
    .model-pro { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
    .model-flash { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .model-flash_lite { background: #e0f2fe; color: #075985; border: 1px solid #bae6fd; }
    .model-inherit { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }

    .status-pill { padding: 2px 6px; border-radius: 12px; font-size: 10px; font-weight: 700; }
    .status-completed { background: #ecfdf5; color: #047857; }
    .status-running { background: #eff6ff; color: #1d4ed8; }

    /* Date Divider */
    .date-divider {
      text-align: center;
      margin: 32px 0 20px;
      position: relative;
    }
    .date-divider::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 0;
      right: 0;
      height: 1px;
      background: var(--border-darker);
      z-index: 1;
    }
    .date-divider-badge {
      position: relative;
      z-index: 2;
      background: var(--card-bg);
      border: 1px solid var(--border-darker);
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 700;
      padding: 4px 16px;
      border-radius: 20px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.05);
    }

    /* Message Cards */
    .msg-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-left: 5px solid var(--accent);
      border-radius: 12px;
      margin-bottom: 20px;
      box-shadow: 0 3px 12px rgba(0,0,0,0.03);
      overflow: hidden;
      transition: border-color 0.15s;
    }
    .msg-header {
      background: var(--bg-tint);
      padding: 10px 16px;
      border-bottom: 1px solid var(--border-tint);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .msg-header-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .msg-header-right { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-muted); flex-wrap: wrap; }

    .seq-badge { font-family: monospace; font-weight: 800; font-size: 12px; color: #fff; background: var(--accent); padding: 2px 8px; border-radius: 6px; }
    .flow-pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: #fff; border: 1px solid var(--border-tint); color: var(--accent); }

    .time-delta { background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; font-weight: 600; }
    .time-delta-prev { color: var(--text-muted); }

    .msg-route {
      padding: 8px 16px;
      background: rgba(0,0,0,0.015);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      flex-wrap: wrap;
    }
    .route-party { display: flex; align-items: center; gap: 6px; }
    .route-label { font-weight: 600; color: var(--text-muted); font-size: 11px; }
    .party-name { font-weight: 700; }
    .party-user { color: #0284c7; }
    .party-agent { color: #4f46e5; }
    .party-model { color: var(--text-muted); font-size: 11px; font-family: monospace; }
    .route-arrow { color: #94a3b8; font-weight: 700; font-size: 14px; }

    .msg-body {
      padding: 16px;
      font-size: var(--base-font-size);
      color: var(--text);
      word-break: break-word;
    }
    .msg-body p.md-p { margin: 0 0 10px; }
    .msg-body p.md-p:last-child { margin-bottom: 0; }
    .md-spacer { height: 10px; }
    .md-h2 { font-size: 16px; font-weight: 700; margin: 14px 0 6px; color: var(--text); }
    .md-h3 { font-size: 14px; font-weight: 700; margin: 12px 0 6px; color: var(--text); }
    .md-h4 { font-size: 13px; font-weight: 700; margin: 10px 0 4px; color: var(--text); }
    .md-quote {
      border-left: 3px solid var(--accent);
      padding: 4px 12px;
      margin: 8px 0;
      color: var(--text-muted);
      background: rgba(0,0,0,0.02);
      border-radius: 0 6px 6px 0;
    }
    .md-li { margin-left: 20px; list-style-type: disc; }

    /* Code Block styling */
    .code-block-wrapper { position: relative; margin: 12px 0; }
    .code-lang {
      position: absolute;
      top: 4px;
      right: 8px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: #94a3b8;
      font-family: monospace;
    }
    pre.code-block {
      background: #0f172a;
      color: #e2e8f0;
      padding: 14px 16px;
      border-radius: 8px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      margin: 0;
    }
    code.inline-code {
      background: rgba(0,0,0,0.06);
      color: #e11d48;
      padding: 2px 5px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.9em;
    }
    body.dark-theme code.inline-code {
      background: rgba(255,255,255,0.1);
      color: #fb7185;
    }

    /* Print Stylesheet */
    @media print {
      .no-print { display: none !important; }
      body {
        background: #ffffff !important;
        color: #000000 !important;
        font-size: 10pt !important;
        line-height: 1.4 !important;
      }
      .container { max-width: 100% !important; margin: 0 !important; padding: 0 !important; }
      .doc-header, .section-card, .msg-card {
        border: 1px solid #cbd5e1 !important;
        box-shadow: none !important;
        background: #ffffff !important;
      }
      .page-break-avoid {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      .msg-card {
        margin-bottom: 12pt !important;
        border-left-width: 4pt !important;
      }
      .msg-header {
        background: #f8fafc !important;
        border-bottom: 1px solid #e2e8f0 !important;
      }
      pre.code-block {
        background: #f8fafc !important;
        color: #0f172a !important;
        border: 1px solid #cbd5e1 !important;
        white-space: pre-wrap !important;
        word-break: break-word !important;
      }
      @page {
        margin: 1.2cm 1cm;
        size: auto;
      }
    }
  </style>
</head>
<body>

  <!-- Top Action Bar (Screen Reader & Print Control) -->
  <header class="top-nav no-print">
    <div class="nav-left">
      <span class="nav-brand">🚀 Antigravity Monitor</span>
      <span class="nav-title">${escapeHtml(sessTitle)}</span>
      <span class="nav-badge">📂 ${escapeHtml(projectName)}</span>
      <span class="nav-badge">💬 ${summary.totalExportedMessages} Mesaj</span>
    </div>
    <div class="nav-actions">
      <div class="font-ctrl" title="Yazı Boyutunu Değiştir">
        <span>Yazı:</span>
        <button onclick="changeFontSize(-1)" class="btn-ctrl" title="Küçült">A-</button>
        <button onclick="changeFontSize(1)" class="btn-ctrl" title="Büyüt">A+</button>
      </div>
      <button onclick="toggleTheme()" id="themeBtn" class="btn-action" title="Açık ve Koyu tema arasında geçiş yap">
        🌙 Koyu Okuma Modu
      </button>
      <button onclick="window.print()" class="btn-action btn-primary" title="Yazdır veya PDF olarak kaydet">
        🖨️ Yazdır / PDF Kaydet
      </button>
    </div>
  </header>

  <main class="container">
    <!-- Document Header -->
    <header class="doc-header">
      <div class="header-top">
        <div>
          <h1 class="doc-title">${escapeHtml(sessTitle)}</h1>
          <div class="doc-sub">
            <span><strong>Proje:</strong> ${escapeHtml(projectName)}</span>
            <span><strong>Oturum ID:</strong> <code class="font-mono">${escapeHtml(sessionId)}</code></span>
            <span><strong>Rapor Tarihi:</strong> ${escapeHtml(nowMeta.formattedDate)}</span>
          </div>
        </div>
      </div>

      <div class="meta-grid">
        <div class="meta-item">
          <div class="meta-label">Başlangıç Tarihi</div>
          <div class="meta-value font-mono">${escapeHtml(summary.firstMessageAt || '-')}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Bitiş Tarihi</div>
          <div class="meta-value font-mono">${escapeHtml(summary.lastMessageAt || '-')}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Toplam Süre</div>
          <div class="meta-value">${escapeHtml(summary.totalDurationFormatted)}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Dışa Aktarılan Mesaj</div>
          <div class="meta-value">${summary.totalExportedMessages} / ${summary.totalSessionMessages}</div>
        </div>
      </div>
    </header>

    <!-- Statistics Row -->
    <section class="stats-row page-break-avoid">
      <div class="stat-card" style="border-top: 4px solid #0284c7;">
        <span class="stat-num" style="color: #0284c7;">${summary.userToAgentCount}</span>
        <span class="stat-desc">👤 Kullanıcı ➔ Ajan</span>
      </div>
      <div class="stat-card" style="border-top: 4px solid #7c3aed;">
        <span class="stat-num" style="color: #7c3aed;">${summary.agentToUserCount}</span>
        <span class="stat-desc">🤖 Ajan ➔ Kullanıcı</span>
      </div>
      <div class="stat-card" style="border-top: 4px solid #4f46e5;">
        <span class="stat-num" style="color: #4f46e5;">${summary.agentToAgentTaskCount}</span>
        <span class="stat-desc">🚀 Görev Ataması (invoke_subagent)</span>
      </div>
      <div class="stat-card" style="border-top: 4px solid #059669;">
        <span class="stat-num" style="color: #059669;">${summary.agentToAgentReportCount}</span>
        <span class="stat-desc">📩 Ajan Raporu (send_message)</span>
      </div>
    </section>

    <!-- Participating Agents Table -->
    ${
      agents.length > 0
        ? `
    <section class="section-card page-break-avoid">
      <h2 class="section-title">👥 Katılımcı Ajanlar &amp; Hiyerarşi Haritası (${agents.length} Ajan)</h2>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Hiyerarşi</th>
              <th>Ajan Rolü</th>
              <th>Tür</th>
              <th>Model</th>
              <th>Workspace / Branch</th>
              <th class="text-center">Adım</th>
              <th>İlk Görülme</th>
              <th>Son Görülme</th>
              <th>Durum</th>
            </tr>
          </thead>
          <tbody>
            ${agentRowsHtml}
          </tbody>
        </table>
      </div>
    </section>`
        : ''
    }

    <!-- Chronological Message Timeline -->
    <section class="timeline-section">
      ${
        messages.length === 0
          ? `<div class="section-card text-center" style="padding: 40px; text-align: center; color: var(--text-muted);">
               Belirtilen filtre kriterlerine uygun mesaj bulunamadı.
             </div>`
          : messagesHtml
      }
    </section>
  </main>

  <script>
    let currentFontSize = 14;
    function changeFontSize(delta) {
      currentFontSize = Math.max(11, Math.min(22, currentFontSize + delta));
      document.documentElement.style.setProperty('--base-font-size', currentFontSize + 'px');
    }

    function toggleTheme() {
      const isDark = document.body.classList.toggle('dark-theme');
      const btn = document.getElementById('themeBtn');
      if (btn) {
        btn.textContent = isDark ? '☀️ Açık / Kağıt Modu' : '🌙 Koyu Okuma Modu';
      }
    }

    ${autoPrint ? `window.addEventListener('load', () => setTimeout(() => window.print(), 350));` : ''}
  </script>
</body>
</html>`;
}

/**
 * 2. Markdown Export Generator (.md)
 */
function generateMarkdownExport(session, prepared, options = {}) {
  const sessTitle = session?.title || `Oturum ${session?.id?.slice(0, 8) || ''}`;
  const projectName = session?.project || 'Genel';
  const sessionId = session?.id || '';
  const nowMeta = formatDateTimeTurkish(new Date().toISOString());

  const { summary, agents, messages } = prepared;

  const lines = [
    `# 📋 Antigravity Mesaj Akış Raporu: ${sessTitle}`,
    '',
    `> **Proje:** ${projectName}  `,
    `> **Oturum ID:** \`${sessionId}\`  `,
    `> **Rapor Oluşturma Tarihi:** ${nowMeta.formattedDate}  `,
    `> **Zaman Dilimi:** ${summary.firstMessageAt || '-'} — ${summary.lastMessageAt || '-'} (Toplam Süre: **${summary.totalDurationFormatted}**)  `,
    `> **Dışa Aktarılan Mesaj Sayısı:** ${summary.totalExportedMessages} / ${summary.totalSessionMessages}  `,
    `> **İstatistikler:** 👤 Kullanıcı➔Ajan: **${summary.userToAgentCount}** | 🤖 Ajan➔Kullanıcı: **${summary.agentToUserCount}** | 🚀 Görev: **${summary.agentToAgentTaskCount}** | 📩 Rapor: **${summary.agentToAgentReportCount}**  `,
    '',
    '---',
    '',
    '## 👥 Katılımcı Ajanlar & Hiyerarşi',
    '',
    '| Hiyerarşi | Ajan Rolü | Tür | Model | Workspace / Branch | Adım | İlk Görülme | Durum |',
    '| :--- | :--- | :--- | :--- | :--- | :---: | :--- | :--- |'
  ];

  for (const a of agents) {
    lines.push(
      `| ${a.hierarchyLabel} | **${a.role}** | \`${a.typeName || 'agent'}\` | \`${a.model || 'inherit'}\` | \`${a.workspace || '-'}\` | ${a.stepCount ?? '-'} | ${a.firstTimestampFormatted} | ${a.status === 'running' ? '🟢 Çalışıyor' : '⚪ Tamamlandı'} |`
    );
  }

  lines.push('', '---', '', '## 💬 Kronolojik Mesaj Akışı', '');

  let lastDateOnly = null;
  for (const m of messages) {
    if (m.dateOnly && m.dateOnly !== lastDateOnly) {
      lastDateOnly = m.dateOnly;
      lines.push(`### 📅 ${m.dateLong || m.dateOnly}`, '');
    }

    const sRole = m.sender?.role || m.sender?.id || 'Bilinmiyor';
    const rRole = m.recipient?.role || m.recipient?.id || 'Bilinmiyor';
    const sModel = m.sender?.model ? ` [${m.sender.model}]` : '';
    const rModel = m.recipient?.model ? ` [${m.recipient.model}]` : '';

    lines.push(`#### [#${m.seqNumber}] [${m.formattedDate}] (${m.deltaFromStart}) ${m.icon} ${sRole} ➔ ${rRole}`);
    lines.push('');
    lines.push(`> **Akış:** ${m.flowLabelTr}  `);
    lines.push(`> **Tarih & Saat:** \`${m.formattedDate}\` (Başlangıçtan: \`${m.deltaFromStart}\` | Öncekinden: \`${m.deltaFromPrev}\`)  `);
    lines.push(`> **Yön:** \`${sRole}${sModel}\` ➔ \`${rRole}${rModel}\`  `);
    if (m.model && m.kind === 'TASK_DELEGATION') {
      lines.push(`> **Hedef Model:** \`${m.model}\` | **Workspace:** \`${m.workspace || 'inherit'}\`  `);
    }
    lines.push('');

    const rawContent = (m.content || '').trim();
    lines.push(rawContent);
    lines.push('', '---', '');
  }

  return lines.join('\n');
}

/**
 * 3. Plain Text Box-Drawn Log Generator (.txt)
 */
function generateTextExport(session, prepared, options = {}) {
  const sessTitle = session?.title || `Oturum ${session?.id?.slice(0, 8) || ''}`;
  const projectName = session?.project || 'Genel';
  const sessionId = session?.id || '';
  const nowMeta = formatDateTimeTurkish(new Date().toISOString());

  const { summary, agents, messages } = prepared;
  const W = 88;
  const sepDouble = '='.repeat(W);
  const sepSingle = '-'.repeat(W);

  const lines = [
    sepDouble,
    'ANTIGRAVITY MESAJ AKIS VE OKUMA RAPORU (TEXT LOG)',
    sepDouble,
    `Oturum       : ${sessTitle}`,
    `Proje        : ${projectName}`,
    `Oturum ID    : ${sessionId}`,
    `Rapor Tarihi : ${nowMeta.formattedDate}`,
    `Zaman Dilimi : ${summary.firstMessageAt || '-'} -> ${summary.lastMessageAt || '-'} (Toplam: ${summary.totalDurationFormatted})`,
    `Mesaj Sayisi : ${summary.totalExportedMessages} / ${summary.totalSessionMessages}`,
    sepSingle,
    'OZET ISTATISTIKLER:',
    `  - 👤 Kullanici -> Ajan (User to Agent)        : ${summary.userToAgentCount}`,
    `  - 🤖 Ajan -> Kullanici (Agent to User)        : ${summary.agentToUserCount}`,
    `  - 🚀 Ajan -> Ajan Gorev (TASK_DELEGATION)     : ${summary.agentToAgentTaskCount}`,
    `  - 📩 Ajan -> Ajan Rapor (AGENT_MESSAGE)       : ${summary.agentToAgentReportCount}`,
    sepSingle,
    'KATILIMCI AJANLAR:',
    ...agents.map(
      (a) => `  [${a.hierarchyLabel}] ${a.role} | Model: ${a.model || 'inherit'} | Workspace: ${a.workspace || '-'} | Adim: ${a.stepCount ?? '-'}`
    ),
    sepDouble,
    'KRONOLOJIK MESAJ AKISI:',
    sepDouble
  ];

  for (const m of messages) {
    const sRole = m.sender?.role || m.sender?.id || 'Bilinmiyor';
    const rRole = m.recipient?.role || m.recipient?.id || 'Bilinmiyor';
    const sModel = m.sender?.model ? ` [${m.sender.model}]` : '';
    const rModel = m.recipient?.model ? ` [${m.recipient.model}]` : '';

    lines.push('');
    lines.push(sepSingle);
    lines.push(
      `[#${m.seqNumber}] ${m.formattedDate} | Baslangictan: ${m.deltaFromStart} | Oncekinden: ${m.deltaFromPrev}`
    );
    lines.push(`AKIS     : ${m.flowLabelTr}`);
    lines.push(`GONDEREN : ${sRole}${sModel}`);
    lines.push(`ALICI    : ${rRole}${rModel}`);
    if (m.model && m.kind === 'TASK_DELEGATION') {
      lines.push(`MODEL    : ${m.model} (Workspace: ${m.workspace || 'inherit'})`);
    }
    lines.push(sepSingle);
    lines.push(m.content || '');
  }

  lines.push('');
  lines.push(sepDouble);
  lines.push('RAPOR SONU');
  lines.push(sepDouble);

  return lines.join('\n');
}

/**
 * 4. Structured JSON Export Generator (.json)
 */
function generateJsonExport(session, prepared, options = {}) {
  const exportPayload = {
    exportMetadata: {
      generator: 'Antigravity Multi-Agent Monitor Exporter',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      filtersApplied: prepared.options
    },
    session: {
      id: session?.id || '',
      title: session?.title || '',
      project: session?.project || '',
      status: session?.status || 'completed',
      agentCount: prepared.agents.length,
      totalSteps: session?.totalSteps || 0,
      totalTokens: session?.totalTokens || 0,
      firstTimestamp: session?.firstTimestamp || prepared.summary.firstMessageAt,
      lastTimestamp: session?.lastTimestamp || prepared.summary.lastMessageAt,
      durationFormatted: prepared.summary.totalDurationFormatted
    },
    summary: prepared.summary,
    agents: prepared.agents.map((a) => ({
      id: a.id,
      isRoot: a.isRoot,
      depth: a.depth || 0,
      hierarchyLabel: a.hierarchyLabel,
      role: a.role,
      typeName: a.typeName,
      model: a.model,
      workspace: a.workspace,
      status: a.status,
      stepCount: a.stepCount,
      firstTimestamp: a.firstTimestamp,
      lastTimestamp: a.lastTimestamp,
      tokens: a.tokens
    })),
    messages: prepared.messages.map((m) => ({
      seqNumber: m.seqNumber,
      globalSeqNumber: m.globalSeqNumber,
      id: m.id,
      kind: m.kind,
      flowType: m.flowType,
      flowLabelTr: m.flowLabelTr,
      stepOrder: m.stepOrder ?? null,
      timestamp: m.timestamp,
      formattedDate: m.formattedDate,
      dateOnly: m.dateOnly,
      timeOnly: m.timeOnly,
      isoTimestamp: m.isoTimestamp,
      deltaFromStart: m.deltaFromStart,
      deltaFromStartMs: m.deltaFromStartMs,
      deltaFromPrev: m.deltaFromPrev,
      deltaFromPrevMs: m.deltaFromPrevMs,
      sender: m.sender,
      recipient: m.recipient,
      model: m.model || null,
      workspace: m.workspace || null,
      summary: m.summary || null,
      content: m.content || ''
    }))
  };

  return JSON.stringify(exportPayload, null, 2);
}

return {
  escapeHtml,
  formatDateTimeTurkish,
  formatDuration,
  formatDeltaFromStart,
  formatDeltaFromPrev,
  getAgentHierarchyLabel,
  filterAndPrepareExportData,
  generateHtmlReport,
  generateMarkdownExport,
  generateTextExport,
  generateJsonExport
};

}
