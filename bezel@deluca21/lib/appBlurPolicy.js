// App IDs and WM_CLASS names use case-insensitive glob matching, not regexes.
export function appPatterns(values) {
    return values.map(value => value.trim()).filter(Boolean).map(value => new RegExp(`^${value
        .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'));
}
export function appAllowed(ids, policy, whitelist, blacklist) {
    const matches = patterns => patterns.some(pattern => ids.some(id => id && pattern.test(id)));
    return policy === 'blacklist' ? !matches(blacklist) : matches(whitelist);
}
