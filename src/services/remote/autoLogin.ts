/**
 * Remplissage automatique du formulaire de connexion d'un service distant
 * (v2.9.0 — onglet Services).
 *
 * ⚠️ RÈGLE DE SURVIE HERMES BRIDGE : ce module produit une CHAÎNE de
 * JavaScript injectée dans la WebView (`injectedJavaScript`) — jamais une
 * fonction JS passée à un appel natif. La WebView exécute elle-même ce
 * script côté page : aucun aller-retour de callback vers le natif.
 *
 * Le script tourne à chaque chargement de page (injectedJavaScript),
 * cherche jusqu'à 24 fois (500 ms) un champ identifiant + mot de passe,
 * remplit via le setter natif HTMLInputElement + événements `input` /
 * `change` (compatibilité React/Vue), puis — si autoSubmit — clique le
 * bouton submit du formulaire après 900 ms.
 */

export const AUTO_LOGIN_MAX_TRIES = 24;
export const AUTO_LOGIN_RETRY_MS = 500;
export const AUTO_LOGIN_SUBMIT_DELAY_MS = 900;

/** Litère JSON : JSON.stringify échappe guillemets, backslashes et retours ligne. */
function jsLiteral(value: string): string {
  return JSON.stringify(value);
}

export function buildAutoLoginScript(user: string, pass: string, autoSubmit: boolean): string {
  const u = jsLiteral(user);
  const p = jsLiteral(pass);
  const submitPart = autoSubmit
    ? `setTimeout(function(){
        var form = pp.closest('form') || pu.closest('form');
        var btn = form && (form.querySelector('button[type=submit]') || form.querySelector('input[type=submit]') || form.querySelector('button'));
        if (btn) { btn.click(); }
      }, ${AUTO_LOGIN_SUBMIT_DELAY_MS});`
    : '';
  return `(function(){
  var tries = 0;
  function filled(el, v){
    var proto = (el.tagName === 'TEXTAREA') ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var set = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (set) { set.call(el, v); } else { el.value = v; }
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function findUser(){
    var sels = [
      'input[type=email]',
      'input[type=text][name*=user i]',
      'input[type=text][name*=login i]',
      'input[type=text][name*=email i]',
      'input[type=text][id*=user i]',
      'input[type=text][id*=login i]',
      'input[type=text][id*=email i]',
      'input:not([type])[name*=user i]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) { return el; }
    }
    return null;
  }
  function tryFill(){
    var pu = findUser();
    var pp = document.querySelector('input[type=password]');
    if (pu && pp) {
      filled(pu, ${u});
      filled(pp, ${p});
      ${submitPart}
      return true;
    }
    if (++tries < ${AUTO_LOGIN_MAX_TRIES}) { setTimeout(tryFill, ${AUTO_LOGIN_RETRY_MS}); }
    return false;
  }
  tryFill();
})();`;
}
