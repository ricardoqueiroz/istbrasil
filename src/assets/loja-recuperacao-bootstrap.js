/* Executado antes do Angular e de recursos externos. Segredo somente em memoria. */
(function (w, d) {
    'use strict';
    var confirmar = /^\/loja\/(recuperar|biblioteca\/confirmar)\/?$/.test(w.location.pathname);
    if (confirmar) {
        var fragmento = w.location.hash;
        try { w.history.replaceState(null, '', w.location.pathname); }
        catch (_) { w.location.replace(w.location.pathname); return; }
        var p = new URLSearchParams(fragmento.slice(1));
        var id = p.get('id'), segredo = p.get('segredo');
        var valido = Array.from(p.keys()).length === 2 && p.getAll('id').length === 1 && p.getAll('segredo').length === 1
            && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '')
            && /^[A-Za-z0-9_-]{43}$/.test(segredo || '');
        var desafio = valido ? { publicId: id, segredo: segredo } : null;
        Object.defineProperty(w, '__istRetirarDesafio', { configurable: true, value: function () {
            var r = desafio; desafio = null; delete w.__istRetirarDesafio; return r;
        }});
        var referrer = d.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer'; d.head.appendChild(referrer);
        var cache = d.createElement('meta'); cache.httpEquiv = 'Cache-Control'; cache.content = 'no-store'; d.head.appendChild(cache);
    } else {
        var fonte = d.createElement('link'); fonte.rel = 'stylesheet'; fonte.href = 'https://fonts.cdnfonts.com/css/lato'; d.head.appendChild(fonte);
    }
})(window, document);
