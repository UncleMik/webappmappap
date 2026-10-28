// Build previews only from the lesson that has passed the server's access checks.
// No separate public catalogue of paid lesson texts or media addresses is created.
const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const service = value => /^(?:плеер|видео\s*[№#\d]|youtube|rutube|скачать|материалы|задание|здравствуйте|добрый день|можете выбрать наиболее|для вашего удобства)/i.test(value);
const sentence = value => /[.!?…]$/.test(value) ? value : `${value}.`;
const useful = value => value.length >= 45 && !service(value) && !/https?:\/\/|@|\b\d{1,2}:\d{2}\b/.test(value);

function excerpt(block) {
  if (!block || !['text', 'list'].includes(block.type)) return '';
  const lines = (block.text || '').split(/\n+/).map(clean).filter(Boolean)
    .filter(line => !/^(?:здравствуйте|добрый день)[!.,\s]*$/i.test(line));
  if (!lines.length || service(lines[0])) return '';
  // A source learning-objective list is a more faithful preview than a cut-off
  // instruction. Preserve complete list items and leave the full text below.
  if (/на (?:этом )?уроке.*(?:узнаете|разбер|поговор|рассмотр)/i.test(lines[0]) && lines.length > 1) {
    const topics = [];
    for (const line of lines.slice(1).filter(useful)) {
      if (topics.join('; ').length + line.length > 360) break;
      topics.push(line);
      if (topics.length === 3) break;
    }
    if (topics.length) return sentence(`В уроке разбираются вопросы: ${topics.map(x => x.replace(/[;.!?]+$/, '')).join('; ')}`);
  }
  const text = clean(lines.join(' '));
  if (!useful(text)) return '';
  // Only introductory descriptions may be shortened. Explanations, exercise
  // instructions and medical assertions stay in the complete source text.
  if (!/^(?:на (?:этом )?уроке|в (?:этом )?(?:уроке|видео)|на (?:этом )?занятии|практика посвящена)/i.test(text)) return '';
  // Never manufacture the end of a sentence or abbreviate a safety condition.
  const segments = text.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g) || [];
  const selected = [];
  for (const segment of segments) {
    const part = clean(segment);
    if (part.length < 25) continue;
    if (part.length > 420 || selected.join(' ').length + part.length > 550) break;
    selected.push(sentence(part));
    if (selected.length === 2) break;
  }
  // Do not lift instructions or promised health effects out of their context.
  if (selected.some(x => /(?:нельзя|не стоит|запрещ|противопоказ|помога|способству|снижа|снять|сняти|нормализ|укреплен|рекоменд|возьмите|сделайте|предлагаю вам)/i.test(x))) return '';
  return selected.join(' ');
}

export function courseVideoDescription({ blocks, blockIndex, title, lessonTitle, chapters = [] }) {
  const topic = clean(title) || clean(lessonTitle);
  const opening = sentence(`Тема видео — «${topic}»`);
  const labels = [];
  for (const label of new Set(chapters.map(x => clean(x.label)).filter(x => x && x !== topic))) {
    if (labels.join('; ').length + label.length > 300) break;
    labels.push(label);
    if (labels.length === 3) break;
  }
  if (labels.length) return `${opening} ${sentence(`В записи разбираются: ${labels.join('; ')}`)}`;

  // Local prose must stop at another video; never borrow its description.
  const local = [];
  for (let i = blockIndex + 1; i < blocks.length && blocks[i]?.type !== 'video'; ++i) {
    const block = blocks[i];
    if (!['text', 'list'].includes(block?.type)) break;
    if (clean(block.text).length < 45) break;
    local.push(block);
  }
  for (let i = blockIndex - 1; i >= 0 && blocks[i]?.type !== 'video'; --i) {
    const block = blocks[i];
    if (!['text', 'list'].includes(block?.type)) break;
    local.push(block);
  }
  for (const block of local) {
    const text = excerpt(block);
    if (text) return `${opening} ${text}`;
  }
  // For recordings without a source description, state only the known topic.
  // Do not invent exercises, outcomes, medical advice or a transcript.
  const lesson = clean(lessonTitle);
  return `${opening} ${topic !== lesson ? sentence(`Видео входит в урок «${lesson}»`) : 'Подробный разбор темы представлен в записи урока.'}`;
}
