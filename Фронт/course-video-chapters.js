// Chapters come only from the source lesson's two-column timestamp tables.
const timestamp = value => {
  const match = value.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;
  if (match[1] !== undefined && Number(match[2]) > 59) return null;
  return (match[1] === undefined ? 0 : Number(match[1]) * 3600)
    + Number(match[2]) * 60 + Number(match[3]);
};

function tableChapters(html) {
  if (typeof html !== 'string' || !html) return null;
  const template = document.createElement('template');
  template.innerHTML = html;
  const tables = template.content.querySelectorAll('table');
  if (tables.length !== 1) return null;
  const chapters = [];
  for (const row of tables[0].querySelectorAll('tr')) {
    const cells = [...row.children];
    if (cells.some(cell => cell.localName === 'th')) continue;
    if (cells.length !== 2 || cells.some(cell => cell.localName !== 'td')) return null;
    const first = cells[0].textContent.trim().replace(/\s+/g, ' ');
    const second = cells[1].textContent.trim().replace(/\s+/g, ' ');
    if (!first && !second) continue;
    const firstTime = timestamp(first), secondTime = timestamp(second);
    if ((firstTime === null) === (secondTime === null)) return null;
    const label = firstTime === null ? first : second;
    if (!label) return null;
    chapters.push({ seconds: firstTime ?? secondTime, label });
  }
  return chapters.length ? chapters : null;
}

export function courseChapters(blocks) {
  const byVideo = new Map(), tableIndexes = new Set();
  let currentVideo = null;
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'video') {
      currentVideo = Array.isArray(block.videos) && block.videos.length === 1
        && block.videos[0]?.provider === 'getcourse' && typeof block.videos[0].url === 'string'
        ? index : null;
      continue;
    }
    if (block.type === 'text' && /видео.{0,60}(?:удален[оа]?|недоступно|загрузите видео)/i.test(block.text || '')) {
      currentVideo = null;
      continue;
    }
    if (block.type !== 'table' || currentVideo === null) continue;
    const chapters = tableChapters(block.html);
    if (chapters) {
      byVideo.set(currentVideo, [...(byVideo.get(currentVideo) || []), ...chapters]);
      tableIndexes.add(index);
    }
  }
  return { byVideo, tableIndexes };
}
