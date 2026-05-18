export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString();
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

const URL_REGEX = /(https?:\/\/[^\s<>"')\]，。、！？；：""''（）【】《》]+)/gi;

export function linkify(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(URL_REGEX, (url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    const displayUrl = url.length > 60 ? url.slice(0, 57) + '...' : url;
    return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="message-link">${displayUrl}</a>`;
  });
}
