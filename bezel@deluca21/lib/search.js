const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

// A word counts only when it appears in order as real text. Scattered letters do not match.
export function matchScore(query, value) {
    const text = normalize(value);
    const words = normalize(query).trim().split(/\s+/).filter(Boolean);
    if (!words.length)
        return 0;
    let score = 0;
    for (const word of words) {
        const at = text.indexOf(word);
        if (at < 0)
            return Infinity;
        score += at === 0 ? 0 : 8 + Math.min(at, 24);
    }
    return score;
}

export function scoreItem(query, item) {
    const name = matchScore(query, item.name);
    const keys = matchScore(query, item.keywords ?? '');
    if (!Number.isFinite(name) && !Number.isFinite(keys))
        return Infinity;
    if (!Number.isFinite(name))
        return 60 + keys;
    if (!Number.isFinite(keys))
        return name;
    return Math.min(name, keys + 24);
}

// An exact or prefix hit drops results that only brushed a keyword or description.
export function filterMatches(query, items) {
    const ranked = items.map(item => ({...item, score: scoreItem(query, item)}))
        .filter(item => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    if (!normalize(query) || !ranked.length)
        return ranked;
    const best = ranked[0].score;
    const limit = best <= 16 ? Math.max(best, 16) : best;
    return ranked.filter(item => item.score <= limit);
}

const FACTORS = {
    km: [1000, 'm'], mi: [1609.344, 'm'], m: [1, 'm'], ft: [0.3048, 'm'], cm: [0.01, 'm'],
    kg: [1000, 'g'], lb: [453.592, 'g'], g: [1, 'g'], oz: [28.3495, 'g'],
};

export function convertUnits(query) {
    const temp = /^\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([cf])\s*(?:to|in)?\s*°?\s*([cf])\s*$/i.exec(query);
    if (temp && temp[2].toLowerCase() !== temp[3].toLowerCase()) {
        const value = Number(temp[1]);
        const result = temp[2].toLowerCase() === 'c' ? value * 9 / 5 + 32 : (value - 32) * 5 / 9;
        return `${trimNumber(result)} °${temp[3].toUpperCase()}`;
    }
    const unit = /^\s*([+-]?\d+(?:\.\d+)?)\s*([a-z]+)\s+(?:to|in)\s+([a-z]+)\s*$/i.exec(query);
    if (!unit)
        return null;
    const from = FACTORS[unit[2].toLowerCase()];
    const to = FACTORS[unit[3].toLowerCase()];
    if (!from || !to || from[1] !== to[1])
        return null;
    return `${trimNumber(Number(unit[1]) * from[0] / to[0])} ${unit[3].toLowerCase()}`;
}

export function calculate(query) {
    const expr = query.trim().replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**');
    if (!/^[\d\s.+\-*/()%]+$/.test(expr.replace(/\*\*/g, '')) || !/\d/.test(expr) || !/[+\-*/%]/.test(expr))
        return null;
    try {
        const value = Function(`"use strict"; return (${expr})`)();
        return typeof value === 'number' && Number.isFinite(value) ? trimNumber(value) : null;
    } catch {
        return null;
    }
}

function trimNumber(value) {
    return String(Math.round(value * 10000) / 10000);
}

export const BANGS = {
    g: ['Google', 'https://www.google.com/search?q='],
    yt: ['YouTube', 'https://www.youtube.com/results?search_query='],
    r: ['Reddit', 'https://www.reddit.com/search/?q='],
    w: ['Wikipedia', 'https://en.wikipedia.org/wiki/Special:Search?search='],
    gh: ['GitHub', 'https://github.com/search?q='],
    ddg: ['DuckDuckGo', 'https://duckduckgo.com/?q='],
    map: ['Maps', 'https://www.google.com/maps/search/'],
};

export function webSearch(query) {
    const match = /^!([a-z]+)\s*(.*)$/i.exec(query.trim());
    if (!match)
        return null;
    const bang = BANGS[match[1].toLowerCase()];
    if (!bang)
        return null;
    const text = match[2].trim();
    return {name: bang[0], text, url: text ? bang[1] + encodeURIComponent(text) : null};
}
