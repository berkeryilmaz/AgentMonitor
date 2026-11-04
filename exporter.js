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

module.exports = {
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
