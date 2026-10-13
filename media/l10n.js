// @ts-check
// Translations for the webviews: the extension injects the active language's bundle as JSON
// (English needs none); `t('Text {0}', value)` returns the translation with its placeholders filled.
(function () {
  let bundle = {};
  try {
    const data = document.getElementById('dbclient-l10n');
    bundle = data ? JSON.parse(data.textContent || '{}') : {};
  } catch {
    bundle = {};
  }
  /** @param {string} text @param {...unknown} args */
  window.t = function (text, ...args) {
    const message = typeof bundle[text] === 'string' ? bundle[text] : text;
    return message.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
  };
})();
