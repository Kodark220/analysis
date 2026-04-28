'use strict';

const API_ORIGIN = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const NEW_ITEM_WINDOW_MS = 24 * 60 * 60 * 1000;

const state = {
    currentTab: 'new-protocols',
    searchTerm: '',
    category: 'all',
    timeWindowDays: 7,
    watchlist: loadJson('alpha-watchlist', []),
    seenItems: loadJson('alpha-seen-items', { protocols: [], jobLeads: [], signalLeads: [], keywordAlerts: [] }),
    lastUpdatedAt: null,
    keywords: [],
    keywordAlerts: [],
    sourceStatus: null,
    datasets: {
        protocols: [],
        jobLeads: [],
        signalLeads: []
    }
};

const elements = {
    toastContainer: document.getElementById('toast-container'),
    statNewProtocols: document.getElementById('stat-new-protocols'),
    statJobLeads: document.getElementById('stat-job-leads'),
    statKeywordAlerts: document.getElementById('stat-keyword-alerts'),
    statLastUpdate: document.getElementById('stat-last-update'),
    statusSummary: document.getElementById('status-summary'),
    statusGrid: document.getElementById('status-grid'),
    statusWarnings: document.getElementById('status-warnings'),
    badgeProtocols: document.getElementById('badge-protocols'),
    badgeJobLeads: document.getElementById('badge-job-leads'),
    badgeSignalLeads: document.getElementById('badge-signal-leads'),
    badgeWatchlist: document.getElementById('badge-watchlist'),
    loadingProtocols: document.getElementById('loading-protocols'),
    loadingTrending: document.getElementById('loading-trending'),
    loadingListings: document.getElementById('loading-listings'),
    emptyWatchlist: document.getElementById('empty-watchlist'),
    gridProtocols: document.getElementById('grid-protocols'),
    gridTrending: document.getElementById('grid-trending'),
    gridListings: document.getElementById('grid-listings'),
    gridWatchlist: document.getElementById('grid-watchlist')
};

document.addEventListener('DOMContentLoaded', initialize);

function initialize() {
    renderAll();
    refreshAll();
    window.setInterval(refreshAll, REFRESH_INTERVAL_MS);
}

async function refreshAll() {
    toggleLoading(true);

    try {
        const response = await fetch(`${API_ORIGIN}/api/discovery?days=${state.timeWindowDays}`);

        if (!response.ok) {
            throw new Error('Backend request failed. Start the local server with node server.js.');
        }

        const payload = await response.json();

        state.datasets = payload.datasets || state.datasets;
        state.keywords = payload.keywords || [];
        state.keywordAlerts = payload.keywordAlerts || [];
        state.sourceStatus = payload.sourceStatus || null;
        state.lastUpdatedAt = new Date(payload.generatedAt || Date.now());

        notifyForNewItems('protocols', state.datasets.protocols, 'New project', item => `${item.name} appeared in the ${state.timeWindowDays}d discovery window.`);
        notifyForNewItems('jobLeads', state.datasets.jobLeads, 'Job lead', item => `${item.name} has live careers, docs, or community links worth checking now.`);
        notifyForNewItems('signalLeads', state.datasets.signalLeads, 'Signal lead', item => `${item.name} triggered ${item.signalCount || 0} keyword hits across watched sources.`);
        notifyForKeywordAlerts(state.keywordAlerts);

        persistSeenItems();
        renderAll();
    } catch (error) {
        console.error(error);
        showToast('error', 'Refresh failed', error.message || 'Unable to pull backend discovery data.');
    } finally {
        toggleLoading(false);
    }
}

function notifyForNewItems(bucket, items, title, descriptionBuilder) {
    const previous = new Set(state.seenItems[bucket] || []);

    for (const item of items) {
        if (previous.has(item.id)) {
            continue;
        }

        const isFresh = item.listedAt && Date.now() - item.listedAt <= NEW_ITEM_WINDOW_MS;
        if (!isFresh) {
            continue;
        }

        showToast(bucket === 'signalLeads' ? 'trending' : 'new', title, `${item.name} • ${descriptionBuilder(item)}`);
        sendBrowserNotification(title, `${item.name} • ${descriptionBuilder(item)}`);
    }
}

function notifyForKeywordAlerts(alerts) {
    const previous = new Set(state.seenItems.keywordAlerts || []);
    const nextAlerts = alerts.filter(alert => !previous.has(alert.id)).slice(0, 5);

    for (const alert of nextAlerts) {
        const label = alert.projectName || alert.label || 'Source';
        const message = `${label} • ${alert.keyword} detected on ${alert.source}.`;
        showToast('trending', 'Keyword alert', message);
        sendBrowserNotification('Keyword alert', message);
    }
}

function persistSeenItems() {
    state.seenItems = {
        protocols: state.datasets.protocols.map(item => item.id),
        jobLeads: state.datasets.jobLeads.map(item => item.id),
        signalLeads: state.datasets.signalLeads.map(item => item.id),
        keywordAlerts: state.keywordAlerts.map(item => item.id)
    };

    localStorage.setItem('alpha-seen-items', JSON.stringify(state.seenItems));
}

function renderAll() {
    const filteredProtocols = applyFilters(state.datasets.protocols);
    const filteredJobLeads = applyFilters(state.datasets.jobLeads);
    const filteredSignalLeads = applyFilters(state.datasets.signalLeads);
    const filteredWatchlist = applyWatchlistFilters();

    renderCards(elements.gridProtocols, filteredProtocols, 'protocols');
    renderCards(elements.gridTrending, filteredJobLeads, 'jobLeads');
    renderCards(elements.gridListings, filteredSignalLeads, 'signalLeads');
    renderCards(elements.gridWatchlist, filteredWatchlist, 'watchlist');
    renderStats();
    renderStatusPanel();
    renderBadges(filteredProtocols, filteredJobLeads, filteredSignalLeads, filteredWatchlist);

    elements.emptyWatchlist.classList.toggle('hidden', filteredWatchlist.length > 0);
}

function renderStats() {
    elements.statNewProtocols.textContent = String(state.datasets.protocols.length);
    elements.statJobLeads.textContent = String(state.datasets.jobLeads.length);
    elements.statKeywordAlerts.textContent = String(state.keywordAlerts.length);
    elements.statLastUpdate.textContent = state.lastUpdatedAt ? formatTime(state.lastUpdatedAt) : '—';
}

function renderStatusPanel() {
    const sourceStatus = state.sourceStatus || {};
    const channelStatuses = sourceStatus.channelStatuses || [];
    const warnings = sourceStatus.warnings || [];
    const activeFeeds = sourceStatus.xFeedsActive || 0;
    const configuredAccounts = sourceStatus.xAccountsConfigured || 0;
    const alertStore = sourceStatus.alertStore || null;

    const summaryBits = [
        `${configuredAccounts} X accounts configured`,
        `${activeFeeds} active feeds`,
        `${channelStatuses.filter(channel => channel.enabled).length} alert channels enabled`
    ];

    elements.statusSummary.textContent = summaryBits.join(' • ');

    const cards = [
        {
            label: 'Windows Env',
            enabled: true,
            configured: sourceStatus.windowsEnvSupported === true,
            copy: 'The backend reads secrets from normal Windows environment variables and from .env when present.'
        },
        {
            label: 'X Feed Watch',
            enabled: configuredAccounts > 0,
            configured: activeFeeds > 0,
            copy: activeFeeds > 0 ? `${activeFeeds} RSS feeds are active for watched X accounts.` : 'Add RSS feed URLs for watched X accounts to activate feed scanning.'
        },
        ...(alertStore ? [{
            label: alertStore.label || 'Alert Store',
            enabled: true,
            configured: alertStore.configured !== false,
            copy: alertStore.copy || 'Alert delivery history storage is active.'
        }] : []),
        ...channelStatuses.map(channel => ({
            label: channel.label,
            enabled: channel.enabled,
            configured: channel.configured,
            copy: channel.enabled
                ? (channel.configured ? 'Channel is ready to send alerts.' : `Missing ${channel.missing.join(' and ')}.`)
                : 'Channel is disabled in monitored-sources.json.'
        }))
    ];

    elements.statusGrid.innerHTML = cards.map(buildStatusCardMarkup).join('');

    if (warnings.length === 0) {
        elements.statusWarnings.classList.add('hidden');
        elements.statusWarnings.innerHTML = '';
        return;
    }

    elements.statusWarnings.classList.remove('hidden');
    elements.statusWarnings.innerHTML = `
        <div class="status-warning-title">Configuration Warnings</div>
        <div class="status-warning-list">
            ${warnings.map(warning => `<div class="status-warning-item">${escapeHtml(warning)}</div>`).join('')}
        </div>
    `;
}

function buildStatusCardMarkup(card) {
    let badgeClass = 'off';
    let badgeLabel = 'Disabled';

    if (card.enabled && card.configured) {
        badgeClass = 'ok';
        badgeLabel = 'Ready';
    } else if (card.enabled && !card.configured) {
        badgeClass = 'warn';
        badgeLabel = 'Needs Setup';
    }

    return `
        <div class="status-card">
            <div class="status-card-title">
                <span>${escapeHtml(card.label)}</span>
                <span class="status-badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
            </div>
            <div class="status-card-copy">${escapeHtml(card.copy)}</div>
        </div>
    `;
}

function renderBadges(protocols, jobLeads, signalLeads, watchlist) {
    elements.badgeProtocols.textContent = String(protocols.length);
    elements.badgeJobLeads.textContent = String(jobLeads.length);
    elements.badgeSignalLeads.textContent = String(signalLeads.length);
    elements.badgeWatchlist.textContent = String(watchlist.length);
}

function renderCards(container, items, mode) {
    if (!container) {
        return;
    }

    if (items.length === 0) {
        container.innerHTML = mode === 'watchlist' ? '' : buildEmptyCard(mode);
        return;
    }

    container.innerHTML = items.map(item => buildCardMarkup(item, mode)).join('');
}

function buildCardMarkup(item, mode) {
    const initials = item.name
        .split(' ')
        .slice(0, 2)
        .map(part => part.charAt(0).toUpperCase())
        .join('');
    const isStarred = state.watchlist.includes(item.id);
    const isNew = item.listedAt ? Date.now() - item.listedAt <= NEW_ITEM_WINDOW_MS : mode !== 'watchlist';
    const badge = mode === 'signalLeads' ? `<div class="trending-rank">${escapeHtml(String(item.signalCount || 0))}</div>` : '';

    return `
        <article class="project-card ${isNew ? 'new-highlight' : ''}">
            ${badge}
            <div class="card-header">
                <div class="card-identity">
                    ${item.logo ? `<img class="card-logo" src="${escapeHtml(item.logo)}" alt="${escapeHtml(item.name)} logo" loading="lazy">` : `<div class="card-logo-placeholder">${escapeHtml(initials || '?')}</div>`}
                    <div>
                        <div class="card-name">${escapeHtml(item.name)}</div>
                        <div class="card-chain">${escapeHtml(item.symbol ? `${item.symbol} • ${item.chain}` : item.chain)}</div>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="card-action-btn ${isStarred ? 'starred' : ''}" onclick="toggleWatchlist('${escapeAttribute(item.id)}')" aria-label="Toggle watchlist">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="card-category">${escapeHtml(item.category)}</div>
            <div class="card-desc">${escapeHtml(item.description)}</div>
            <div class="card-metrics">
                ${(item.metrics || []).map(metric => `
                    <div class="metric">
                        <div class="metric-label">${escapeHtml(metric.label)}</div>
                        <div class="metric-value ${metric.tone || ''}">${escapeHtml(metric.value)}</div>
                    </div>
                `).join('')}
            </div>
            <div class="card-subsection">
                <div class="card-subtitle">Quick Links</div>
                ${buildQuickLinksMarkup(item.quickLinks || [])}
            </div>
            <div class="card-subsection">
                <div class="card-subtitle">Keyword Signals</div>
                ${buildSignalMarkup(item.keywordSignals || [])}
            </div>
            <div class="card-footer">
                <div class="card-time">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    ${escapeHtml(item.listedAt ? timeAgo(item.listedAt) : 'Live signal')}
                </div>
                <div class="card-links">
                    <a class="card-link" href="${escapeAttribute(item.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>
                    <a class="card-link" href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer">Project</a>
                </div>
            </div>
        </article>
    `;
}

function buildQuickLinksMarkup(quickLinks) {
    if (quickLinks.length === 0) {
        return '<div class="signal-empty">No quick links found yet on the scanned site.</div>';
    }

    return `<div class="quick-links">${quickLinks.map(link => `<a class="quick-link" href="${escapeAttribute(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.label)}</a>`).join('')}</div>`;
}

function buildSignalMarkup(keywordSignals) {
    if (keywordSignals.length === 0) {
        const watched = state.keywords.length > 0 ? `Watching: ${state.keywords.join(', ')}` : 'No keyword hits yet.';
        return `<div class="signal-empty">${escapeHtml(watched)}</div>`;
    }

    return `<div class="signal-list">${keywordSignals.slice(0, 5).map(signal => `
        <a class="signal-chip" href="${escapeAttribute(signal.url || '#')}" target="_blank" rel="noreferrer">
            <span class="signal-chip-label">${escapeHtml(signal.source)}</span>
            <span>${escapeHtml(signal.keyword)}</span>
        </a>
    `).join('')}</div>`;
}

function buildEmptyCard(mode) {
    const messageMap = {
        protocols: 'No fresh projects matched your filters.',
        jobLeads: 'No early job leads matched your filters.',
        signalLeads: 'No project or X keyword alerts matched your filters.'
    };

    return `
        <div class="empty-state">
            <h3>Nothing to show</h3>
            <p>${messageMap[mode] || 'No items matched your filters.'}</p>
        </div>
    `;
}

function applyFilters(items) {
    const term = state.searchTerm.trim().toLowerCase();

    return items.filter(item => {
        const keywordText = (item.keywordSignals || []).map(signal => `${signal.keyword} ${signal.source}`).join(' ');
        const quickLinkText = (item.quickLinks || []).map(link => `${link.label} ${link.url}`).join(' ');
        const matchesSearch = !term || `${item.name} ${item.symbol} ${item.category} ${item.chain} ${item.description} ${keywordText} ${quickLinkText}`.toLowerCase().includes(term);
        const matchesCategory = state.category === 'all' || item.category.toLowerCase() === state.category.toLowerCase();
        const matchesTime = !item.listedAt || item.listedAt >= Date.now() - state.timeWindowDays * 24 * 60 * 60 * 1000;

        return matchesSearch && matchesCategory && matchesTime;
    });
}

function applyWatchlistFilters() {
    const seen = new Set();
    const watchlistItems = Object.values(state.datasets)
        .flat()
        .filter(item => state.watchlist.includes(item.id))
        .filter(item => {
            if (seen.has(item.id)) {
                return false;
            }
            seen.add(item.id);
            return true;
        });

    return applyFilters(watchlistItems);
}

function toggleLoading(isLoading) {
    [elements.loadingProtocols, elements.loadingTrending, elements.loadingListings].forEach(element => {
        element.classList.toggle('hidden', !isLoading);
    });
}

function loadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
        console.warn(`Failed to load ${key}`, error);
        return fallback;
    }
}

function formatTime(date) {
    return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit'
    }).format(date);
}

function timeAgo(timestamp) {
    const elapsed = Date.now() - timestamp;
    const minutes = Math.max(1, Math.round(elapsed / 60000));

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);

    if (hours < 24) {
        return `${hours}h ago`;
    }

    return `${Math.round(hours / 24)}d ago`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
    return escapeHtml(value);
}

function showToast(kind, title, description) {
    const iconMap = {
        new: '▲',
        trending: '◉',
        error: '!'
    };

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <div class="toast-icon ${kind === 'error' ? 'trending' : kind}">${iconMap[kind] || '•'}</div>
        <div class="toast-text">
            <div class="toast-title">${escapeHtml(title)}</div>
            <div class="toast-desc">${escapeHtml(description)}</div>
        </div>
    `;

    elements.toastContainer.appendChild(toast);
    window.setTimeout(() => toast.remove(), 5000);
}

function sendBrowserNotification(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
        return;
    }

    new Notification(title, { body });
}

function requestNotifications() {
    if (!('Notification' in window)) {
        showToast('error', 'Notifications unavailable', 'This browser does not support notifications.');
        return;
    }

    Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
            showToast('new', 'Notifications enabled', 'You will be alerted when fresh items and keyword hits appear.');
        } else {
            showToast('error', 'Notifications blocked', 'Allow notifications in the browser to receive alerts.');
        }
    });
}

function switchTab(tabName) {
    state.currentTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `panel-${tabName}`);
    });
}

function handleSearch(value) {
    state.searchTerm = value;
    renderAll();
}

function filterByCategory(category, button) {
    state.category = category;

    document.querySelectorAll('.chip').forEach(chip => {
        chip.classList.toggle('active', chip === button);
    });

    renderAll();
}

function filterByTime(days) {
    state.timeWindowDays = Number.parseInt(days, 10) || 7;
    refreshAll();
}

function toggleWatchlist(itemId) {
    if (state.watchlist.includes(itemId)) {
        state.watchlist = state.watchlist.filter(entry => entry !== itemId);
        showToast('trending', 'Removed from watchlist', 'Item removed from your watchlist.');
    } else {
        state.watchlist = [...state.watchlist, itemId];
        showToast('new', 'Added to watchlist', 'Item added to your watchlist.');
    }

    localStorage.setItem('alpha-watchlist', JSON.stringify(state.watchlist));
    renderAll();
}

window.refreshAll = refreshAll;
window.requestNotifications = requestNotifications;
window.switchTab = switchTab;
window.handleSearch = handleSearch;
window.filterByCategory = filterByCategory;
window.filterByTime = filterByTime;
window.toggleWatchlist = toggleWatchlist;