// Shared message formatter. Messages are either strings with {placeholders} or plural
// objects keyed by Intl.PluralRules categories (zero/one/two/few/many/other).
(function factory(root) {
  function createTranslator(locale) {
    const messages = locale?.messages || {};
    const fallback = locale?.fallback || {};
    const rules = new Intl.PluralRules(locale?.locale || 'en');
    const numbers = new Intl.NumberFormat(locale?.locale || 'en', { numberingSystem: 'latn' });

    function pick(entry, params) {
      if (entry && typeof entry === 'object') {
        const count = Number(params?.count ?? 0);
        const category = count === 0 && entry.zero ? 'zero' : rules.select(count);
        return entry[category] ?? entry.other ?? '';
      }
      return entry;
    }

    return function t(key, params = {}) {
      const entry = messages[key] ?? fallback[key];
      if (entry === undefined) return key;
      return String(pick(entry, params)).replace(/\{(\w+)\}/g, (match, name) => {
        if (params[name] === undefined) return match;
        return typeof params[name] === 'number' ? numbers.format(params[name]) : String(params[name]);
      });
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createTranslator };
  else root.WaselI18n = Object.freeze({ createTranslator });
})(typeof window === 'undefined' ? globalThis : window);
