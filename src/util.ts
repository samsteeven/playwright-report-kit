/** Retire les séquences de couleur ANSI que Playwright met dans les messages d'erreur. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Échappe un texte pour du XML 1.0 et retire les caractères de contrôle interdits (XML refuse un document qui en contient). */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `1234` donne `1,2 s` ; `125000` donne `2 min 05 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} min ${String(rest).padStart(2, '0')} s`;
}

/** Coupe un texte à `max` caractères, en ajoutant « … » si quelque chose a été retiré. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Transforme un chemin Windows en chemin à barres obliques, pour des noms stables d'une machine à l'autre. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}
