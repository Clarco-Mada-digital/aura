'use strict';
// Fenêtre de diagnostic. Elle n'a qu'un travail : montrer, en grand et en
// entier, ce qu'il faut pour comprendre pourquoi une application ne s'ouvre
// pas — et permettre de l'emporter d'un clic.

const $ = (id) => document.getElementById(id);

async function charger() {
  $('btnRefresh').disabled = true;
  try {
    $('rapport').textContent = await window.aura.diagnosticText();
  } catch (err) {
    $('rapport').textContent = `L'analyse a échoué : ${err.message || err}`;
  }
  try {
    const journal = await window.aura.logTail();
    $('journal').textContent = journal && journal.trim() ? journal : 'Le journal est vide.';
  } catch (err) {
    $('journal').textContent = String(err.message || err);
  }
  $('btnRefresh').disabled = false;
}

$('btnRefresh').onclick = charger;

$('btnLog').onclick = () => window.aura.openLog();

$('btnCopy').onclick = async () => {
  const texte = [$('rapport').textContent, '', '--- journal ---', $('journal').textContent].join('\n');
  await navigator.clipboard.writeText(texte);
  $('btnCopy').textContent = 'Copié';
  setTimeout(() => { $('btnCopy').textContent = 'Copier le rapport'; }, 1600);
};

charger();
