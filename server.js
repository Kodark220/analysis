'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const IS_VERCEL = Boolean(process.env.VERCEL);
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_KEYWORDS = ['hiring', 'contributors', 'intern', 'ambassador', 'bounty', 'grant', 'fellowship', 'researcher', 'moderator', 'business development'];
const DEFAULT_WEBSITE_PATHS = ['/careers', '/jobs', '/docs', '/community', '/discord'];
const LOCAL_ALERT_STORE_PATH = path.join(ROOT, '.alpha-alert-cache.json');
const cache = new Map();
const deliveredAlertIds = new Set();

loadDotEnv(path.join(ROOT, '.env'));

async function handleRequest(request, response) {
    try {
        const url = new URL(request.url, `http://${request.headers.host}`);

        if (url.pathname === '/api/discovery') {
            await handleDiscoveryUrl(url, response);
            return;
        }

        if (request.method === 'OPTIONS') {
            writeCorsHeaders(response);
            response.writeHead(204);
            response.end();
            return;
        }

        await serveStatic(url.pathname, response);
    } catch (error) {
        console.error(error);
        writeCorsHeaders(response);
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message || 'Internal server error.' }));
    }
}

if (require.main === module) {
    const server = http.createServer(handleRequest);

    server.listen(PORT, () => {
        console.log(`Alpha Tracker backend running at http://localhost:${PORT}`);
        void reportStartupStatus();
    });
}

async function handleDiscoveryUrl(url, response) {
    const days = clampNumber(Number.parseInt(url.searchParams.get('days') || '7', 10), 1, 90);
    const cacheKey = `days:${days}`;
    const cached = cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        writeJson(response, cached.payload);
        return;
    }

    const config = await loadConfig();
    const payload = await buildDiscoveryPayload(days, config);
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    writeJson(response, payload);
}

async function handleDiscoveryRequest(request, response) {
    const host = request.headers.host || 'localhost';
    const url = new URL(request.url || '/api/discovery', `http://${host}`);
    await handleDiscoveryUrl(url, response);
}

async function serveStatic(pathname, response) {
    const normalizedPath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(ROOT, normalizedPath.replace(/^\/+/, ''));

    if (!filePath.startsWith(ROOT)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }

    try {
        const content = await fs.readFile(filePath);
        response.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
        response.end(content);
    } catch (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
    }
}

async function buildDiscoveryPayload(days, config) {
    const keywords = Array.from(new Set((config.keywords || DEFAULT_KEYWORDS).map(keyword => String(keyword).toLowerCase())));
    const executionProfile = getExecutionProfile(config);
    const timeoutMs = executionProfile.timeoutMs;
    const projectLimit = executionProfile.projectLimit;
    const channelStatuses = buildChannelStatuses(config.webhooks || []);
    const alertStore = buildAlertStoreStatus();
    const warnings = buildConfigWarnings(config, channelStatuses, alertStore);
    const protocols = await fetchProtocols(days, projectLimit, timeoutMs);
    const enrichedProtocols = await mapLimit(protocols, executionProfile.enrichmentConcurrency, protocol => enrichProtocol(protocol, keywords, timeoutMs, config.websitePaths || DEFAULT_WEBSITE_PATHS, executionProfile));
    const xAlerts = await fetchXAlerts(config.xAccounts || [], keywords, timeoutMs, executionProfile);
    const protocolsWithMentions = attachXSignals(enrichedProtocols, xAlerts);
    const keywordAlerts = buildKeywordAlerts(protocolsWithMentions, xAlerts);
    const deliveryStats = await notifyWebhooks(keywordAlerts, config.webhooks || [], timeoutMs);

    return {
        generatedAt: new Date().toISOString(),
        keywords,
        sourceStatus: {
            xAccountsConfigured: (config.xAccounts || []).length,
            xFeedsActive: (config.xAccounts || []).filter(account => Boolean(account.rssUrl)).length,
            webhookTargets: (config.webhooks || []).filter(webhook => webhook.enabled !== false).length,
            websitePaths: config.websitePaths || DEFAULT_WEBSITE_PATHS,
            channelStatuses,
            alertStore: publicAlertStoreStatus(alertStore),
            executionProfile: publicExecutionProfile(executionProfile),
            warnings,
            windowsEnvSupported: true
        },
        keywordAlerts,
        alertDelivery: deliveryStats,
        datasets: buildDatasets(protocolsWithMentions)
    };
}

async function reportStartupStatus() {
    const config = await loadConfig();
    const channelStatuses = buildChannelStatuses(config.webhooks || []);
    const warnings = buildConfigWarnings(config, channelStatuses, buildAlertStoreStatus());

    if (warnings.length === 0) {
        console.log('Alpha Tracker config looks good. No startup warnings.');
        return;
    }

    console.warn('Alpha Tracker startup warnings:');
    for (const warning of warnings) {
        console.warn(`- ${warning}`);
    }
}

async function fetchProtocols(days, projectLimit, timeoutMs) {
    const data = await fetchJson('https://api.llama.fi/protocols', timeoutMs);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    return data
        .filter(protocol => Number.isFinite(protocol.listedAt) && protocol.listedAt * 1000 >= cutoff)
        .sort((left, right) => right.listedAt - left.listedAt)
        .slice(0, projectLimit)
        .map(protocol => {
            const websiteUrl = normalizeUrl(protocol.url);
            const sourceUrl = `https://defillama.com/protocol/${protocol.slug || ''}`;

            return ({
            id: `protocol-${slugify(protocol.slug || protocol.name || String(protocol.id || 'unknown'))}`,
            name: protocol.name || 'Unknown Project',
            symbol: protocol.symbol || '',
            slug: protocol.slug || '',
            category: protocol.category || 'Unknown',
            chain: protocol.chain || 'Multi-Chain',
            description: buildProtocolDescription(protocol),
            logo: protocol.logo || '',
            url: websiteUrl || sourceUrl,
            sourceUrl,
            websiteUrl,
            tvl: protocol.tvl || 0,
            mcap: protocol.mcap || 0,
            listedAt: protocol.listedAt * 1000,
            quickLinks: [],
            keywordSignals: [],
            signalCount: 0,
            metrics: []
            });
        });
}

async function enrichProtocol(protocol, keywords, timeoutMs, websitePaths, executionProfile) {
    if (!protocol.websiteUrl) {
        return protocol;
    }

    try {
        const homepage = await fetchText(protocol.websiteUrl, timeoutMs);
        const homepageLinks = extractLinks(homepage, protocol.websiteUrl);
        const quickLinks = await buildQuickLinks(homepageLinks, protocol.websiteUrl, websitePaths, timeoutMs);
        const signals = scanForKeywords(stripHtml(homepage), keywords, {
            source: 'website',
            label: 'Homepage',
            url: protocol.websiteUrl,
            projectName: protocol.name
        });

        for (const link of quickLinks.slice(0, executionProfile.quickLinkScanLimit)) {
            try {
                const page = await fetchText(link.url, timeoutMs);
                signals.push(...scanForKeywords(stripHtml(page), keywords, {
                    source: 'website',
                    label: link.label,
                    url: link.url,
                    projectName: protocol.name
                }));
            } catch (error) {
                continue;
            }
        }

        const keywordSignals = dedupeSignals(signals);
        return {
            ...protocol,
            quickLinks,
            keywordSignals,
            signalCount: keywordSignals.length
        };
    } catch (error) {
        return protocol;
    }
}

async function buildQuickLinks(links, websiteUrl, websitePaths, timeoutMs) {
    const selected = [];
    const categories = [
        { label: 'Careers', matcher: /(career|careers|job|jobs|join|work with us|work-with-us|hiring)/i, fallbackPath: websitePaths.find(entry => /career|job/i.test(entry)) || '/careers' },
        { label: 'Docs', matcher: /(docs|documentation|developer|developers|whitepaper|litepaper|gitbook|guide)/i, fallbackPath: websitePaths.find(entry => /docs/i.test(entry)) || '/docs' },
        { label: 'Community', matcher: /(community|discord|telegram|forum|github|x\.com|twitter\.com)/i, fallbackPath: websitePaths.find(entry => /community|discord/i.test(entry)) || '/community' }
    ];

    for (const category of categories) {
        const match = links.find(link => category.matcher.test(`${link.text} ${link.url}`));
        if (match) {
            selected.push({ label: category.label, url: match.url });
            continue;
        }

        try {
            const candidateUrl = new URL(category.fallbackPath, websiteUrl).href;
            await fetchText(candidateUrl, Math.min(timeoutMs, 2500));
            selected.push({ label: category.label, url: candidateUrl });
        } catch (error) {
            continue;
        }
    }

    return dedupeLinks(selected);
}

async function fetchXAlerts(accounts, keywords, timeoutMs, executionProfile) {
    const alerts = [];

    for (const account of accounts) {
        if (!account.rssUrl) {
            continue;
        }

        try {
            const rss = await fetchText(account.rssUrl, timeoutMs);
            const items = parseRssItems(rss);

            for (const item of items.slice(0, executionProfile.feedItemLimit)) {
                const text = `${item.title} ${item.description}`.toLowerCase();
                for (const keyword of keywords) {
                    if (!new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i').test(text)) {
                        continue;
                    }

                    alerts.push({
                        id: `x-${slugify(account.handle || account.label || 'account')}-${slugify(item.link || item.title)}-${keyword}`,
                        keyword,
                        source: 'x',
                        label: account.handle ? `@${account.handle}` : (account.label || 'Watched feed'),
                        url: item.link || account.profileUrl || account.rssUrl,
                        text: `${item.title} ${item.description}`,
                        projectName: '',
                        publishedAt: item.publishedAt || ''
                    });
                }
            }
        } catch (error) {
            continue;
        }
    }

    return dedupeSignals(alerts);
}

function attachXSignals(protocols, xAlerts) {
    return protocols.map(protocol => {
        const matches = xAlerts.filter(alert => matchesProject(protocol, alert.text || ''));
        const keywordSignals = dedupeSignals([
            ...protocol.keywordSignals,
            ...matches.map(alert => ({ ...alert, projectName: protocol.name }))
        ]);

        return {
            ...protocol,
            keywordSignals,
            signalCount: keywordSignals.length
        };
    });
}

function buildDatasets(protocols) {
    const protocolsDataset = protocols.map(protocol => ({
        ...protocol,
        metrics: [
            { label: 'TVL', value: formatCompactCurrency(protocol.tvl) },
            { label: 'Chain', value: protocol.chain || 'Multi' },
            { label: 'Age', value: timeAgo(protocol.listedAt) }
        ]
    }));

    const jobLeads = protocols
        .filter(protocol => protocol.websiteUrl)
        .sort((left, right) => (right.quickLinks.length + right.signalCount) - (left.quickLinks.length + left.signalCount) || (right.tvl || 0) - (left.tvl || 0))
        .map(protocol => ({
            ...protocol,
            description: `${protocol.name} has a live site plus quick links you can use to inspect careers, docs, and community before the project gets crowded.`,
            metrics: [
                { label: 'Quick Links', value: String(protocol.quickLinks.length) },
                { label: 'Signals', value: String(protocol.signalCount) },
                { label: 'Age', value: timeAgo(protocol.listedAt) }
            ]
        }));

    const signalLeads = protocols
        .filter(protocol => protocol.signalCount > 0)
        .sort((left, right) => right.signalCount - left.signalCount || right.listedAt - left.listedAt)
        .map(protocol => ({
            ...protocol,
            description: `${protocol.name} triggered one or more watched keywords. Check the linked pages before the opportunity is obvious to everyone else.`,
            metrics: [
                { label: 'Signals', value: String(protocol.signalCount) },
                { label: 'Top Hit', value: protocol.keywordSignals[0]?.keyword || '—' },
                { label: 'Age', value: timeAgo(protocol.listedAt) }
            ]
        }));

    return {
        protocols: protocolsDataset,
        jobLeads,
        signalLeads
    };
}

function buildKeywordAlerts(protocols, xAlerts) {
    const protocolAlerts = protocols.flatMap(protocol =>
        protocol.keywordSignals.map(signal => ({
            ...signal,
            id: signal.id || `${protocol.id}-${signal.source}-${signal.keyword}`,
            projectName: protocol.name,
            projectUrl: protocol.url || protocol.websiteUrl || protocol.sourceUrl || '',
            quickLinks: protocol.quickLinks || [],
            category: protocol.category || '',
            chain: protocol.chain || '',
            tvl: protocol.tvl || 0,
            listedAt: protocol.listedAt || 0,
            signalCount: protocol.signalCount || 0,
            whyScore: computeWhyItMattersScore(protocol, signal),
            whyReason: buildWhyItMattersReason(protocol, signal)
        }))
    );

    const seen = new Set();

    return [...protocolAlerts, ...xAlerts].filter(alert => {
        const key = `${alert.projectName || alert.label || ''}|${alert.source}|${alert.keyword}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    }).slice(0, 100);
}

function buildProtocolDescription(protocol) {
    const parts = [];

    if (protocol.category) {
        parts.push(protocol.category);
    }

    if (protocol.chain) {
        parts.push(`on ${protocol.chain}`);
    }

    if (protocol.mcap) {
        parts.push(`mcap ${formatCompactCurrency(protocol.mcap)}`);
    }

    return parts.length > 0
        ? `${protocol.name} is a newly listed ${parts.join(' ')} project being tracked on DefiLlama.`
        : `${protocol.name} is a newly listed project being tracked on DefiLlama.`;
}

function scanForKeywords(text, keywords, context) {
    const lowered = text.toLowerCase();
    const alerts = [];

    for (const keyword of keywords) {
        if (!new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i').test(lowered)) {
            continue;
        }

        alerts.push({
            id: `${slugify(context.projectName || context.label || context.url)}-${context.source}-${keyword}-${slugify(context.url)}`,
            keyword,
            source: context.source,
            label: context.label,
            url: context.url,
            projectName: context.projectName || ''
        });
    }

    return alerts;
}

function extractLinks(html, baseUrl) {
    const links = [];
    const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match = anchorRegex.exec(html);

    while (match) {
        const href = match[1];
        const text = stripHtml(match[2]).replace(/\s+/g, ' ').trim();
        if (!href || /^mailto:|^javascript:|^#/.test(href)) {
            match = anchorRegex.exec(html);
            continue;
        }

        try {
            const resolved = new URL(href, baseUrl).href;
            links.push({ text, url: resolved });
        } catch (error) {
            match = anchorRegex.exec(html);
            continue;
        }

        match = anchorRegex.exec(html);
    }

    return dedupeLinks(links);
}

function parseRssItems(rss) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match = itemRegex.exec(rss);

    while (match) {
        const block = match[1];
        items.push({
            title: decodeEntities(extractXmlTag(block, 'title')),
            link: decodeEntities(extractXmlTag(block, 'link')),
            description: decodeEntities(extractXmlTag(block, 'description')),
            publishedAt: decodeEntities(extractXmlTag(block, 'pubDate'))
        });
        match = itemRegex.exec(rss);
    }

    return items;
}

function extractXmlTag(block, tag) {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)<\/${tag}>`, 'i').exec(block);
    return match ? match[1] : '';
}

function decodeEntities(value) {
    return String(value || '')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('<![CDATA[', '')
        .replaceAll(']]>', '');
}

function stripHtml(value) {
    return String(value || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function matchesProject(protocol, text) {
    const haystack = String(text || '').toLowerCase();
    const projectName = protocol.name.toLowerCase();
    const slug = protocol.slug.toLowerCase();
    return haystack.includes(projectName) || (slug && haystack.includes(slug.replace(/-/g, ' ')));
}

async function loadConfig() {
    try {
        const raw = await fs.readFile(path.join(ROOT, 'monitored-sources.json'), 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        return {
            keywords: DEFAULT_KEYWORDS,
            xAccounts: [],
            webhooks: [],
            projectLimit: 24,
            requestTimeoutMs: DEFAULT_TIMEOUT_MS,
            websitePaths: DEFAULT_WEBSITE_PATHS
        };
    }
}

async function notifyWebhooks(alerts, webhooks, timeoutMs) {
    const enabledHooks = (webhooks || []).filter(webhook => webhook && webhook.enabled !== false);
    const alertStore = buildAlertStoreStatus();
    const storedAlertIds = await getStoredAlertIds(alerts.map(alert => alert.id), alertStore, timeoutMs);
    const newAlerts = alerts.filter(alert => !deliveredAlertIds.has(alert.id) && !storedAlertIds.has(alert.id));

    if (enabledHooks.length === 0 || newAlerts.length === 0) {
        return {
            enabled: enabledHooks.length,
            sent: 0,
            store: alertStore.mode
        };
    }

    let sent = 0;
    const deliveredSuccessfully = new Map();

    for (const webhook of enabledHooks) {
        for (const alert of newAlerts) {
            try {
                await deliverWebhook(webhook, alert, timeoutMs);
                sent += 1;
                deliveredSuccessfully.set(alert.id, alert);
            } catch (error) {
                console.error(`Failed to deliver alert to ${webhook.type || 'webhook'}`, error.message);
            }
        }
    }

    for (const alert of deliveredSuccessfully.values()) {
        deliveredAlertIds.add(alert.id);
    }

    await markAlertsDelivered(Array.from(deliveredSuccessfully.values()), alertStore, timeoutMs);
    trimDeliveredAlertCache();

    return {
        enabled: enabledHooks.length,
        sent,
        store: alertStore.mode
    };
}

async function getStoredAlertIds(ids, alertStore, timeoutMs) {
    const localIds = await readLocalAlertStore();
    const matches = new Set(ids.filter(id => localIds.has(id)));

    if (!alertStore.useSupabase) {
        return matches;
    }

    try {
        const remoteIds = await getSupabaseDeliveredIds(ids, alertStore, timeoutMs);
        for (const id of remoteIds) {
            matches.add(id);
        }
    } catch (error) {
        console.error('Failed to read Supabase alert store', error.message);
    }

    return matches;
}

async function markAlertsDelivered(alerts, alertStore, timeoutMs) {
    if (alerts.length === 0) {
        return;
    }

    const localIds = await readLocalAlertStore();
    for (const alert of alerts) {
        localIds.add(alert.id);
    }
    await writeLocalAlertStore(localIds);

    if (!alertStore.useSupabase) {
        return;
    }

    try {
        await upsertSupabaseAlerts(alerts, alertStore, timeoutMs);
    } catch (error) {
        console.error('Failed to write Supabase alert store', error.message);
    }
}

async function readLocalAlertStore() {
    if (!canUseLocalAlertStore()) {
        return new Set();
    }

    try {
        const raw = await fs.readFile(LOCAL_ALERT_STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const ids = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed.ids)
                ? parsed.ids
                : [];
        return new Set(ids.map(value => String(value)).slice(-1000));
    } catch (error) {
        if (error && error.code !== 'ENOENT') {
            console.error('Failed to read local alert cache', error.message);
        }
        return new Set();
    }
}

async function writeLocalAlertStore(ids) {
    if (!canUseLocalAlertStore()) {
        return;
    }

    const uniqueIds = Array.from(new Set(ids)).slice(-1000);
    await fs.writeFile(LOCAL_ALERT_STORE_PATH, JSON.stringify({ ids: uniqueIds }, null, 2), 'utf8');
}

async function getSupabaseDeliveredIds(ids, alertStore, timeoutMs) {
    if (ids.length === 0) {
        return new Set();
    }

    const params = new URLSearchParams();
    params.set('select', 'id');
    params.set('id', `in.(${ids.map(id => `"${escapePostgrestValue(id)}"`).join(',')})`);

    const response = await fetchWithTimeout(`${alertStore.url}/rest/v1/${alertStore.table}?${params.toString()}`, timeoutMs, {
        headers: buildSupabaseHeaders(alertStore.key)
    });

    if (!response.ok) {
        throw new Error(`Supabase lookup failed with status ${response.status}.`);
    }

    const rows = await response.json();
    return new Set((rows || []).map(row => String(row.id)));
}

async function upsertSupabaseAlerts(alerts, alertStore, timeoutMs) {
    const response = await fetchWithTimeout(`${alertStore.url}/rest/v1/${alertStore.table}`, timeoutMs, {
        method: 'POST',
        headers: {
            ...buildSupabaseHeaders(alertStore.key),
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(alerts.map(alert => ({
            id: alert.id,
            project_name: alert.projectName || '',
            keyword: alert.keyword || '',
            source: alert.source || '',
            alert_url: alert.url || alert.projectUrl || '',
            channel_mode: 'alerts',
            delivered_at: new Date().toISOString()
        })))
    });

    if (!response.ok) {
        throw new Error(`Supabase upsert failed with status ${response.status}.`);
    }
}

function buildSupabaseHeaders(key) {
    return {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'User-Agent': 'AlphaTracker/1.0'
    };
}

async function deliverWebhook(webhook, alert, timeoutMs) {
    const normalizedType = String(webhook.type || 'generic').toLowerCase();

    if (normalizedType === 'telegram') {
        const botToken = readSecret(webhook.botToken, webhook.botTokenEnv);
        const chatId = readSecret(webhook.chatId, webhook.chatIdEnv);
        if (!botToken || !chatId) {
            throw new Error('Telegram webhook requires botToken and chatId.');
        }

        const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const payload = {
            chat_id: chatId,
            text: formatAlertMessage(alert, webhook)
        };
        await postJson(endpoint, payload, timeoutMs);
        return;
    }

    const url = readSecret(webhook.url, webhook.urlEnv);
    if (!url) {
        throw new Error('Webhook URL is required.');
    }

    if (normalizedType === 'discord' || normalizedType === 'slack') {
        await postJson(url, { content: formatAlertMessage(alert, webhook) }, timeoutMs);
        return;
    }

    await postJson(url, {
        title: 'Alpha Tracker keyword alert',
        message: formatAlertMessage(alert, webhook),
        alert
    }, timeoutMs);
}

function formatAlertMessage(alert, webhook) {
    if (String(webhook.mode || 'alerts').toLowerCase() === 'analysis') {
        return formatAnalysisMessage(alert, webhook);
    }

    const prefix = webhook.label ? `[${webhook.label}] ` : '';
    const lead = alert.projectName || alert.label || 'Project';
    return `${prefix}${lead}: ${alert.keyword} detected on ${alert.source}. ${alert.url || ''}`.trim();
}

function formatAnalysisMessage(alert, webhook) {
    const projectName = alert.projectName || alert.label || 'Project';
    const quickLinks = Array.isArray(alert.quickLinks) ? alert.quickLinks.slice(0, 3) : [];
    const quickLinkLine = quickLinks.length > 0
        ? `Quick Links: ${quickLinks.map(link => `${link.label}: ${link.url}`).join(' | ')}`
        : '';
    const score = Number.isFinite(alert.whyScore) ? `${alert.whyScore}/10` : '';
    const lines = [
        webhook.label ? `[${webhook.label}] ${projectName}` : projectName,
        alert.whyReason ? `Why this matters: ${alert.whyReason}${score ? ` (${score})` : ''}` : '',
        alert.category || alert.chain ? `Project: ${[alert.category, alert.chain].filter(Boolean).join(' • ')}` : '',
        Number.isFinite(alert.tvl) && alert.tvl > 0 ? `TVL: ${formatCompactCurrency(alert.tvl)}` : '',
        alert.listedAt ? `Age: ${timeAgo(alert.listedAt)}` : '',
        `Keyword: ${alert.keyword}`,
        `Source: ${alert.source}${alert.label ? ` (${alert.label})` : ''}`,
        alert.projectUrl ? `Project Link: ${alert.projectUrl}` : '',
        alert.url && alert.url !== alert.projectUrl ? `Signal Link: ${alert.url}` : '',
        quickLinkLine,
        alert.text ? `Context: ${collapseWhitespace(alert.text).slice(0, 300)}` : ''
    ].filter(Boolean);

    return lines.join('\n').slice(0, 1800);
}

function computeWhyItMattersScore(protocol, signal) {
    let score = 3;

    if ((protocol.quickLinks || []).length >= 3) {
        score += 2;
    } else if ((protocol.quickLinks || []).length > 0) {
        score += 1;
    }

    if ((protocol.signalCount || 0) >= 2) {
        score += 2;
    } else if ((protocol.signalCount || 0) === 1) {
        score += 1;
    }

    const keyword = String(signal.keyword || '').toLowerCase();
    if (/hiring|intern|contributors|ambassador|business development|researcher|moderator/.test(keyword)) {
        score += 2;
    } else if (/bounty|grant|fellowship/.test(keyword)) {
        score += 1;
    }

    if (protocol.listedAt && protocol.listedAt >= Date.now() - 7 * 24 * 60 * 60 * 1000) {
        score += 1;
    }

    return clampNumber(score, 1, 10);
}

function buildWhyItMattersReason(protocol, signal) {
    const reasons = [];
    const keyword = String(signal.keyword || '').toLowerCase();

    if ((protocol.quickLinks || []).length >= 2) {
        reasons.push('fast research path from careers/docs/community links');
    }

    if ((protocol.signalCount || 0) >= 2) {
        reasons.push('multiple hiring-style signals already showing up');
    } else if ((protocol.signalCount || 0) === 1) {
        reasons.push('at least one direct opportunity signal detected');
    }

    if (/hiring|intern|contributors|ambassador|business development|researcher|moderator/.test(keyword)) {
        reasons.push(`the keyword "${keyword}" is directly relevant to getting in early`);
    } else if (/bounty|grant|fellowship/.test(keyword)) {
        reasons.push(`the keyword "${keyword}" can lead to an early contributor path`);
    }

    if (protocol.listedAt && protocol.listedAt >= Date.now() - 7 * 24 * 60 * 60 * 1000) {
        reasons.push('the project is still newly listed');
    }

    return reasons.slice(0, 2).join('; ');
}

async function postJson(url, payload, timeoutMs) {
    const response = await fetchWithTimeout(url, timeoutMs, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'AlphaTracker/1.0'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Webhook request failed for ${url}`);
    }
}

function trimDeliveredAlertCache() {
    if (deliveredAlertIds.size <= 500) {
        return;
    }

    const overflow = deliveredAlertIds.size - 500;
    let index = 0;
    for (const id of deliveredAlertIds) {
        deliveredAlertIds.delete(id);
        index += 1;
        if (index >= overflow) {
            break;
        }
    }
}

function buildAlertStoreStatus() {
    const url = String(process.env.SUPABASE_URL || '').trim();
    const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const table = String(process.env.SUPABASE_ALERTS_TABLE || 'sent_alerts').trim() || 'sent_alerts';
    const missing = [
        ...(url ? [] : ['SUPABASE_URL']),
        ...(key ? [] : ['SUPABASE_SERVICE_ROLE_KEY'])
    ];

    if (url && key) {
        return {
            mode: 'supabase',
            label: 'Supabase',
            configured: true,
            useSupabase: true,
            url,
            key,
            table,
            copy: `Using Supabase table ${table} for delivered alert history.`
        };
    }

    return {
        mode: 'local',
        label: 'Local Cache',
        configured: true,
        useSupabase: false,
        table,
        missing,
        partial: missing.length > 0 && missing.length < 2,
        copy: 'Using a local disk cache for delivered alerts. Add Supabase env vars for shared persistence across machines.'
    };
}

function getExecutionProfile(config) {
    const requestedTimeout = clampNumber(Number(config.requestTimeoutMs || DEFAULT_TIMEOUT_MS), 1500, 10000);
    const requestedProjectLimit = clampNumber(Number(config.projectLimit || 24), 6, 40);

    if (!IS_VERCEL) {
        return {
            mode: 'local',
            timeoutMs: requestedTimeout,
            projectLimit: requestedProjectLimit,
            enrichmentConcurrency: 4,
            quickLinkScanLimit: 3,
            feedItemLimit: 8
        };
    }

    return {
        mode: 'vercel',
        timeoutMs: Math.min(requestedTimeout, 2500),
        projectLimit: Math.min(requestedProjectLimit, 10),
        enrichmentConcurrency: 3,
        quickLinkScanLimit: 1,
        feedItemLimit: 5
    };
}

function publicExecutionProfile(profile) {
    return {
        mode: profile.mode,
        timeoutMs: profile.timeoutMs,
        projectLimit: profile.projectLimit,
        enrichmentConcurrency: profile.enrichmentConcurrency,
        quickLinkScanLimit: profile.quickLinkScanLimit,
        feedItemLimit: profile.feedItemLimit
    };
}

function canUseLocalAlertStore() {
    return !process.env.VERCEL;
}

function publicAlertStoreStatus(alertStore) {
    return {
        mode: alertStore.mode,
        label: alertStore.label,
        configured: alertStore.configured,
        useSupabase: alertStore.useSupabase,
        table: alertStore.table,
        missing: alertStore.missing,
        partial: alertStore.partial,
        copy: alertStore.copy
    };
}

async function fetchJson(url, timeoutMs) {
    const response = await fetchWithTimeout(url, timeoutMs, { headers: { 'User-Agent': 'AlphaTracker/1.0' } });
    if (!response.ok) {
        throw new Error(`Request failed for ${url}`);
    }
    return response.json();
}

async function fetchText(url, timeoutMs) {
    const response = await fetchWithTimeout(url, timeoutMs, { headers: { 'User-Agent': 'AlphaTracker/1.0', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    if (!response.ok) {
        throw new Error(`Request failed for ${url}`);
    }
    return response.text();
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    } finally {
        clearTimeout(timeout);
    }
}

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let index = 0;

    async function run() {
        while (index < items.length) {
            const currentIndex = index;
            index += 1;
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
}

function dedupeLinks(links) {
    const seen = new Set();
    return links.filter(link => {
        const key = `${link.label}|${link.url}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function dedupeSignals(signals) {
    const seen = new Set();
    return signals.filter(signal => {
        const key = `${signal.projectName || signal.label || ''}|${signal.source}|${signal.keyword}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function formatCompactCurrency(value) {
    if (!Number.isFinite(value)) {
        return '—';
    }

    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: 'compact',
        maximumFractionDigits: 2
    }).format(value);
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

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'item';
}

function normalizeUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return '';
    }

    try {
        const url = new URL(trimmed);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return url.href;
        }
    } catch (error) {
        return '';
    }

    return '';
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contentTypeFor(filePath) {
    if (filePath.endsWith('.html')) {
        return 'text/html; charset=utf-8';
    }
    if (filePath.endsWith('.css')) {
        return 'text/css; charset=utf-8';
    }
    if (filePath.endsWith('.js')) {
        return 'application/javascript; charset=utf-8';
    }
    if (filePath.endsWith('.json')) {
        return 'application/json; charset=utf-8';
    }
    return 'text/plain; charset=utf-8';
}

function writeCorsHeaders(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
}

function writeJson(response, payload) {
    writeCorsHeaders(response);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
}

function readSecret(value, envName) {
    const directValue = String(value || '').trim();
    if (directValue) {
        return directValue;
    }

    const envKey = String(envName || '').trim();
    if (!envKey) {
        return '';
    }

    return String(process.env[envKey] || '').trim();
}

function loadDotEnv(filePath) {
    try {
        const raw = require('fs').readFileSync(filePath, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex === -1) {
                continue;
            }

            const key = trimmed.slice(0, separatorIndex).trim();
            let value = trimmed.slice(separatorIndex + 1).trim();

            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            if (key && !(key in process.env)) {
                process.env[key] = value;
            }
        }
    } catch (error) {
        if (error && error.code !== 'ENOENT') {
            console.error('Failed to load .env file', error.message);
        }
    }
}

function buildChannelStatuses(webhooks) {
    return (webhooks || []).map(webhook => {
        const type = String(webhook.type || 'generic').toLowerCase();
        const enabled = webhook.enabled !== false;
        const mode = String(webhook.mode || 'alerts').toLowerCase();

        if (type === 'telegram') {
            const hasBotToken = Boolean(readSecret(webhook.botToken, webhook.botTokenEnv));
            const hasChatId = Boolean(readSecret(webhook.chatId, webhook.chatIdEnv));
            return {
                type,
                mode,
                label: webhook.label || 'Telegram',
                enabled,
                configured: hasBotToken && hasChatId,
                missing: [
                    ...(hasBotToken ? [] : ['bot token']),
                    ...(hasChatId ? [] : ['chat id'])
                ]
            };
        }

        const hasUrl = Boolean(readSecret(webhook.url, webhook.urlEnv));
        return {
            type,
            mode,
            label: webhook.label || webhook.type || 'Webhook',
            enabled,
            configured: hasUrl,
            missing: hasUrl ? [] : ['webhook url']
        };
    });
}

function buildConfigWarnings(config, channelStatuses, alertStore) {
    const warnings = [];

    const enabledButMissing = channelStatuses.filter(channel => channel.enabled && !channel.configured);
    for (const channel of enabledButMissing) {
        warnings.push(`${channel.label} is enabled but missing ${channel.missing.join(' and ')}.`);
    }

    const noXFeeds = (config.xAccounts || []).length > 0 && (config.xAccounts || []).every(account => !account.rssUrl);
    if (noXFeeds) {
        warnings.push('X accounts are configured but no RSS feed URLs are set yet.');
    }

    if ((config.webhooks || []).length === 0) {
        warnings.push('No webhook channels are configured. Alerts will stay inside the browser only.');
    }

    if (alertStore && alertStore.partial) {
        warnings.push(`Supabase alert storage is partially configured. Missing ${alertStore.missing.join(' and ')}.`);
    }

    return warnings;
}

function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapePostgrestValue(value) {
    return String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

module.exports = {
    handleRequest,
    handleDiscoveryRequest,
    reportStartupStatus
};