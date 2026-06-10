// Client Dashboard - Core Logic
// Refactored from 186KB monolith

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
  brandId: null,
  brand: null,
  currentView: 'overview',
  isLoading: false
};

// ============================================================================
// API CLIENT
// ============================================================================

const API = {
  async getBrand(brandId) {
    const res = await fetch(`/api/brands/${brandId}`);
    if (!res.ok) throw new Error('Failed to load brand data');
    return res.json();
  },

  async updateGoal(brandId, goalId, updates) {
    const res = await fetch(`/api/brands/${brandId}/goals/${goalId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error('Failed to update goal');
    return res.json();
  },

  async addComment(brandId, type, targetId, comment) {
    const res = await fetch(`/api/brands/${brandId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, targetId, comment })
    });
    if (!res.ok) throw new Error('Failed to add comment');
    return res.json();
  }
};

// ============================================================================
// RENDER FUNCTIONS
// ============================================================================
function renderResources(brand) {
    const resources = brand.resources || [];
    const grid = document.getElementById('resourcesGrid');
    
    if (resources.length === 0) {
      grid.innerHTML = `
        <div class="resources-empty">
          📋<br><br>
          Your account manager will add resources here after your kickoff call.<br>
          Brand briefs, creator guidelines, product pages, and more.
        </div>
      `;
      return;
    }
    
    const iconMap = {
      doc: '📄',
      link: '🔗',
      video: '🎬',
      image: '🖼️',
      default: '📎'
    };
    
    const html = resources.map(r => {
      const icon = iconMap[r.type] || iconMap.default;
      return `
        <a href="${r.url}" target="_blank" class="resource-card">
          <span class="resource-icon">${icon}</span>
          <span class="resource-label">${r.label}</span>
        </a>
      `;
    }).join('');
    
    grid.innerHTML = html;
  }
// ============================================================================
// MAIN SCRIPT LOGIC
// ============================================================================

  function fmt$(n) {
    if (n == null || n === '') return '—';
    n = Number(n); if (isNaN(n)) return '—';
    if (n >= 1_000_000) return '$' + (n/1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return '$' + (n/1_000).toFixed(1) + 'k';
    return '$' + n.toFixed(0);
  }
  function fmtN(n) { if (n == null) return '—'; return Number(n).toLocaleString(); }
  function fmtAge(ts) {
    if (!ts) return '';
    const ms = Date.now() - new Date(ts);
    if (ms < 60_000)     return 'just now';
    if (ms < 3_600_000)  return Math.floor(ms/60_000) + 'm ago';
    if (ms < 86_400_000) return Math.floor(ms/3_600_000) + 'h ago';
    return Math.floor(ms/86_400_000) + 'd ago';
  }
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function reportError(message, source, lineno, colno, error) {
    try {
      fetch('/api/client/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: String(message), stack: error?.stack, url: source, line: lineno }),
      }).catch(() => {});
    } catch (_) {}
  }
  window.onerror = (msg, src, line, col, err) => { reportError(msg, src, line, col, err); return false; };
  window.addEventListener('unhandledrejection', e => reportError(e.reason?.message || String(e.reason), 'unhandledrejection'));

  async function load() {
    const r = await fetch('/api/client/me');
    if (r.status === 401) { window.location.href = '/client'; return; }
    const data = await r.json();
    window._data = data;
    render(data);
  }

  async function exitAdminView() {
    await fetch('/portal-admin/exit', { method: 'POST' });
    window.location.href = '/portal-admin/clients';
  }

  function render({ brand, tiktok, tasks, adminImpersonating }) {
    document.getElementById('headerBrand').textContent = brand.name;
    document.title = brand.name + ' — Cult Content';

    // Admin impersonation banner
    if (adminImpersonating) {
      const adminBanner = document.getElementById('adminBanner');
      const adminBrandName = document.getElementById('adminBrandName');
      if (adminBanner) adminBanner.style.display = 'flex';
      if (adminBrandName) adminBrandName.textContent = adminImpersonating;
    }

    // Connect / reconnect banners
    const banner = document.getElementById('tiktokConnectBanner');
    const reconnectBanner = document.getElementById('tiktokReconnectBanner');
    if (banner) banner.style.display = tiktok?.connected ? 'none' : 'flex';
    // Show reconnect banner if connected but needsReconnect flag is set (includes missing shop_cipher)
    if (reconnectBanner) {
      const show = tiktok?.connected && tiktok?.needsReconnect;
      reconnectBanner.style.display = show ? 'flex' : 'none';
      // Tailor the message: missing shop_cipher = incomplete auth vs expired token
      if (show) {
        const subEl = reconnectBanner.querySelector('div > div:last-child');
        if (subEl) {
          subEl.textContent = tiktok?.hasShopCipher === false
            ? 'Your TikTok connection is incomplete — please reconnect to finish linking your shop.'
            : 'Your connection expired. Reconnect to restore live GMV and stats.';
        }
      }
    }

    // Stats
    const s = tiktok?.stats;
    if (s) {
      const gmv    = s.gmv ?? s.total_gmv ?? s.revenue ?? null;
      const orders = s.orders ?? s.total_orders ?? null;
      document.getElementById('sGmv').textContent      = fmt$(gmv);
      document.getElementById('sOrders').textContent   = fmtN(orders);
      document.getElementById('sAov').textContent      = (gmv && orders) ? fmt$(gmv/orders) : '—';
      document.getElementById('sCreators').textContent = fmtN(s.creators ?? s.active_creators ?? s.creator_count);
    }

    // Top creators
    const creators = tiktok?.funnel?.top_creators ?? tiktok?.funnel?.creators ?? [];
    const $cr = document.getElementById('topCreators');
    $cr.innerHTML = creators.length
      ? creators.slice(0,6).map(c => `<div class="list-item"><span class="list-item-name">@${esc(c.handle??c.creator_handle??c.name??'Unknown')}</span><span class="list-item-val">${fmt$(c.gmv??c.revenue??c.sales)}</span></div>`).join('')
      : '<span class="empty">No creator data yet.</span>';

    // Top videos
    const videos = tiktok?.funnel?.top_videos ?? tiktok?.funnel?.videos ?? [];
    const $vd = document.getElementById('topVideos');
    $vd.innerHTML = videos.length
      ? videos.slice(0,6).map(v => `<div class="list-item"><span class="list-item-name">${esc(v.title??v.video_id??'Video')}</span><span class="list-item-val">${fmt$(v.gmv??v.revenue??v.sales)}</span></div>`).join('')
      : '<span class="empty">No video data yet.</span>';

    // Referral
    document.getElementById('refUrl').textContent = brand.referralUrl || '—';
    document.getElementById('commVal').textContent = fmt$(brand.estimatedCommission ?? 0);
    renderReferrals(brand.referrals || []);

    // Campaign controls
    document.getElementById('sampleBudget').value = brand.sampleBudget ?? '';
    const c = brand.compensation || {};
    setIncentive('cashback',    c.cashback);
    setIncentive('leaderboard', c.leaderboard);
    setIncentive('volumeBonus', c.volumeBonus);
    document.getElementById('tInnerCircle').checked = !!brand.innerCircle;

    // Logo
    if (brand.logoUrl) {
      document.getElementById('logoPreview').src = brand.logoUrl;
      document.getElementById('logoPreviewWrap').style.display = 'block';
      document.getElementById('logoRemoveBtn').style.display = 'inline-block';
    }

    // Affiliate page URL
    const affiliateUrl = brand.affiliatePageUrl || '';
    const $aBox = document.getElementById('affiliateUrlBox');
    const $aOpen = document.getElementById('affiliateOpenBtn');
    $aBox.textContent = affiliateUrl || '—';
    if (affiliateUrl) {
      $aOpen.href = affiliateUrl;
      $aOpen.classList.remove('disabled');
    } else {
      $aOpen.href = '#';
      $aOpen.classList.add('disabled');
    }

    // Tasks
    renderTasks(tasks);

    // Connections
    renderConnections(brand);
  }

  function renderReferrals(referrals) {
    const wrap = document.getElementById('refTableWrap');
    const tbody = document.getElementById('refTableBody');
    if (!referrals.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    tbody.innerHTML = referrals.map(r => `
      <tr>
        <td>${esc(r.name) || '<span style="color:var(--muted)">—</span>'}</td>
        <td class="muted">${esc(r.company) || '—'}</td>
        <td class="muted">${esc(r.email) || '—'}</td>
      </tr>`).join('');
  }

  function setIncentive(key, val) {
    const toggle = document.getElementById('t' + key.charAt(0).toUpperCase() + key.slice(1));
    if (!toggle) return;
    const enabled = !!val?.enabled;
    toggle.checked = enabled;
    updateIncentiveUI(key, enabled);
    if (!val) return;
    if (key === 'cashback') {
      document.getElementById('cashbackAmount').value = val.amount ?? '';
      document.getElementById('cashbackTarget').value = val.target ?? '';
    } else if (key === 'leaderboard') {
      const places = val.places || [];
      document.getElementById('lb1').value = places[0] ?? '';
      document.getElementById('lb2').value = places[1] ?? '';
      document.getElementById('lb3').value = places[2] ?? '';
      document.getElementById('lbThreshold').value = val.threshold ?? '';
    } else if (key === 'volumeBonus') {
      document.getElementById('vbQuantity').value = val.quantity ?? '';
      document.getElementById('vbBonus').value = val.bonus ?? '';
    }
  }

  function updateIncentiveUI(key, enabled) {
    const blockId  = 'block'  + key.charAt(0).toUpperCase() + key.slice(1);
    const fieldsId = 'fields' + key.charAt(0).toUpperCase() + key.slice(1);
    const block  = document.getElementById(blockId);
    const fields = document.getElementById(fieldsId);
    if (block)  block.classList.toggle('active', enabled);
    if (fields) fields.classList.toggle('open', enabled);
  }

  function toggleIncentive(key) {
    const toggle = document.getElementById('t' + key.charAt(0).toUpperCase() + key.slice(1));
    updateIncentiveUI(key, toggle.checked);
  }

  function buildCompensation() {
    return {
      cashback: {
        enabled: document.getElementById('tCashback').checked,
        amount:  Number(document.getElementById('cashbackAmount').value) || 0,
        target:  Number(document.getElementById('cashbackTarget').value) || 0,
      },
      leaderboard: {
        enabled:   document.getElementById('tLeaderboard').checked,
        places:    [
          Number(document.getElementById('lb1').value) || 0,
          Number(document.getElementById('lb2').value) || 0,
          Number(document.getElementById('lb3').value) || 0,
        ].filter(v => v > 0),
        threshold: Number(document.getElementById('lbThreshold').value) || 0,
      },
      volumeBonus: {
        enabled:  document.getElementById('tVolumeBonus').checked,
        quantity: Number(document.getElementById('vbQuantity').value) || 0,
        bonus:    Number(document.getElementById('vbBonus').value) || 0,
      },
    };
  }

  
  function renderWeeklyGoals(brand) {
    const goals = brand.weeklyGoals || [];
    const container = document.getElementById('weeklyGoalsList');
    
    if (goals.length === 0) {
      container.innerHTML = `
        <div class="weekly-goals-empty">
          📅<br><br>
          Your account manager will post this week's goals after your Monday call.
        </div>
      `;
      return;
    }
    
    const html = goals.map(goal => `
      <div class="weekly-goal-item">
        <span class="weekly-goal-status ${goal.status}">${goal.status === 'done' ? '✓' : '○'}</span>
        <span class="weekly-goal-text ${goal.status}">${goal.goal}</span>
      </div>
    `).join('');
    
    container.innerHTML = html;
  }

  function renderTasks(tasks) {
    const container = document.getElementById('taskList');
    if (!tasks || tasks.length === 0) {
      container.innerHTML = '<div class="empty-state">No tasks yet</div>';
      return;
    }

    // Sort: In Progress → Open (by updatedAt desc, then createdAt desc) → Done
    const inProgress = tasks.filter(t => t.status === 'in_progress')
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    const open = tasks.filter(t => t.status === 'open')
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    const done = tasks.filter(t => t.status === 'done')
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

    const priorityBadge = (priority) => {
      const colors = { high: '#ff0050', medium: '#fbbf24', low: '#6b7280' };
      const color = colors[priority] || colors.low;
      return `<span class="priority-dot" style="background: ${color}"></span>`;
    };

    const timeAgo = (date) => {
      if (!date) return '';
      const seconds = Math.floor((new Date() - new Date(date)) / 1000);
      if (seconds < 60) return 'just now';
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
      return `${Math.floor(seconds / 86400)}d ago`;
    };

    const renderTask = (task) => {
      const assigneeInitials = task.assignee ? task.assignee.split(' ').map(n => n[0]).join('').toUpperCase() : 'CC';
      const lastUpdated = timeAgo(task.updatedAt || task.createdAt);
      
      return `
        <div class="task-card" data-task-id="${task._id}">
          <div class="task-header">
            ${priorityBadge(task.priority)}
            <span class="task-title">${task.title}</span>
            <span class="task-assignee">${assigneeInitials}</span>
          </div>
          <div class="task-meta">
            <span class="task-updated">${lastUpdated}</span>
          </div>
          <button class="task-comment-btn" onclick="openTaskComment('${task._id}')">
            💬 Ask a question
          </button>
          <div class="task-comment-input" id="comment-${task._id}" style="display: none;">
            <textarea placeholder="Type your question..." rows="3"></textarea>
            <button onclick="submitTaskComment('${task._id}')">Send</button>
          </div>
        </div>
      `;
    };

    let html = '';
    
    if (inProgress.length > 0) {
      html += '<div class="task-section"><h4>In Progress</h4>';
      html += inProgress.map(renderTask).join('');
      html += '</div>';
    }
    
    if (open.length > 0) {
      html += '<div class="task-section"><h4>Open</h4>';
      html += open.map(renderTask).join('');
      html += '</div>';
    }
    
    if (done.length > 0) {
      html += `
        <div class="task-section done-section">
          <h4 class="done-toggle" onclick="toggleDoneTasks()">
            ✓ Completed (${done.length})
            <span class="toggle-arrow">▼</span>
          </h4>
          <div class="done-tasks" id="doneTasks" style="display: none;">
            ${done.map(renderTask).join('')}
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  }

  function toggleDoneTasks() {
    const doneSection = document.getElementById('doneTasks');
    const arrow = document.querySelector('.toggle-arrow');
    if (doneSection.style.display === 'none') {
      doneSection.style.display = 'block';
      arrow.textContent = '▲';
    } else {
      doneSection.style.display = 'none';
      arrow.textContent = '▼';
    }
  }

  function openTaskComment(taskId) {
    const input = document.getElementById('comment-' + taskId);
    input.style.display = input.style.display === 'none' ? 'block' : 'none';
  }

  async function submitTaskComment(taskId) {
    const input = document.querySelector(`#comment-${taskId} textarea`);
    const message = input.value.trim();
    if (!message) return;

    try {
      const res = await fetch('/api/client/task-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, message })
      });

      if (res.ok) {
        input.value = '';
        document.getElementById('comment-' + taskId).style.display = 'none';
        alert('Question sent to your account manager');
      } else {
        alert('Failed to send question');
      }
    } catch (err) {
      console.error(err);
      alert('Error sending question');
    }
  }

  
  function renderTaskCard(task) {
    const priorityDots = {
      high: '<span class="priority-dot priority-high" title="High priority"></span>',
      medium: '<span class="priority-dot priority-medium" title="Medium priority"></span>',
      low: '<span class="priority-dot priority-low" title="Low priority"></span>'
    };
    
    const priorityBadge = priorityDots[task.priority] || '';
    const assigneeInitials = task.assignee ? task.assignee.split(' ').map(n => n[0]).join('').toUpperCase() : '';
    const lastUpdated = task.updatedAt || task.createdAt;
    const timeAgo = getRelativeTime(lastUpdated);
    
    const statusBadge = task.status === 'in_progress' ? '<span class="task-status-badge in-progress">In Progress</span>' :
                        task.status === 'done' ? '<span class="task-status-badge done">Done</span>' : '';
    
    return `
      <div class="task-card task-${task.status}">
        <div class="task-header">
          <div class="task-title-row">
            ${priorityBadge}
            <span class="task-title">${task.title}</span>
            ${statusBadge}
          </div>
          <div class="task-meta">
            ${assigneeInitials ? `<span class="assignee-badge">${assigneeInitials}</span>` : ''}
            <span class="task-time">${timeAgo}</span>
          </div>
        </div>
        <div class="task-description">${task.description || ''}</div>
        <div class="task-actions">
          <button class="task-comment-btn" onclick="openTaskComment('${task.id || task._id}')">💬 Ask a question</button>
        </div>
        <div id="comment-box-${task.id || task._id}" class="task-comment-box" style="display: none;">
          <textarea id="comment-input-${task.id || task._id}" placeholder="Type your question or comment..."></textarea>
          <div class="comment-box-actions">
            <button onclick="sendTaskComment('${task.id || task._id}')">Send</button>
            <button onclick="closeTaskComment('${task.id || task._id}')">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }
  
  function getRelativeTime(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }
  
  function toggleDoneSection() {
    const doneTasks = document.getElementById('doneTasks');
    const toggle = document.querySelector('.done-toggle');
    if (doneTasks.style.display === 'none') {
      doneTasks.style.display = 'block';
      toggle.textContent = '▲';
    } else {
      doneTasks.style.display = 'none';
      toggle.textContent = '▼';
    }
  }
  
  function openTaskComment(taskId) {
    document.getElementById('comment-box-' + taskId).style.display = 'block';
  }
  
  function closeTaskComment(taskId) {
    document.getElementById('comment-box-' + taskId).style.display = 'none';
    document.getElementById('comment-input-' + taskId).value = '';
  }
  
  async function sendTaskComment(taskId) {
    const input = document.getElementById('comment-input-' + taskId);
    const message = input.value.trim();
    
    if (!message) return;
    
    try {
      const res = await fetch('/api/client/task-comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, message })
      });
      
      if (res.ok) {
        closeTaskComment(taskId);
        showToast('Question sent to your account manager');
      } else {
        showToast('Failed to send comment', 'error');
      }
    } catch (err) {
      console.error('Error sending task comment:', err);
      showToast('Failed to send comment', 'error');
    }
  }
  
  function showToast(message, type = 'success') {
    // Simple toast notification
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }  
  function renderTaskCard(task, isDone) {
    const priorityDot = {
      high: '<span class="priority-dot high" title="High priority">●</span>',
      medium: '<span class="priority-dot medium" title="Medium priority">●</span>',
      low: '<span class="priority-dot low" title="Low priority">●</span>'
    }[task.priority || 'low'];
    
    const assignee = task.assignee || 'CC';
    const initials = assignee.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);
    
    const lastUpdated = task.updatedAt || task.createdAt;
    const timeAgo = formatTimeAgo(new Date(lastUpdated));
    
    const statusBadge = task.status === 'in_progress' 
      ? '<span class="task-status in-progress">In Progress</span>'
      : task.status === 'done'
      ? '<span class="task-status done">Done</span>'
      : '';
    
    return `
      <div class="task-card ${isDone ? 'done' : ''}">
        <div class="task-header">
          <div class="task-meta">
            ${priorityDot}
            <span class="task-assignee">${initials}</span>
            <span class="task-updated">${timeAgo}</span>
          </div>
          ${statusBadge}
        </div>
        <div class="task-title">${task.title}</div>
        ${task.description ? `<div class="task-desc">${task.description}</div>` : ''}
        ${!isDone ? `
          <button class="task-comment-btn" onclick="openTaskComment('${task.id}')">
            💬 Ask a question
          </button>
          <div class="task-comment-form" id="commentForm${task.id}" style="display:none;">
            <textarea id="commentText${task.id}" placeholder="Type your question or comment..." rows="3"></textarea>
            <div class="task-comment-actions">
              <button onclick="cancelTaskComment('${task.id}')">Cancel</button>
              <button class="primary" onclick="submitTaskComment('${task.id}')">Send</button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  function formatTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
    return Math.floor(seconds / 604800) + 'w ago';
  }
  
  function toggleDoneTasks() {
    const list = document.getElementById('doneTasksList');
    const toggle = document.getElementById('doneToggle');
    if (list.style.display === 'none') {
      list.style.display = 'block';
      toggle.textContent = '▲';
    } else {
      list.style.display = 'none';
      toggle.textContent = '▼';
    }
  }
  
  function openTaskComment(taskId) {
    document.getElementById('commentForm' + taskId).style.display = 'block';
    document.getElementById('commentText' + taskId).focus();
  }
  
  function cancelTaskComment(taskId) {
    document.getElementById('commentForm' + taskId).style.display = 'none';
    document.getElementById('commentText' + taskId).value = '';
  }
  
  async function submitTaskComment(taskId) {
    const message = document.getElementById('commentText' + taskId).value.trim();
    if (!message) return;
    
    try {
      const resp = await fetch('/api/client/task-comment', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({taskId, message})
      });
      
      if (resp.ok) {
        alert('Question sent! Your account manager will respond shortly.');
        cancelTaskComment(taskId);
      } else {
        alert('Failed to send comment. Please try again.');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to send comment. Please try again.');
    }
  }
  function copyRef() {
    const url = document.getElementById('refUrl').textContent;
    if (!url.startsWith('http')) return;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copyBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy Link'; }, 2200);
    });
  }

  function toggleAddRef() {
    const form = document.getElementById('addRefForm');
    form.classList.toggle('open');
    document.getElementById('addRefToggle').textContent = form.classList.contains('open') ? '− Cancel' : '+ Log a Referral';
  }

  async function addReferral() {
    const name    = document.getElementById('refName').value.trim();
    const company = document.getElementById('refCompany').value.trim();
    const email   = document.getElementById('refEmail').value.trim();
    if (!name && !email) { alert('Enter a name or email.'); return; }
    const r = await fetch('/api/client/referrals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, company, email }),
    });
    const data = await r.json();
    if (r.ok) {
      const referrals = (window._data?.brand?.referrals || []);
      referrals.push(data.referral);
      if (window._data) window._data.brand.referrals = referrals;
      renderReferrals(referrals);
      document.getElementById('refName').value = '';
      document.getElementById('refCompany').value = '';
      document.getElementById('refEmail').value = '';
      toggleAddRef();
    }
  }

  async function saveSettings() {
    const st = document.getElementById('saveStatus');
    st.style.color = 'var(--muted)'; st.textContent = 'Saving…';
    try {
      const r = await fetch('/api/client/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleBudget: Number(document.getElementById('sampleBudget').value) || 0,
          compensation: buildCompensation(),
          innerCircle: document.getElementById('tInnerCircle').checked,
        }),
      });
      if (r.ok) { st.style.color = 'var(--green)'; st.textContent = '✓ Saved'; }
      else       { st.style.color = 'var(--red)';   st.textContent = 'Save failed'; }
    } catch (_) { st.style.color = 'var(--red)'; st.textContent = 'Network error'; }
    setTimeout(() => { st.textContent = ''; }, 3000);
  }

  async function uploadLogo(input) {
    if (!input.files[0]) return;
    const st = document.getElementById('logoStatus');
    st.style.color = 'var(--muted)'; st.textContent = 'Uploading…';
    const fd = new FormData();
    fd.append('logo', input.files[0]);
    try {
      const r = await fetch('/api/client/logo', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.ok) {
        document.getElementById('logoPreview').src = d.logoUrl;
        document.getElementById('logoPreviewWrap').style.display = 'block';
        document.getElementById('logoRemoveBtn').style.display = 'inline-block';
        if (window._data?.brand) window._data.brand.logoUrl = d.logoUrl;
        st.style.color = 'var(--green)'; st.textContent = '✓ Logo saved';
      } else { st.style.color = 'var(--red)'; st.textContent = d.error || 'Upload failed'; }
    } catch(_) { st.style.color = 'var(--red)'; st.textContent = 'Network error'; }
    setTimeout(() => { st.textContent = ''; }, 3000);
    input.value = '';
  }

  async function removeLogo() {
    const st = document.getElementById('logoStatus');
    st.style.color = 'var(--muted)'; st.textContent = 'Removing…';
    try {
      await fetch('/api/client/logo', { method: 'DELETE' });
      document.getElementById('logoPreviewWrap').style.display = 'none';
      document.getElementById('logoRemoveBtn').style.display = 'none';
      document.getElementById('logoPreview').src = '';
      if (window._data?.brand) window._data.brand.logoUrl = null;
      st.style.color = 'var(--green)'; st.textContent = '✓ Removed';
    } catch(_) { st.style.color = 'var(--red)'; st.textContent = 'Network error'; }
    setTimeout(() => { st.textContent = ''; }, 3000);
  }

  async function doLogout() {
    await fetch('/client/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/client';
  }

  // ─── Tab navigation ────────────────────────────────────────────────────────
  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none');
    document.getElementById('tab-' + name).style.display = 'block';
    const btns = document.querySelectorAll('.tab-btn');
    const labels = { 'overview': 'Overview', 'content-studio': 'Content Studio', 'billing': 'Billing' };
    btns.forEach(b => { if (b.textContent.trim() === labels[name]) b.classList.add('active'); });
    if (name === 'content-studio' && !window._channelsLoaded) loadChannels();
    if (name === 'content-studio' && !window._arcadsLoaded) loadArcads();
    if (name === 'content-studio' && !window._assetsLoaded) { window._assetsLoaded = true; loadBrandAssets(); }
    if (name === 'content-studio' && window._data?.brand) wizardInitBrandSummary();
    if (name === 'content-studio' && !window._storistaLoaded) initStorista(window._data?.brand);
    if (name === 'billing' && !window._billingLoaded) loadBilling();
  }

  // ─── Affiliate URL ──────────────────────────────────────────────────────────
  function copyAffiliateUrl() {
    const url = document.getElementById('affiliateUrlBox').textContent;
    if (!url || url === '—') return;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('affiliateCopyBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2200);
    });
  }

  function toggleAffiliateEdit() {
    const form = document.getElementById('affiliateEditForm');
    form.classList.toggle('open');
    if (form.classList.contains('open')) {
      const cur = document.getElementById('affiliateUrlBox').textContent;
      document.getElementById('affiliateEditInput').value = cur === '—' ? '' : cur;
      document.getElementById('affiliateEditInput').focus();
    }
  }

  async function saveAffiliateUrl() {
    const url = document.getElementById('affiliateEditInput').value.trim();
    try {
      const r = await fetch('/api/client/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ affiliatePageUrl: url }),
      });
      if (!r.ok) throw new Error('Save failed');
      const $box = document.getElementById('affiliateUrlBox');
      const $open = document.getElementById('affiliateOpenBtn');
      $box.textContent = url || '—';
      if (url) { $open.href = url; $open.classList.remove('disabled'); }
      else      { $open.href = '#'; $open.classList.add('disabled'); }
      document.getElementById('affiliateEditForm').classList.remove('open');
      if (window._data?.brand) window._data.brand.affiliatePageUrl = url;
    } catch(e) { alert('Failed to save URL: ' + e.message); }
  }

  // ─── Content Studio: Upload & Publish ──────────────────────────────────────
  let _uploadedVideoUrl = null;
  let _selectedFile = null;
  let _selectedChannelIds = new Set();

  function onDragOver(e) { e.preventDefault(); document.getElementById('dropZone').classList.add('dragover'); }
  function onDragLeave(e) { document.getElementById('dropZone').classList.remove('dragover'); }
  function onDrop(e) {
    e.preventDefault();
    document.getElementById('dropZone').classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) uploadVideo(file);
  }
  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) uploadVideo(file);
  }

  async function uploadVideo(file) {
    _selectedFile = file;
    const progress = document.getElementById('uploadProgress');
    const result = document.getElementById('uploadResult');
    const transcribeDone = document.getElementById('transcribeDone');
    progress.style.display = 'block';
    result.style.display = 'none';
    transcribeDone.style.display = 'none';
    document.getElementById('transcribeProgress').style.display = 'none';
    _uploadedVideoUrl = null;
    try {
      const fd = new FormData();
      fd.append('video', file);
      const r = await fetch('/api/upload/video', { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Upload failed');
      _uploadedVideoUrl = data.url;
      progress.style.display = 'none';
      document.getElementById('uploadedFilename').textContent = data.filename || file.name;
      result.style.display = 'flex';
      document.getElementById('captionSection').style.display = 'block';
      // Auto-transcribe immediately after upload
      transcribeVideo();
    } catch(e) {
      progress.style.display = 'none';
      alert('Upload error: ' + e.message);
    }
  }

  async function transcribeVideo() {
    if (!_selectedFile) return;
    const prog = document.getElementById('transcribeProgress');
    const done = document.getElementById('transcribeDone');
    done.style.display = 'none';
    prog.style.display = 'block';
    try {
      const fd = new FormData();
      fd.append('audio', _selectedFile);
      const r = await fetch('/api/whisper-transcribe', { method: 'POST', body: fd });
      const data = await r.json();
      prog.style.display = 'none';
      if (data.text) {
        document.getElementById('captionArea').value = data.text;
        document.getElementById('captionSection').style.display = 'block';
        done.style.display = 'block';
      } else {
        done.style.display = 'none';
      }
    } catch(e) {
      prog.style.display = 'none';
    }
  }

  async function loadChannels() {
    window._channelsLoaded = true;
    const $badge = document.getElementById('bufferConnBadge');
    const $note  = document.getElementById('bufferConnNote');
    try {
      const r = await fetch('/api/client/buffer/channels');
      const data = await r.json();
      const channels = data.channels || [];
      const $list = document.getElementById('channelList');

      if (!channels.length) {
        $list.innerHTML = '<span class="empty">No channels connected.</span>';
        $badge.textContent = '⚠ Buffer not connected';
        $badge.className = 'conn-badge disconnected';
        $badge.style.display = 'inline-flex';
        $note.textContent = 'Contact your account manager to connect your social channels.';
        $note.style.display = 'block';
        return;
      }

      $badge.textContent = '● Buffer Connected — ' + channels.length + ' channel' + (channels.length !== 1 ? 's' : '');
      $badge.className = 'conn-badge connected';
      $badge.style.display = 'inline-flex';
      $note.style.display = 'none';

      $list.innerHTML = channels.map(ch => `
        <div class="channel-item" id="ch-${esc(ch.id)}" onclick="toggleChannel('${esc(ch.id)}')">
          ${ch.avatarUrl ? `<img src="${esc(ch.avatarUrl)}" alt="">` : '<div style="width:28px;height:28px;border-radius:50%;background:var(--border);flex-shrink:0"></div>'}
          <div class="channel-item-info">
            <div class="channel-name">${esc(ch.name)}</div>
            <div class="channel-service">${esc(ch.service)}</div>
          </div>
          <span class="channel-check">✓</span>
        </div>`).join('');
      window._channels = channels;

      // Also populate Storista cross-post channel picker
      const $stor = document.getElementById('storistaBufferChannels');
      if ($stor) {
        $stor.innerHTML = channels.map(ch => `
          <div class="channel-item" id="sbch-${esc(ch.id)}" onclick="toggleStoristaBufferChannel('${esc(ch.id)}','${esc(ch.service||'')}')" data-service="${esc(ch.service||'')}">
            ${ch.avatarUrl ? `<img src="${esc(ch.avatarUrl)}" alt="">` : '<div style="width:24px;height:24px;border-radius:50%;background:var(--border);flex-shrink:0"></div>'}
            <div class="channel-item-info">
              <div class="channel-name">${esc(ch.name)}</div>
              <div class="channel-service">${esc(ch.service)}</div>
            </div>
            <span class="channel-check">✓</span>
          </div>`).join('');
        document.getElementById('storistaBufferSection').style.display = '';
      }
    } catch(e) {
      document.getElementById('channelList').innerHTML = '<span class="empty">Failed to load channels.</span>';
      $badge.textContent = '⚠ Buffer not connected';
      $badge.className = 'conn-badge disconnected';
      $badge.style.display = 'inline-flex';
      $note.textContent = 'Contact your account manager to connect your social channels.';
      $note.style.display = 'block';
    }
  }

  function toggleChannel(id) {
    const el = document.getElementById('ch-' + id);
    if (!el) return;
    if (_selectedChannelIds.has(id)) { _selectedChannelIds.delete(id); el.classList.remove('selected'); }
    else { _selectedChannelIds.add(id); el.classList.add('selected'); }
  }

  // Buffer channels selected for Storista cross-posting
  var _storistaBufferChannels = new Map(); // id → service
  function toggleStoristaBufferChannel(id, service) {
    const el = document.getElementById('sbch-' + id);
    if (!el) return;
    if (_storistaBufferChannels.has(id)) { _storistaBufferChannels.delete(id); el.classList.remove('selected'); }
    else { _storistaBufferChannels.set(id, service); el.classList.add('selected'); }
  }

  async function postToChannels(schedule) {
    const caption = document.getElementById('captionArea').value.trim();
    if (!caption) { alert('Please add a caption first.'); return; }
    if (!_selectedChannelIds.size) { alert('Select at least one channel.'); return; }
    const $st = document.getElementById('postStatus');
    $st.style.color = 'var(--muted)'; $st.textContent = 'Posting…';
    const scheduledAt = schedule ? document.getElementById('scheduleAt').value : null;
    try {
      const r = await fetch('/api/client/buffer/post-to-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelIds: Array.from(_selectedChannelIds),
          text: caption,
          mediaUrl: _uploadedVideoUrl || undefined,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        $st.style.color = 'var(--green)'; $st.textContent = schedule ? '✓ Scheduled!' : '✓ Posted!';
      } else {
        $st.style.color = 'var(--red)'; $st.textContent = 'Error: ' + (data.error || 'Post failed');
      }
    } catch(e) { $st.style.color = 'var(--red)'; $st.textContent = 'Network error'; }
    setTimeout(() => { $st.textContent = ''; }, 4000);
  }

  // ─── Content Studio: Brand Assets + Create ────────────────────────────────
  var _allAssets = [];
  var _allProducts = [];
  var _activeProductFilter = null;
  var _selectedProductId = null;
  var _selectedProductName = '';
  var _overlayVideo = null;         // { url, file }
  var _overlayItems = [];           // [{type, text, x, y, fontSize, color, bold, url, width}]

  async function loadBrandAssets() {
    const [assetsRes, productsRes] = await Promise.all([
      fetch('/api/client/assets').then(r => r.json()).catch(() => ({ assets: [] })),
      fetch('/api/client/products').then(r => r.json()).catch(() => ({ products: [] })),
    ]);

    _allAssets   = assetsRes.assets   || [];
    _allProducts = productsRes.products || [];

    // Build product dropdown list
    const selectEl = document.getElementById('assetProductSelect');
    selectEl.innerHTML = `<option value="">No product (general)</option>` +
      _allProducts.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    renderProductDropdownList(_allProducts);

    // Build product chips in Create section
    const chipEl = document.getElementById('createProductGrid');
    if (!_allProducts.length) {
      chipEl.innerHTML = '<div class="empty" style="font-size:0.82rem;color:var(--muted);padding:12px 0;">No active TikTok Shop products found. Connect TikTok Shop first.</div>';
    } else {
      chipEl.innerHTML = _allProducts.map(p => {
        const img = p.images?.[0] || '';
        return `<div class="product-chip" id="pchip-${esc(p.id)}" onclick="selectCreateProduct('${esc(p.id)}','${esc(p.name.replace(/'/g,"\\\'"))}')">
          ${img ? `<img src="${esc(img)}" alt="">` : ''}
          <span>${esc(p.name)}</span>
        </div>`;
      }).join('');
    }

    renderAssetGrid(_allAssets);
  }

  function renderProductDropdownList(products) {
    const list = document.getElementById('assetProductDropdownList');
    if (!list) return;
    list.innerHTML = `<div style="padding:8px 14px;font-size:0.8rem;color:var(--muted);cursor:pointer;border-bottom:1px solid var(--border);" onclick="selectAssetProduct(null,'All products')">All products</div>` +
      products.map(p => `<div style="padding:8px 14px;font-size:0.82rem;color:var(--text);cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,0.04);" onclick="selectAssetProduct('${esc(p.id)}','${esc(p.name.replace(/'/g,"\\\'"))}')">
        ${p.images?.[0] ? `<img src="${esc(p.images[0])}" style="width:28px;height:28px;object-fit:cover;border-radius:4px;flex-shrink:0">` : '<div style="width:28px;height:28px;background:var(--border);border-radius:4px;flex-shrink:0"></div>'}
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.name)}</span>
      </div>`).join('');
  }

  function showProductDropdown() {
    document.getElementById('assetProductDropdown').style.display = 'block';
  }
  function hideProductDropdown() {
    document.getElementById('assetProductDropdown').style.display = 'none';
  }

  function filterAssetsBySearch(q) {
    const lower = q.toLowerCase();
    const filtered = _allProducts.filter(p => p.name.toLowerCase().includes(lower));
    renderProductDropdownList(filtered);
    showProductDropdown();
  }

  function selectAssetProduct(productId, name) {
    _activeProductFilter = productId;
    document.getElementById('assetProductSearch').value = productId ? name : '';
    document.getElementById('assetProductSelect').value = productId || '';
    hideProductDropdown();
    const filterBar = document.getElementById('assetActiveFilter');
    const filterLabel = document.getElementById('assetFilterLabel');
    if (productId) {
      filterBar.style.display = 'flex';
      filterLabel.textContent = '🔖 ' + name;
    } else {
      filterBar.style.display = 'none';
    }
    const filtered = productId ? _allAssets.filter(a => a.productId === productId) : _allAssets;
    renderAssetGrid(filtered);
  }

  function clearAssetFilter() {
    selectAssetProduct(null, '');
  }

  function filterAssets(productId, btn) {
    selectAssetProduct(productId, btn?.textContent || '');
  }

  function renderAssetGrid(assets) {
    const grid = document.getElementById('assetGrid');
    // Always show product images from TikTok Shop (read-only)
    const productImages = _allProducts.flatMap(p =>
      (p.images || []).map(url => ({ _productImg: true, productId: p.id, productName: p.name, url }))
    );
    const filtered = _activeProductFilter
      ? productImages.filter(i => i.productId === _activeProductFilter)
      : productImages;

    const allTiles = [
      ...filtered.map(img => `
        <div class="asset-tile" title="${esc(img.productName)}">
          <img src="${esc(img.url)}" alt="" loading="lazy">
          <div class="asset-badge">TikTok Shop</div>
        </div>`),
      ...assets.map(a => `
        <div class="asset-tile" title="${esc(a.name)}">
          ${a.type === 'video'
            ? `<video src="${esc(a.url)}" preload="metadata"></video>`
            : `<img src="${esc(a.url)}" alt="" loading="lazy">`}
          <div class="asset-badge">${a.type === 'video' ? '▶' : '🖼'}</div>
          <button class="asset-del" onclick="deleteAsset('${esc(a.id)}',event)">✕</button>
        </div>`),
    ];
    grid.innerHTML = allTiles.length
      ? allTiles.join('')
      : '<div class="empty" style="grid-column:1/-1;padding:24px 0;text-align:center;font-size:0.82rem;color:var(--muted);">No assets yet. Upload images or videos below, or connect TikTok Shop to see product images.</div>';
  }

  async function uploadAsset(input) {
    if (!input.files[0]) return;
    const st = document.getElementById('assetUploadStatus');
    st.style.color = 'var(--muted)'; st.textContent = 'Uploading…';
    const fd = new FormData();
    fd.append('asset', input.files[0]);
    const productId = document.getElementById('assetProductSelect').value;
    if (productId) fd.append('productId', productId);
    try {
      const r = await fetch('/api/client/assets/upload', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.ok) {
        _allAssets.push(d.asset);
        renderAssetGrid(_activeProductFilter ? _allAssets.filter(a => a.productId === _activeProductFilter) : _allAssets);
        st.style.color = 'var(--green)'; st.textContent = '✓ Uploaded';
      } else { st.style.color = 'var(--red)'; st.textContent = d.error || 'Upload failed'; }
    } catch(_) { st.style.color = 'var(--red)'; st.textContent = 'Network error'; }
    input.value = '';
    setTimeout(() => { st.textContent = ''; }, 3000);
  }

  async function deleteAsset(id, e) {
    e.stopPropagation();
    if (!confirm('Remove this asset?')) return;
    await fetch(`/api/client/assets/${id}`, { method: 'DELETE' });
    _allAssets = _allAssets.filter(a => a.id !== id);
    renderAssetGrid(_activeProductFilter ? _allAssets.filter(a => a.productId === _activeProductFilter) : _allAssets);
  }

  function selectCreateProduct(id, name) {
    _selectedProductId   = id;
    _selectedProductName = name;
    document.querySelectorAll('.product-chip').forEach(c => c.classList.remove('selected'));
    const chip = document.getElementById('pchip-' + id);
    if (chip) chip.classList.add('selected');
    document.getElementById('createFormatRow').style.display = '';
    document.getElementById('createTextOverlay').style.display = 'none';
  }

  function selectFormat(format, btn) {
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('createTextOverlay').style.display = format === 'textOverlay' ? '' : 'none';
  }

  // ─── Text Overlay Editor ───────────────────────────────────────────────────
  function overlayLoadVideo(input) {
    if (!input.files[0]) return;
    const file = input.files[0];
    const url  = URL.createObjectURL(file);
    _overlayVideo = { url, file, name: file.name };
    document.getElementById('overlayVideoEl').src = url;
    document.getElementById('overlayVideoEl').style.display = '';
    document.getElementById('overlayVideoEl').play().catch(() => {});
    document.getElementById('overlayVideoPicker').style.display = 'none';
    document.getElementById('overlayVideoName').textContent = file.name;
    document.getElementById('overlayRenderBtn').disabled = false;
    renderOverlayList();
  }

  function overlayAddText() {
    _overlayItems.push({ type: 'text', text: 'Your text here', x: 10, y: 50, fontSize: 48, color: '#ffffff', bold: true });
    renderOverlayList();
    updateOverlayCanvas();
  }

  function overlayAddLogo(input) {
    if (!input.files[0]) return;
    const url = URL.createObjectURL(input.files[0]);
    _overlayItems.push({ type: 'logo', url, _file: input.files[0], x: 10, y: 10, width: 80 });
    renderOverlayList();
    updateOverlayCanvas();
    input.value = '';
  }

  function overlayRemove(i) {
    _overlayItems.splice(i, 1);
    renderOverlayList();
    updateOverlayCanvas();
  }

  function overlayUpdate(i, field, val) {
    if (!_overlayItems[i]) return;
    _overlayItems[i][field] = field === 'bold' ? val : (isNaN(Number(val)) ? val : (field === 'color' ? val : Number(val)));
    if (field === 'color') _overlayItems[i].color = val;
    updateOverlayCanvas();
  }

  function renderOverlayList() {
    const el = document.getElementById('overlayList');
    el.innerHTML = _overlayItems.map((item, i) => {
      if (item.type === 'text') return `
        <div class="overlay-item">
          <div class="overlay-label">Text Overlay</div>
          <div class="overlay-item-row">
            <input class="overlay-input" type="text" value="${esc(item.text)}" placeholder="Text…" oninput="overlayUpdate(${i},'text',this.value)">
            <button class="overlay-del" onclick="overlayRemove(${i})">✕</button>
          </div>
          <div class="overlay-item-row" style="margin-top:6px;">
            <div><div class="overlay-label">X%</div><input class="overlay-input overlay-input-sm" type="number" value="${item.x}" min="0" max="100" oninput="overlayUpdate(${i},'x',this.value)"></div>
            <div><div class="overlay-label">Y%</div><input class="overlay-input overlay-input-sm" type="number" value="${item.y}" min="0" max="100" oninput="overlayUpdate(${i},'y',this.value)"></div>
            <div><div class="overlay-label">Size</div><input class="overlay-input overlay-input-sm" type="number" value="${item.fontSize}" min="12" max="120" oninput="overlayUpdate(${i},'fontSize',this.value)"></div>
            <div><div class="overlay-label">Color</div><input type="color" value="${item.color || '#ffffff'}" style="width:36px;height:28px;border:none;cursor:pointer;background:none;" onchange="overlayUpdate(${i},'color',this.value)"></div>
          </div>
        </div>`;
      else return `
        <div class="overlay-item">
          <div class="overlay-label">Logo</div>
          <div class="overlay-item-row">
            <img src="${item.url}" style="height:32px;border-radius:4px;object-fit:contain;background:rgba(255,255,255,0.1);padding:2px;">
            <div><div class="overlay-label">X%</div><input class="overlay-input overlay-input-sm" type="number" value="${item.x}" min="0" max="100" oninput="overlayUpdate(${i},'x',this.value)"></div>
            <div><div class="overlay-label">Y%</div><input class="overlay-input overlay-input-sm" type="number" value="${item.y}" min="0" max="100" oninput="overlayUpdate(${i},'y',this.value)"></div>
            <div><div class="overlay-label">W%</div><input class="overlay-input overlay-input-sm" type="number" value="${item.width || 80}" min="10" max="100" oninput="overlayUpdate(${i},'width',this.value)"></div>
            <button class="overlay-del" onclick="overlayRemove(${i})">✕</button>
          </div>
        </div>`;
    }).join('');
  }

  function updateOverlayCanvas() {
    const canvas = document.getElementById('overlayCanvas');
    const wrap   = document.getElementById('overlayVideoWrap');
    const W = wrap.offsetWidth, H = wrap.offsetHeight;
    canvas.innerHTML = _overlayItems.map(item => {
      if (item.type === 'text') {
        const x = (item.x / 100) * W;
        const y = (item.y / 100) * H;
        const size = Math.round((item.fontSize / 100) * H * 0.2 + 10);
        return `<div style="position:absolute;left:${x}px;top:${y}px;color:${item.color || '#fff'};font-size:${Math.min(item.fontSize/3, 28)}px;font-weight:${item.bold ? '700' : '400'};text-shadow:1px 1px 3px #000;pointer-events:none;white-space:nowrap;max-width:90%;">${esc(item.text)}</div>`;
      } else {
        const x = (item.x / 100) * W;
        const y = (item.y / 100) * H;
        const w = (item.width / 100) * W;
        return `<img src="${item.url}" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;pointer-events:none;">`;
      }
    }).join('');
  }

  async function overlayRender() {
    if (!_overlayVideo) { alert('Upload a video first.'); return; }
    const btn = document.getElementById('overlayRenderBtn');
    const st  = document.getElementById('overlayRenderStatus');

    // First upload the video to get a server URL
    st.style.color = 'var(--muted)'; st.textContent = 'Uploading video…';
    btn.disabled = true;

    let videoServerUrl = null;
    try {
      const fd = new FormData();
      fd.append('asset', _overlayVideo.file, _overlayVideo.name);
      const r = await fetch('/api/client/assets/upload', { method: 'POST', body: fd });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Upload failed');
      videoServerUrl = d.asset.url;
    } catch(e) {
      st.style.color = 'var(--red)'; st.textContent = 'Upload failed: ' + e.message;
      btn.disabled = false; return;
    }

    // Upload any logo files
    const logoMap = {};
    for (const item of _overlayItems.filter(o => o.type === 'logo' && o._file)) {
      st.textContent = 'Uploading logo…';
      const fd = new FormData();
      fd.append('asset', item._file, item._file.name);
      const r = await fetch('/api/client/assets/upload', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.ok) logoMap[item.url] = d.asset.url;
    }

    // Send render request
    st.textContent = '⏳ Rendering… (this may take a minute)';
    const overlaysForServer = _overlayItems.map(item => ({
      ...item,
      url: item.type === 'logo' ? (logoMap[item.url] || item.url) : undefined,
    }));

    try {
      const r = await fetch('/api/client/overlay/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: videoServerUrl, overlays: overlaysForServer }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      st.style.color = 'var(--green)';
      st.innerHTML = `✓ Done! <a href="${d.outputUrl}" download="${d.filename}" style="color:var(--teal);margin-left:6px;">⬇ Download</a> <button onclick="sendToPublishing('${d.outputUrl}','${d.filename}')" style="margin-left:8px;background:var(--teal);color:#000;border:none;border-radius:6px;padding:4px 10px;font-size:0.78rem;font-weight:700;cursor:pointer;">→ Send to Content Publishing</button>`;
    } catch(e) {
      st.style.color = 'var(--red)'; st.textContent = 'Render failed: ' + e.message;
    }
    btn.disabled = false;
  }

  function sendToPublishing(url, filename) {
    // Switch to Content Publishing and pre-load this video into Storista queue
    // For now just switch tab — Storista picker will be open
    switchTab('content-studio');
    alert('Video rendered! Scroll down to Content Publishing, then use "Add Videos" to upload your rendered file.');
  }

  // ─── Content Studio: Arcads ────────────────────────────────────────────────
  async function loadArcads() {
    window._arcadsLoaded = true;
    document.getElementById('arcVideoList').innerHTML = '<span class="empty">Loading…</span>';
    const $badge = document.getElementById('arcadsConnBadge');
    const $note  = document.getElementById('arcadsConnNote');
    try {
      const r = await fetch('/api/client/arcads/stats');
      const data = await r.json();
      const scripts = data.scripts || [];
      let totalVideos = 0, pending = 0;
      scripts.forEach(s => { (s.videos || []).forEach(v => { totalVideos++; if (!v.video_url && !v.url) pending++; }); });
      document.getElementById('arcScripts').textContent  = scripts.length;
      document.getElementById('arcVideos').textContent   = totalVideos;
      document.getElementById('arcPending').textContent  = pending;
      renderArcadsList(scripts);
      $badge.textContent = '● Arcads Connected';
      $badge.className = 'conn-badge connected';
      $badge.style.display = 'inline-flex';
      $note.style.display = 'none';
      // Initialize wizard brand summary now that we know Arcads is connected
      wizardInitBrandSummary();
    } catch(e) {
      document.getElementById('arcVideoList').innerHTML = `<span class="empty">Failed to load: ${esc(e.message)}</span>`;
      $badge.textContent = '⚠ Arcads not connected';
      $badge.className = 'conn-badge disconnected';
      $badge.style.display = 'inline-flex';
      $note.textContent = 'Contact your account manager to connect Arcads.';
      $note.style.display = 'block';
    }
  }

  function renderArcadsList(scripts) {
    const $list = document.getElementById('arcVideoList');
    if (!scripts.length) { $list.innerHTML = '<span class="empty">No scripts yet. Create one above.</span>'; return; }
    $list.innerHTML = scripts.map(s => {
      const videos = s.videos || [];
      const subList = videos.length ? videos.map(v => {
        const url = v.video_url || v.url || v.videoUrl;
        return `<div class="video-sub-item">
          <span style="color:var(--muted)">${esc(v.id || 'Video')}</span>
          ${url ? `<a class="video-watch-btn" href="${esc(url)}" target="_blank" rel="noopener">▶ Watch</a>` : '<span style="color:var(--muted);font-size:0.77rem">⏳ Generating…</span>'}
        </div>`;
      }).join('') : '<span class="empty" style="padding:6px 0">No videos yet.</span>';
      return `<div class="video-item">
        <div class="video-item-header">
          <div class="video-item-name">${esc(s.name || s.title || 'Script')}</div>
          <span style="font-size:0.73rem;color:var(--muted)">${(s.videos||[]).length} video${(s.videos||[]).length !== 1 ? 's' : ''}</span>
        </div>
        <div class="video-sub-list">${subList}</div>
      </div>`;
    }).join('');
  }

  // ─── AI Video Wizard ───────────────────────────────────────────────────────
  let _wizardStep = 1;
  let _wizardIdea = null;
  let _wizardScript = '';
  let _selectedActorIds = new Set();

  function wizardGoTo(step) {
    // Hide all panels
    document.querySelectorAll('.wizard-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('wpanel-' + step).classList.add('active');
    _wizardStep = step;
    // Update step bar
    for (let i = 1; i <= 5; i++) {
      const el = document.getElementById('wstep-' + i);
      const line = document.getElementById('wline-' + i);
      if (i < step) {
        el.className = 'step done';
        el.querySelector('.step-circle').textContent = '✓';
        if (line) line.className = 'step-line done';
      } else if (i === step) {
        el.className = 'step active';
        el.querySelector('.step-circle').textContent = String(i);
        if (line) line.className = 'step-line';
      } else {
        el.className = 'step inactive';
        el.querySelector('.step-circle').textContent = String(i);
        if (line) line.className = 'step-line';
      }
    }
  }

  function wizardInitBrandSummary() {
    const brand = window._data?.brand;
    if (!brand) return;
    const pillars = brand.contentPillars ? `<div><strong>Content Pillars:</strong> ${esc(brand.contentPillars)}</div>` : '';
    document.getElementById('wizardBrandSummary').innerHTML = `
      <div><strong>Brand:</strong> ${esc(brand.name)}</div>
      <div><strong>Industry:</strong> ${esc(brand.industry || 'Not specified')}</div>
      <div><strong>Products:</strong> ${esc((brand.products || 'Not specified').slice(0, 120))}</div>
      <div><strong>Audience:</strong> ${esc((brand.audience || 'Not specified').slice(0, 100))}</div>
      ${pillars}
      <div class="wizard-note">We'll use this to generate content ideas tailored to your brand.</div>
    `;
  }

  async function wizardStep2() {
    wizardGoTo(2);
    const $loading = document.getElementById('ideasLoading');
    const $grid = document.getElementById('ideaGrid');
    $grid.innerHTML = '';
    $loading.style.display = 'flex';
    try {
      const r = await fetch('/api/client/ai/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandId: window._data?.brand?.id }),
      });
      const data = await r.json();
      $loading.style.display = 'none';
      const ideas = data.ideas || [];
      if (!ideas.length) { $grid.innerHTML = '<span class="empty">No ideas generated. Try again.</span>'; return; }
      $grid.innerHTML = ideas.map((idea, i) => `
        <div class="idea-card">
          <div class="idea-card-title">${esc(idea.title)}</div>
          <div class="idea-card-desc">${esc(idea.description)}</div>
          <div class="idea-card-meta">
            ${idea.format ? `<span class="idea-tag">${esc(idea.format)}</span>` : ''}
            ${idea.hook ? `<span class="idea-tag">Hook: ${esc(idea.hook.slice(0, 40))}</span>` : ''}
          </div>
          <button class="idea-use-btn" onclick="wizardSelectIdea(${i})">→ Use This Idea</button>
        </div>`).join('');
      window._wizardIdeas = ideas;
    } catch(e) {
      $loading.style.display = 'none';
      $grid.innerHTML = `<span class="empty">Error: ${esc(e.message)}</span>`;
    }
  }

  function wizardSelectIdea(idx) {
    _wizardIdea = window._wizardIdeas[idx];
    _wizardScript = '';
    document.getElementById('wizardScriptTA').value = '';
    document.getElementById('scriptEditorWrap').style.display = 'none';
    document.getElementById('toProductionBtn').style.display = 'none';
    document.getElementById('genScriptBtn').style.display = 'inline-flex';
    document.getElementById('selectedIdeaBox').innerHTML = `
      <div class="selected-idea-label">Selected Idea</div>
      <strong>${esc(_wizardIdea.title)}</strong>
      <div style="font-size:0.8rem;color:var(--muted);margin-top:4px;">${esc(_wizardIdea.description)}</div>
    `;
    wizardGoTo(3);
  }

  async function wizardGenerateScript() {
    if (!_wizardIdea) return;
    const $loading = document.getElementById('scriptLoading');
    const $wrap = document.getElementById('scriptEditorWrap');
    const $btn = document.getElementById('genScriptBtn');
    $loading.style.display = 'flex';
    $wrap.style.display = 'none';
    $btn.style.display = 'none';
    try {
      const r = await fetch('/api/client/ai/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea: _wizardIdea, brandContext: window._data?.brand }),
      });
      const data = await r.json();
      $loading.style.display = 'none';
      if (data.script) {
        _wizardScript = data.script;
        document.getElementById('wizardScriptTA').value = data.script;
        updateWordCount();
        $wrap.style.display = 'block';
        document.getElementById('toProductionBtn').style.display = 'inline-flex';
      } else {
        $btn.style.display = 'inline-flex';
        alert('Script generation returned no text. Try again.');
      }
    } catch(e) {
      $loading.style.display = 'none';
      $btn.style.display = 'inline-flex';
      alert('Error: ' + e.message);
    }
  }

  function updateWordCount() {
    const words = document.getElementById('wizardScriptTA').value.trim().split(/\s+/).filter(Boolean).length;
    document.getElementById('wordCount').textContent = words + ' word' + (words !== 1 ? 's' : '');
  }

  async function wizardStep4() {
    _wizardScript = document.getElementById('wizardScriptTA').value.trim();
    if (!_wizardScript) { alert('Please generate or write a script first.'); return; }
    _selectedActorIds = new Set();
    wizardGoTo(4);
    document.getElementById('prodScriptBox').textContent = _wizardScript;
    document.getElementById('actorSelCount').textContent = '0 selected';

    const $loading = document.getElementById('actorGridLoading');
    const $grid = document.getElementById('actorGrid');
    $grid.innerHTML = '';
    $loading.style.display = 'flex';
    try {
      const r = await fetch('/api/client/arcads/actors');
      const data = await r.json();
      $loading.style.display = 'none';
      const actors = data.actors || data.data || [];
      if (!actors.length) {
        $grid.innerHTML = '<span class="empty" style="grid-column:1/-1">No actors available.</span>';
        return;
      }
      window._wizardActors = actors;
      $grid.innerHTML = actors.map((a, i) => {
        const thumb = a.thumbnail || a.avatar || a.image_url || '';
        const name = esc(a.name || a.id || 'Actor ' + (i+1));
        return `<div class="actor-card" id="actor-${i}" onclick="toggleActor(${i}, '${esc(String(a.id || a.situationId || i))}')">
          ${thumb ? `<img class="actor-thumb" src="${esc(thumb)}" alt="${name}">` : `<div class="actor-thumb-placeholder">🎭</div>`}
          <div class="actor-name">${name}</div>
        </div>`;
      }).join('');
    } catch(e) {
      $loading.style.display = 'none';
      $grid.innerHTML = `<span class="empty" style="grid-column:1/-1">Failed to load actors: ${esc(e.message)}</span>`;
    }
  }

  function toggleActor(idx, actorId) {
    const el = document.getElementById('actor-' + idx);
    if (!el) return;
    if (_selectedActorIds.has(actorId)) {
      _selectedActorIds.delete(actorId);
      el.classList.remove('selected');
    } else {
      if (_selectedActorIds.size >= 6) { alert('Maximum 6 actors.'); return; }
      _selectedActorIds.add(actorId);
      el.classList.add('selected');
    }
    document.getElementById('actorSelCount').textContent = _selectedActorIds.size + ' selected';
  }

  async function wizardGenerateVideo() {
    if (_selectedActorIds.size < 2) { alert('Select at least 2 actors.'); return; }
    if (!_wizardScript) { alert('No script found.'); return; }
    const $st = document.getElementById('prodStatus');
    $st.style.color = 'var(--muted)'; $st.textContent = 'Queuing video generation…';
    try {
      const r = await fetch('/api/client/arcads/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: _wizardIdea?.title || 'AI Video',
          text: _wizardScript,
          situationIds: Array.from(_selectedActorIds),
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        $st.textContent = '';
        wizardGoTo(5);
        // Populate step 5 channel list from cached channels
        renderStep5Channels();
      } else {
        $st.style.color = 'var(--red)'; $st.textContent = 'Error: ' + (data.error || 'Failed');
      }
    } catch(e) { $st.style.color = 'var(--red)'; $st.textContent = 'Network error'; }
  }

  function renderStep5Channels() {
    const channels = window._channels || [];
    const $list = document.getElementById('step5ChannelList');
    if (!channels.length) {
      $list.innerHTML = '<span class="empty">No channels connected.</span>';
      return;
    }
    $list.innerHTML = channels.map(ch => `
      <div class="channel-item" id="s5ch-${esc(ch.id)}" onclick="toggleStep5Channel('${esc(ch.id)}')">
        ${ch.avatarUrl ? `<img src="${esc(ch.avatarUrl)}" alt="">` : '<div style="width:28px;height:28px;border-radius:50%;background:var(--border);flex-shrink:0"></div>'}
        <div class="channel-item-info">
          <div class="channel-name">${esc(ch.name)}</div>
          <div class="channel-service">${esc(ch.service)}</div>
        </div>
        <span class="channel-check">✓</span>
      </div>`).join('');
    window._step5SelectedChannels = new Set();
  }

  function toggleStep5Channel(id) {
    if (!window._step5SelectedChannels) window._step5SelectedChannels = new Set();
    const el = document.getElementById('s5ch-' + id);
    if (!el) return;
    if (window._step5SelectedChannels.has(id)) {
      window._step5SelectedChannels.delete(id); el.classList.remove('selected');
    } else {
      window._step5SelectedChannels.add(id); el.classList.add('selected');
    }
  }

  async function wizardSchedule() {
    const channelIds = Array.from(window._step5SelectedChannels || []);
    const scheduledAt = document.getElementById('wizardScheduleAt').value;
    try {
      await fetch('/api/client/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pendingSchedule: {
            idea: _wizardIdea?.title,
            script: _wizardScript,
            channelIds,
            scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
            createdAt: new Date().toISOString(),
          },
        }),
      });
    } catch(_) {}
    document.getElementById('scheduleConfirm').style.display = 'block';
  }

  function wizardReset() {
    _wizardIdea = null;
    _wizardScript = '';
    _selectedActorIds = new Set();
    window._wizardIdeas = [];
    document.getElementById('ideaGrid').innerHTML = '';
    document.getElementById('wizardScriptTA').value = '';
    document.getElementById('scriptEditorWrap').style.display = 'none';
    document.getElementById('toProductionBtn').style.display = 'none';
    document.getElementById('genScriptBtn').style.display = 'inline-flex';
    document.getElementById('scheduleConfirm').style.display = 'none';
    wizardGoTo(1);
    loadArcads();
  }

  // ─── Storista ──────────────────────────────────────────────────────────────
  function renderConnections(brand) {
    const conns = brand.connections || {};

    // Buffer
    const bufConn = !!conns.bufferConnected;
    const $bb = document.getElementById('connBadgeBuffer');
    if ($bb) {
      $bb.textContent = bufConn ? '● Connected' : '● Not connected';
      $bb.className = 'conn-badge ' + (bufConn ? 'connected' : 'disconnected');
      document.getElementById('connBuffer').classList.toggle('connected', bufConn);
      if (bufConn) document.getElementById('connFieldsBuffer').querySelector('input').placeholder = '••••••••  (saved)';
    }

    // Arcads
    const arcConn = !!conns.arcadsConnected;
    const $ab = document.getElementById('connBadgeArcads');
    if ($ab) {
      $ab.textContent = arcConn ? '● Connected' : '● Not connected';
      $ab.className = 'conn-badge ' + (arcConn ? 'connected' : 'disconnected');
      document.getElementById('connArcads').classList.toggle('connected', arcConn);
      if (arcConn) {
        document.getElementById('connInputArcadsClientId').placeholder = '••••••••  (saved)';
        document.getElementById('connInputArcadsApiKey').placeholder = '••••••••  (saved)';
      }
    }

    // Storista
    const stConn = !!conns.storistaConnected;
    const $sb = document.getElementById('connBadgeStorista');
    if ($sb) {
      $sb.textContent = stConn ? '● Connected' : '● Not connected';
      $sb.className = 'conn-badge ' + (stConn ? 'connected' : 'disconnected');
      document.getElementById('connStorista').classList.toggle('connected', stConn);
      if (stConn) document.getElementById('connInputStorista').placeholder = '••••••••  (saved)';
    }

    // Storista section badge + show/hide the full UI
    const $stBadge = document.getElementById('storistaConnBadge');
    if ($stBadge) {
      $stBadge.textContent = stConn ? '● Connected' : '● Not connected';
      $stBadge.className = 'conn-badge ' + (stConn ? 'connected' : 'disconnected');
    }
    document.getElementById('storistaNotConn').style.display = stConn ? 'none' : '';
    document.getElementById('storistaConnUI').style.display  = stConn ? '' : 'none';
    // Load accounts eagerly whenever we know Storista is connected
    if (stConn && !window._storistaLoaded) {
      window._storistaLoaded = true;
      const tom = new Date(); tom.setDate(tom.getDate() + 1);
      const dateEl = document.getElementById('storistaAutoDate');
      if (dateEl) dateEl.value = tom.toISOString().split('T')[0];
      loadStoristaAccounts();
      loadStoristaServerQueue();
    }
  }

  async function saveConnection(service) {
    const msgEl = document.getElementById('connMsg' + service.charAt(0).toUpperCase() + service.slice(1));
    msgEl.style.color = 'var(--muted)'; msgEl.textContent = 'Saving…';

    let payload = {};
    if (service === 'buffer') {
      const val = document.getElementById('connInputBuffer').value.trim();
      if (!val) { msgEl.style.color='var(--red)'; msgEl.textContent='Token required'; return; }
      payload.bufferToken = val;
    } else if (service === 'arcads') {
      const clientId = document.getElementById('connInputArcadsClientId').value.trim();
      const apiKey   = document.getElementById('connInputArcadsApiKey').value.trim();
      if (!clientId || !apiKey) { msgEl.style.color='var(--red)'; msgEl.textContent='Both fields required'; return; }
      payload.arcadsClientId = clientId;
      payload.arcadsApiKey = apiKey;
    } else if (service === 'storista') {
      const val = document.getElementById('connInputStorista').value.trim();
      if (!val) { msgEl.style.color='var(--red)'; msgEl.textContent='API key required'; return; }
      payload.storistaApiKey = val;
    }

    try {
      const r = await fetch('/api/client/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        msgEl.style.color = 'var(--green)'; msgEl.textContent = '✓ Connected!';
        if (!window._data.brand.connections) window._data.brand.connections = {};
        if (service === 'buffer')  window._data.brand.connections.bufferConnected  = true;
        if (service === 'arcads')  window._data.brand.connections.arcadsConnected  = true;
        if (service === 'storista') window._data.brand.connections.storistaConnected = true;
        renderConnections(window._data.brand);
        // If we just connected Storista and the tab is open, load its data
        if (service === 'storista') {
          window._storistaLoaded = false;
          initStorista(window._data.brand);
        }
        setTimeout(() => { msgEl.textContent = ''; }, 3000);
      } else {
        msgEl.style.color = 'var(--red)'; msgEl.textContent = data.error || 'Save failed';
      }
    } catch(e) { msgEl.style.color='var(--red)'; msgEl.textContent='Network error'; }
  }

  // ─── Storista Batch Scheduler ───────────────────────────────────────────────
  let _storistaFiles = []; // [{ file, filename, caption, scheduledFor }]

  function initStorista(brand) {
    const isConn = !!(brand?.connections?.storistaConnected || brand?.storistaConnected);
    document.getElementById('storistaNotConn').style.display  = isConn ? 'none' : '';
    document.getElementById('storistaConnUI').style.display   = isConn ? ''     : 'none';
    if (!isConn) return;
    window._storistaLoaded = true;
    // Default auto-schedule date to tomorrow
    const tom = new Date(); tom.setDate(tom.getDate() + 1);
    document.getElementById('storistaAutoDate').value = tom.toISOString().split('T')[0];
    loadStoristaAccounts();
    loadStoristaServerQueue();
  }

  async function loadStoristaAccounts() {
    const sel    = document.getElementById('storistaAccount');
    const status = document.getElementById('storistaAccountStatus');
    if (status) status.textContent = 'Loading accounts…';
    try {
      const r    = await fetch('/api/client/storista/accounts');
      const data = await r.json();
      console.log('[storista] accounts response:', JSON.stringify(data));

      if (!r.ok || data.error) {
        const msg = typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error || 'Failed to load');
        sel.innerHTML = `<option value="">Error — see status below</option>`;
        if (status) { status.style.color = 'var(--red)'; status.textContent = 'Error: ' + msg; }
        return;
      }

      const accounts = data.accounts || [];
      if (status) status.textContent = '';

      if (!accounts.length) {
        sel.innerHTML = '<option value="">No TikTok accounts found in Storista</option>';
        return;
      }
      sel.innerHTML = accounts.map(a => {
        const val   = a.username || a.handle || a.id || a.name || '';
        const label = a.display_name || a.name || a.username || a.handle || val;
        return `<option value="${esc(val)}">${esc(label)}</option>`;
      }).join('');
      if (status) { status.style.color = 'var(--green)'; status.textContent = `✓ ${accounts.length} account${accounts.length !== 1 ? 's' : ''} loaded`; }
      onStoristaAccountChange();
    } catch(e) {
      sel.innerHTML = '<option value="">Failed to load accounts</option>';
      if (status) { status.style.color = 'var(--red)'; status.textContent = 'Network error: ' + e.message; }
      console.error('[storista] accounts fetch error:', e);
    }
  }

  async function onStoristaAccountChange() {
    const account = document.getElementById('storistaAccount').value;
    if (!account) return;
    const sel    = document.getElementById('storistaProduct');
    const status = document.getElementById('storistaAccountStatus');
    sel.innerHTML = '<option value="">Loading products…</option>';
    try {
      const r    = await fetch(`/api/client/storista/products/${encodeURIComponent(account)}`);
      const data = await r.json();
      const products = data.products || [];
      document.getElementById('storistaProductWrap').style.display = '';
      if (!products.length) {
        sel.innerHTML = '<option value="">No products found</option>';
        if (status) { status.style.color = 'var(--muted)'; status.textContent = '✓ Connected — no products in this account'; }
      } else {
        sel.innerHTML = '<option value="">No product tag</option>' +
          products.map(p => {
            const id   = p.id || p.product_id || '';
            const name = p.name || p.title || id;
            return `<option value="${esc(id)}">${esc(name)}</option>`;
          }).join('');
        if (status) { status.style.color = 'var(--green)'; status.textContent = `✓ ${products.length} product${products.length !== 1 ? 's' : ''} available`; }
      }
    } catch(e) {
      document.getElementById('storistaProductWrap').style.display = '';
      sel.innerHTML = '<option value="">No product tag</option>';
      if (status) { status.style.color = 'var(--red)'; status.textContent = 'Products error: ' + e.message; }
    }
  }

  function storistaOnDragOver(e) {
    e.preventDefault();
    document.getElementById('storistaDropZone').classList.add('dragover');
  }
  function storistaOnDragLeave(e) {
    document.getElementById('storistaDropZone').classList.remove('dragover');
  }
  function storistaOnDrop(e) {
    e.preventDefault();
    document.getElementById('storistaDropZone').classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'));
    storistaAddFiles(files);
  }
  function storistaOnFilesAdded(e) {
    storistaAddFiles(Array.from(e.target.files));
    e.target.value = '';
  }
  function storistaAddFiles(files) {
    const startIdx = _storistaFiles.length;
    for (const file of files) {
      _storistaFiles.push({ file, filename: file.name, caption: '', scheduledFor: '' });
    }
    renderStoristaQueue();
    // Auto-generate captions for newly added files, 2 at a time
    (async () => {
      const indices = Array.from({ length: files.length }, (_, k) => startIdx + k);
      const CONCURRENCY = 2;
      for (let i = 0; i < indices.length; i += CONCURRENCY) {
        await Promise.all(indices.slice(i, i + CONCURRENCY).map(idx => generateStoristaCaption(idx)));
      }
    })();
  }

  function renderStoristaQueue() {
    const count = _storistaFiles.length;
    document.getElementById('storistaQueueCount').textContent = count;
    document.getElementById('storistaQueueWrap').style.display  = count ? '' : 'none';
    document.getElementById('storistaAutoPanel').style.display  = count ? '' : 'none';
    document.getElementById('storistaSubmitWrap').style.display = count ? '' : 'none';
    // Show Buffer cross-post section only if Buffer channels are available and there are files queued
    const bufferSec = document.getElementById('storistaBufferSection');
    if (bufferSec && window._channels?.length) bufferSec.style.display = count ? '' : 'none';

    document.getElementById('storistaQueueList').innerHTML = _storistaFiles.map((item, i) => `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;">
        <div style="flex:1;min-width:180px;">
          <div style="font-size:0.8rem;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;" title="${esc(item.filename)}">${esc(item.filename)}</div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:6px;">
            <input type="text" class="schedule-input" id="storistaCaption_${i}" style="flex:1;font-size:0.78rem;"
              placeholder="Generating caption…"
              value="${esc(item.caption)}"
              oninput="_storistaFiles[${i}].caption=this.value">
            <button id="storistaGenBtn_${i}" onclick="generateStoristaCaption(${i})"
              title="Generate caption from video transcript"
              style="background:rgba(0,242,234,0.08);border:1px solid rgba(0,242,234,0.2);color:var(--teal);cursor:pointer;border-radius:6px;padding:5px 10px;font-size:0.8rem;white-space:nowrap;flex-shrink:0;">✨</button>
          </div>
          <div id="storistaGenStatus_${i}" style="font-size:0.71rem;color:var(--muted);margin-top:3px;display:none;"></div>
        </div>
        <div style="min-width:170px;">
          <div style="font-size:0.7rem;color:var(--muted);margin-bottom:4px;">Post time</div>
          <input type="datetime-local" class="schedule-input" style="font-size:0.78rem;"
            value="${item.scheduledFor}"
            oninput="_storistaFiles[${i}].scheduledFor=this.value">
        </div>
        <button onclick="storistaRemoveFile(${i})"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;padding:2px 4px;flex-shrink:0;">✕</button>
      </div>
    `).join('');
  }

  function storistaRemoveFile(i) {
    _storistaFiles.splice(i, 1);
    renderStoristaQueue();
  }
  function clearStoristaQueue() {
    _storistaFiles = [];
    renderStoristaQueue();
  }

  function applyStoristaAutoSchedule() {
    const date  = document.getElementById('storistaAutoDate').value;
    const start = document.getElementById('storistaAutoStart').value;
    const end   = document.getElementById('storistaAutoEnd').value;
    if (!date || !start || !end) return alert('Set date, start time, and end time first.');
    const count = _storistaFiles.length;
    if (!count) return;

    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const totalMin = (eh * 60 + em) - (sh * 60 + sm);
    if (totalMin <= 0) return alert('End time must be after start time.');

    const interval = count === 1 ? 0 : totalMin / (count - 1);
    _storistaFiles.forEach((item, i) => {
      const offsetMin = Math.round((sh * 60 + sm) + i * interval);
      const h = Math.floor(offsetMin / 60).toString().padStart(2, '0');
      const m = (offsetMin % 60).toString().padStart(2, '0');
      item.scheduledFor = `${date}T${h}:${m}`;
    });
    renderStoristaQueue();
  }

  async function submitStoristaSchedule() {
    const account   = document.getElementById('storistaAccount').value;
    const productId = document.getElementById('storistaProduct').value;

    if (!account) return alert('Select a TikTok account first.');
    if (!productId) return alert('Select a product to tag — product_id is required by TikTok Shop.');
    const missing = _storistaFiles.filter(f => !f.scheduledFor);
    if (missing.length) {
      return alert(`${missing.length} video(s) have no schedule time. Use "Spread Evenly" or set times manually.`);
    }

    const btn    = document.getElementById('storistaSubmitBtn');
    const status = document.getElementById('storistaSubmitStatus');
    btn.disabled = true;

    const total     = _storistaFiles.length;
    const completed = [];

    for (let i = 0; i < total; i++) {
      const item = _storistaFiles[i];
      status.style.color = 'var(--muted)';
      status.textContent = `Uploading ${i + 1} of ${total}: ${item.filename}…`;

      try {
        const fd = new FormData();
        fd.append('video', item.file, item.filename);
        const r    = await fetch('/api/client/storista/upload', { method: 'POST', body: fd });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch(_) { throw new Error(`Server error (${r.status}): ${text.slice(0, 200)}`); }
        if (!r.ok || !data.ok) {
          const e = data.error;
          throw new Error(typeof e === 'object' ? JSON.stringify(e) : (e || 'Upload failed'));
        }

        completed.push({
          mediaId:      data.media_id,
          filename:     item.filename,
          uploadUrl:    data.uploadUrl || null,
          account,
          productId,
          caption:      item.caption.trim(),
          scheduledFor: new Date(item.scheduledFor).toISOString(),
        });
      } catch(e) {
        status.style.color = 'var(--red)';
        status.textContent = `Failed on "${item.filename}": ${e.message}`;
        btn.disabled = false;
        return;
      }
    }

    // All uploaded — schedule them
    status.style.color = 'var(--muted)';
    status.textContent = 'Saving schedule…';
    try {
      const bufferChannels = Array.from(_storistaBufferChannels.entries())
        .map(([id, service]) => ({ id, service }));
      const r    = await fetch('/api/client/storista/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: completed, bufferChannels }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Schedule save failed');

      status.style.color = 'var(--green)';
      status.textContent = `✓ ${total} video${total !== 1 ? 's' : ''} scheduled!`;
      _storistaFiles = [];
      renderStoristaQueue();
      setTimeout(() => { status.textContent = ''; loadStoristaServerQueue(); }, 2000);
    } catch(e) {
      status.style.color = 'var(--red)';
      status.textContent = `Schedule error: ${e.message}`;
    }
    btn.disabled = false;
  }

  function generateStoristaCaption(i) {
    const item = _storistaFiles[i];
    if (!item) return Promise.resolve();

    const btn    = document.getElementById(`storistaGenBtn_${i}`);
    const status = document.getElementById(`storistaGenStatus_${i}`);
    const input  = document.getElementById(`storistaCaption_${i}`);

    const productSel  = document.getElementById('storistaProduct');
    const productName = productSel?.selectedIndex > 0
      ? productSel.options[productSel.selectedIndex].text : '';

    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    const setStatus = (msg, color) => {
      if (!status) return;
      status.style.display = 'block';
      status.style.color   = color || 'var(--muted)';
      status.textContent   = msg;
    };

    setStatus('Uploading…');

    const fd = new FormData();
    fd.append('video', item.file, item.filename);
    if (productName) fd.append('productName', productName);

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/client/storista/generate-caption');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setStatus(pct < 100 ? `Uploading… ${pct}%` : 'Extracting audio & transcribing…');
        }
      };

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.ok && data.caption) {
            item.caption = data.caption;
            if (input) input.value = data.caption;
            setStatus('✓ Caption ready', 'var(--green)');
            setTimeout(() => { if (status) status.style.display = 'none'; }, 3000);
          } else {
            const err = typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error || 'Failed');
            setStatus(err, 'var(--red)');
          }
        } catch (e) {
          setStatus('Bad response from server', 'var(--red)');
        }
        if (btn) { btn.disabled = false; btn.textContent = '✨'; }
        resolve();
      };

      xhr.onerror = () => {
        setStatus('Network error', 'var(--red)');
        if (btn) { btn.disabled = false; btn.textContent = '✨'; }
        resolve();
      };

      xhr.ontimeout = () => {
        setStatus('Timed out — video may be too large', 'var(--red)');
        if (btn) { btn.disabled = false; btn.textContent = '✨'; }
        resolve();
      };

      xhr.timeout = 180_000; // 3 min
      xhr.send(fd);
    });
  }

  async function generateAllStoristaCaptions() {
    const btn = document.getElementById('storistaGenAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
    const CONCURRENCY = 4;
    for (let i = 0; i < _storistaFiles.length; i += CONCURRENCY) {
      const batch = [];
      for (let j = i; j < Math.min(i + CONCURRENCY, _storistaFiles.length); j++) {
        batch.push(generateStoristaCaption(j));
      }
      await Promise.all(batch);
    }
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate all captions'; }
  }

  async function loadStoristaServerQueue() {
    const el = document.getElementById('storistaServerQueue');
    if (!el) return;
    try {
      const r    = await fetch('/api/client/storista/queue');
      const data = await r.json();
      const queue = data.queue || [];

      if (!queue.length) {
        el.innerHTML = '<span class="empty">No scheduled videos yet.</span>';
        return;
      }

      const icon  = { scheduled: '🕐', published: '✅', failed: '❌' };
      const color = { scheduled: 'var(--muted)', published: 'var(--green)', failed: 'var(--red)' };

      el.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;">` +
        queue.map(job => `
          <div style="display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;flex-wrap:wrap;">
            <div style="font-size:1rem;flex-shrink:0;">${icon[job.status] || '🕐'}</div>
            <div style="flex:1;min-width:120px;overflow:hidden;">
              <div style="font-size:0.82rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(job.filename)}</div>
              <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">${job.caption ? esc(job.caption.slice(0,70)) + (job.caption.length > 70 ? '…' : '') : '—'}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:0.78rem;font-weight:700;color:${color[job.status] || 'var(--muted)'};">${job.status}</div>
              <div style="font-size:0.7rem;color:var(--muted);">${
                job.status === 'published'
                  ? new Date(job.publishedAt).toLocaleString()
                  : new Date(job.scheduledFor).toLocaleString()
              }</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              ${job.status === 'failed' ? `<button onclick="retryStoristaJob('${job.id}')" style="background:none;border:1px solid var(--muted);border-radius:4px;color:var(--muted);cursor:pointer;font-size:0.7rem;padding:2px 7px;" title="Retry">↺ retry</button>` : ''}
              ${job.status !== 'published' ? `<button onclick="deleteStoristaJob('${job.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1rem;" title="Remove">✕</button>` : ''}
            </div>
            ${job.error ? `<div style="font-size:0.68rem;color:var(--red);width:100%;margin-top:4px;word-break:break-all;">${esc(job.error)}</div>` : ''}
          </div>
        `).join('') + `</div>`;
    } catch(e) {
      el.innerHTML = '<span class="empty">Failed to load queue.</span>';
    }
  }

  async function deleteStoristaJob(jobId) {
    await fetch(`/api/client/storista/queue/${jobId}`, { method: 'DELETE' }).catch(() => {});
    loadStoristaServerQueue();
  }

  async function retryStoristaJob(jobId) {
    await fetch(`/api/client/storista/queue/${jobId}/retry`, { method: 'POST' }).catch(() => {});
    loadStoristaServerQueue();
  }

  load();

  // ─── Billing tab ───────────────────────────────────────────────────────────
  let _billingData = null;
  let _selectedTier = null;

  async function loadBilling() {
    window._billingLoaded = true;
    try {
      const r = await fetch('/api/client/billing');
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      _billingData = d;
      renderBilling(d);
    } catch(e) {
      document.getElementById('bkpiRetainer').textContent = '—';
      console.error('[billing]', e);
    }
  }

  function renderBilling(d) {
    const { currentTier, pendingTier, gmv, revShare, tiers, cycle, hasPaymentMethod, invoices } = d;

    // Header
    document.getElementById('billingPeriodSub').textContent = `${cycle.period} · data through today`;
    document.getElementById('billingCycleChip').textContent = `🗓 Next invoice in ${cycle.daysUntilBilling} day${cycle.daysUntilBilling === 1 ? '' : 's'} (${cycle.nextBillingLabel})`;

    // KPIs
    document.getElementById('bkpiRetainer').textContent = fmt$(currentTier.retainer);
    document.getElementById('bkpiGmv').textContent = fmt$(gmv);
    document.getElementById('bkpiRevShareSub').textContent = `${Math.round(currentTier.commRate * 100)}% of GMV — billed next month`;
    document.getElementById('bkpiRevShare').textContent = fmt$(revShare);

    // Payment method
    const pmIcon  = document.getElementById('pmIcon');
    const pmLabel = document.getElementById('pmLabel');
    const pmSub   = document.getElementById('pmSub');
    const pmBtn   = document.getElementById('pmBtn');
    if (hasPaymentMethod) {
      pmIcon.textContent  = '✅';
      pmLabel.textContent = 'Payment method on file';
      pmSub.textContent   = 'You will be charged automatically each month.';
      pmBtn.textContent   = 'Update Payment Method';
      pmBtn.className     = 'pm-btn secondary';
    } else {
      pmIcon.textContent  = '⚠️';
      pmLabel.textContent = 'No payment method on file';
      pmSub.textContent   = 'Add a card so invoices can be charged automatically.';
      pmBtn.textContent   = 'Add Payment Method →';
      pmBtn.className     = 'pm-btn';
    }

    // Tiers
    const grid = document.getElementById('tiersGrid');
    grid.innerHTML = tiers.map(t => {
      const isCurrent = t.retainer === currentTier.retainer && Math.abs(t.commRate - currentTier.commRate) < 0.001;
      const isPending = pendingTier && t.retainer === pendingTier.retainer && Math.abs(t.commRate - pendingTier.commRate) < 0.001;
      let cls = 'tier-card';
      if (isCurrent) cls += ' current';
      else if (isPending) cls += ' pending';
      const badge = isCurrent
        ? `<div class="tier-badge cur">Current</div>`
        : isPending
          ? `<div class="tier-badge pend">Pending</div>`
          : '';
      const label = `$${(t.retainer/1000).toFixed(1).replace('.0','').replace(/(\d)(\.\d)/,'$1$2')}k + ${Math.round(t.commRate*100)}% GMV`;
      return `<div class="${cls}" onclick="selectTier(${t.retainer},${t.commRate})" data-ret="${t.retainer}" data-comm="${t.commRate}">
        ${badge}
        <div class="tier-retainer">$${t.retainer.toLocaleString()}<span style="font-size:0.75rem;font-weight:400;color:var(--muted)">/mo</span></div>
        <div class="tier-gmv">${Math.round(t.commRate*100)}% GMV share</div>
        ${isCurrent ? '<div class="tier-desc" style="color:var(--teal);">Active plan</div>' : isPending ? `<div class="tier-desc" style="color:var(--gold);">Effective ${pendingTier.effectiveLabel}</div>` : ''}
      </div>`;
    }).join('');

    // Invoices
    const tbody = document.getElementById('invTbody');
    if (!invoices || invoices.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">No invoices yet</td></tr>`;
    } else {
      tbody.innerHTML = invoices.map(inv => `
        <tr>
          <td>${inv.period || '—'}</td>
          <td style="color:var(--muted)">${inv.date}</td>
          <td style="font-weight:700">${fmt$(inv.amount)}</td>
          <td><span class="inv-status ${inv.status}">${inv.status}</span></td>
          <td>${inv.url ? `<a class="inv-view-btn" href="${inv.url}" target="_blank">View →</a>` : ''}</td>
        </tr>`).join('');
    }
  }

  function selectTier(retainer, commRate) {
    const d = _billingData;
    if (!d) return;
    const isCurrent = retainer === d.currentTier.retainer && Math.abs(commRate - d.currentTier.commRate) < 0.001;
    const isPending = d.pendingTier && retainer === d.pendingTier.retainer && Math.abs(commRate - d.pendingTier.commRate) < 0.001;
    if (isCurrent && !isPending) return; // already on this plan, no pending change

    // Highlight selected card
    document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('selected'));
    const el = document.querySelector(`.tier-card[data-ret="${retainer}"][data-comm="${commRate}"]`);
    if (el) el.classList.add('selected');

    _selectedTier = { retainer, commRate };
    const name = `$${retainer.toLocaleString()}/mo + ${Math.round(commRate * 100)}% GMV`;
    document.getElementById('tierChangeInfo').innerHTML = `Switch to <span style="color:var(--teal);font-weight:700">${name}</span> — takes effect ${d.cycle.nextBillingLabel}`;
    document.getElementById('tierChangeBar').classList.add('open');
    document.getElementById('tierChangeMsg').textContent = '';
  }

  function cancelTierChange() {
    _selectedTier = null;
    document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('selected'));
    document.getElementById('tierChangeBar').classList.remove('open');
    document.getElementById('tierChangeMsg').textContent = '';
  }

  async function confirmTierChange() {
    if (!_selectedTier) return;
    const btn = document.querySelector('.tier-confirm-btn');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/client/billing/change-tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_selectedTier),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Failed');
      document.getElementById('tierChangeMsg').style.color = 'var(--green)';
      document.getElementById('tierChangeMsg').textContent = `✓ Plan change confirmed — takes effect ${json.effectiveLabel}`;
      document.getElementById('tierChangeBar').classList.remove('open');
      _selectedTier = null;
      // Reload billing data to reflect pending change
      window._billingLoaded = false;
      await loadBilling();
    } catch(e) {
      document.getElementById('tierChangeMsg').style.color = 'var(--red)';
      document.getElementById('tierChangeMsg').textContent = e.message;
    } finally {
      btn.textContent = 'Confirm Change';
      btn.disabled = false;
    }
  }

  async function openBillingPortal() {
    const btn = document.getElementById('pmBtn');
    btn.textContent = 'Opening…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/client/billing/portal');
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch(_) {
        throw new Error(`Server error (HTTP ${r.status}) — please refresh and try again`);
      }
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      window.open(json.url, '_blank');
    } catch(e) {
      alert('Could not open billing portal: ' + e.message);
    } finally {
      btn.textContent = _billingData?.hasPaymentMethod ? 'Update Payment Method' : 'Add Payment Method →';
      btn.disabled = false;
    }
  }
