/** Copies through a hidden textarea, which works on mobile Safari where the clipboard API may not. */
export function copyText(text: string): boolean {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '-9999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
    return true;
  } catch (err) {
    console.error('Failed to copy:', err);
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}
