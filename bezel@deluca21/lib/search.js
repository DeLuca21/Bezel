const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const compareNames = new Intl.Collator(undefined, {sensitivity: 'base'}).compare;

// Only one typo is accepted. Avoid allocating a quadratic edit-distance table
// for every candidate, especially when a long query is pasted into the launcher.
function withinOneEdit(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i === Math.min(a.length, b.length)) return true;
    if (a.length > b.length) return a.slice(i + 1) === b.slice(i);
    if (b.length > a.length) return a.slice(i) === b.slice(i + 1);
    return a.slice(i + 1) === b.slice(i + 1)
        || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
}

function wordScore(word, text) {
    if (word === text) return 0;
    if (text.startsWith(word)) return 2;
    const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (parts.join('') === word) return 1;
    const prefix = parts.findIndex(part => part.startsWith(word));
    if (prefix >= 0) return 5 + Math.min(prefix, 6);
    if (word.length > 1 && parts.map(part => part[0]).join('').startsWith(word)) return 8;
    const at = text.indexOf(word);
    if (at >= 0) return 12 + Math.min(at, 20);
    let best = Infinity;
    if (word.length >= 3) {
        for (const [position, part] of parts.entries()) {
            let cursor = 0, first = -1, last = -1;
            for (let i = 0; i < part.length && cursor < word.length; i++) {
                if (part[i] === word[cursor]) { if (first < 0) first = i; last = i; cursor++; }
            }
            if (cursor === word.length && last - first <= word.length * 4)
                best = Math.min(best, 35 + last - first - word.length + Math.min(position * 3, 12) + Math.min(first, 8));
        }
    }
    if (word.length >= 4) for (const [position, part] of parts.entries()) {
        if (Math.abs(part.length - word.length) <= 1 && withinOneEdit(word, part))
            best = Math.min(best, 45 + Math.min(position * 3, 12));
    }
    return best;
}

function queryMatcher(query) {
    const normalized = normalize(query).trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    return value => {
        const text = normalize(value);
        if (normalized === text) return 0;
        let sum = 0;
        for (const word of words) {
            sum += wordScore(word, text);
            if (!Number.isFinite(sum)) break;
        }
        return sum;
    };
}

export function matchScore(query, value) {
    return queryMatcher(query)(value);
}

export function createSearchScorer(query) {
    const match = queryMatcher(query);
    return item => {
        const name = match(item.name);
        // Keyword results have a minimum score of 60 and cannot beat a name hit.
        return name < 60 ? name : Math.min(name, 60 + match(`${item.name} ${item.keywords ?? ''}`));
    };
}

export function scoreItem(query, item) {
    return createSearchScorer(query)(item);
}

export function filterMatches(query, items) {
    const score = createSearchScorer(query);
    return items.map(item => ({...item, score: score(item)}))
        .filter(item => Number.isFinite(item.score))
        .sort(compareSearchResults);
}

// Keep literal file hits useful, but prefer an equally good app name over a folder.
export function compareSearchResults(a, b) {
    const priority = item => item.file ? 6 : item.window ? 2 : 0;
    return (a.score ?? -100) + priority(a) - ((b.score ?? -100) + priority(b))
        || Number(Boolean(a.file)) - Number(Boolean(b.file))
        || compareNames(a.name, b.name)
        || String(a.detail ?? '').localeCompare(String(b.detail ?? ''));
}

export function parseLauncherQuery(value) {
    const query = value.trim();
    const first = query[0];
    if (['>', '$', '?'].includes(first)) return {mode: first, text: query.slice(1).trim()};
    if (first === '/') {
        // /name and / name are filters. A second slash makes a path explicit:
        // /home/user/name, /tmp/, or //etc for an item directly under root.
        const filter = /^\/\s/.test(value.trimStart()) || !query.slice(1).includes('/');
        return {mode: '/', text: filter ? query.slice(1).trim() : query.replace(/^\/\//, '/')};
    }
    return {mode: first === '~' ? '/' : '', text: query};
}

export function websiteUrl(query) {
    const value = query.trim();
    if (/\s/.test(value)) return null;
    if (/^https?:\/\/[^/]+/i.test(value)) return value;
    if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:[/?#].*)?$/i.test(value)) return `http://${value}`;
    if (/^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|edu|gov|co|au|uk|de|me|ai)(?::\d+)?(?:[/?#].*)?$/i.test(value)) return `https://${value}`;
    return null;
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
