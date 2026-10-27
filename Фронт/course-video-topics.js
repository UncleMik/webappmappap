// Topic captions come from the source lesson, never from generated video numbers.
const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const serviceLabel = value => /^(?:плеер|видео|youtube|rutube)(?:\s|[№#\d:]|$)/i.test(value);

export function courseVideoTopic(blocks, blockIndex, lessonTitle) {
  const caption = clean(blocks[blockIndex]?.text);
  if (caption && !serviceLabel(caption)) return caption;
  // Source subtitles are separate text blocks immediately before their video.
  // Do not borrow a title across a previous video, attachment or chapter table.
  for (let index = blockIndex - 1; index >= 0; --index) {
    const block = blocks[index];
    if (block?.type !== 'text') break;
    const text = clean(block.text);
    if (!text) continue;
    if (text.length <= 200 && !serviceLabel(text) && !/\n\s*\n/.test(block.text)) return text;
    break;
  }
  return clean(lessonTitle);
}
