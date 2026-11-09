const icons = {
  book: 'M12 7c-3-3-6-3-9-2v14c3-1 6-1 9 2 3-3 6-3 9-2V5c-3-1-6-1-9 2v14',
  pregnancy: 'M12 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM7 22v-8c0-3 2-5 5-5h1c1 3 5 4 5 8a4 4 0 0 1-4 4h-4',
  birth: 'M12 21S3 16 3 9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 7-9 12-9 12Z',
  sleep: 'M20 16A9 9 0 0 1 8 4a9 9 0 1 0 12 12ZM16 4v5m-2.5-2.5h5',
  night: 'M12 3v5M9.5 5.5h5M4 19h16M6 16l2-5 4 3 4-3 2 5H6Z',
  health: 'M3 12h5l3-6 3 12 3-6h4M4 4h16v16H4z',
  firstAid: 'M8 7V5h8v2M3 8h18v12H3zM12 11v6m-3-3h6',
  scan: 'M3 5h18v12H3zM8 21h8m-4-4v4M7 12q3-6 5 0t5 0',
  recovery: 'M12 21V11M12 16Q3 16 3 8q8 0 9 8Zm0-3q0-9 9-9 0 8-9 9Z',
  cesarean: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-3 9 2 2 4-4',
  exercise: 'M7 6v12M4 9v6m13-9v12m3-9v6M7 12h10',
  breath: 'M3 8h11a2 2 0 1 0-2-2M3 12h16a2 2 0 1 1-2 2M3 16h8a2 2 0 1 1-2 2',
  feeding: 'M13 4C11 8 7 12 7 16a5 5 0 0 0 10 0c0-4-2-8-4-12Zm-3 12c0 1 .5 2 1.5 2.5',
  bottle: 'M9 8h6v3l2 3v6H7v-6l2-3V8Zm1 0V5l2-2 2 2v3m-7 8h4',
  food: 'M3 12h18a9 9 0 0 1-18 0ZM15 12l5-8M8 21h8',
  baby: 'M12 7a6 6 0 0 1 0 12 6 6 0 0 1 0-12Zm0 0c-1-2 0-4 2-4M9 13h.01m6 0h.01m-5 3q2 2 4 0',
  bath: 'M3 13h18v3a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-3Zm3 0V6a3 3 0 0 1 6 0M7 20v1m10-1v1',
  play: 'M4 13h7v7H4zM13 13h7v7h-7zM12 3l4 7H8z',
  chat: 'M4 5h16v11H10l-5 4v-4H4zM8 10h8m-8 3h5',
  video: 'M3 5h18v14H3zM10 9l5 3-5 3z',
  calendar: 'M4 6h16v14H4zM8 4v4m8-4v4M4 10h16m-12 4h2m4 0h2m-8 3h2',
  hands: 'M3 11l4 4 4-4c1-1 2-1 3 0l2 2m5-2-5 5-3 3-3-1-3-2m-4-5 3-5 4 1 2-1h6l3 5',
  vaccine: 'M15 4l5 5m-7-3 5 5M7 17l-3 3m2-5 3 3 8-8-3-3-8 8Zm4-3 2 2',
};

const themes = {
  pregnancy: 'pregnancy', birth: 'birth', cesarean: 'cesarean', feeding: 'feeding', sleep: 'sleep',
  recovery: 'recovery', exercise: 'exercise', 'baby-care': 'baby', development: 'play',
  health: 'health', 'first-aid': 'firstAid', other: 'chat',
};

const subthemes = {
  'pregnancy/trimesters': 'calendar', 'pregnancy/screening': 'scan', 'pregnancy/health': 'health',
  'pregnancy/nutrition': 'food', 'pregnancy/emotions': 'birth', 'pregnancy/movement': 'breath',
  'birth/practice': 'breath', 'birth/special': 'firstAid', 'birth/preparation': 'book',
  'cesarean/recovery': 'recovery', 'cesarean/feeding': 'feeding', 'feeding/formula': 'bottle',
  'feeding/solids': 'food', 'feeding/weaning': 'hands', 'sleep/routine': 'calendar', 'sleep/night': 'night',
  'recovery/wellbeing': 'birth', 'recovery/training': 'exercise', 'baby-care/water': 'bath',
  'baby-care/carrying': 'hands', 'development/early': 'baby', 'development/later': 'recovery',
  'health/prevention': 'vaccine', 'other/course': 'book', 'other/meetings': 'video',
};

const titleMotifs = [
  [/^введение|навигатор|инструкци/, 'book'],
  [/обратная связь|вопросы|чат|тревог|психолог/, 'chat'],
  [/запис[ьи] встреч|онлайн.встреч|^20\d{2}$/, 'video'],
  [/узи|скрининг|обследован/, 'scan'],
  [/вакцин|прививк/, 'vaccine'],
  [/первая помощь|аптечк|реанимац/, 'firstAid'],
  [/купани|плавани/, 'bath'],
  [/бутылоч|смесь|смеси/, 'bottle'],
  [/прикорм|питани|витамин/, 'food'],
  [/дыхани|расслаблен/, 'breath'],
  [/массаж|слинг|партнер/, 'hands'],
  [/фитнес|упражнени|тренировк|йога/, 'exercise'],
  [/кесарев|(?:^|[^а-я])кс(?:$|[^а-я])|операци/, 'cesarean'],
  [/восстановлен/, 'recovery'],
  [/ночн|ночь/, 'night'],
  [/сон|засыпан/, 'sleep'],
  [/триместр|беременн/, 'pregnancy'],
  [/вскармливан|кормлен|лактац/, 'feeding'],
  [/схватк|потуг|роддом/, 'birth'],
  [/новорожден|младен|пеленан/, 'baby'],
  [/игр[аы]|развити/, 'play'],
];

const svgNS = 'http://www.w3.org/2000/svg';
function shape(tag, attributes) {
  const element = document.createElementNS(svgNS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

export function topicIllustration(theme, title, position) {
  const normalizedTitle = title.toLowerCase().replaceAll('ё', 'е');
  const motif = titleMotifs.find(([pattern]) => pattern.test(normalizedTitle))?.[1]
    ?? subthemes[theme] ?? themes[theme.split('/')[0]] ?? 'book';
  const hue = (252 + position * 137.508) % 360;
  const tint = (saturation, lightness) => `hsl(${hue} ${saturation}% ${lightness}%)`;
  const cover = document.createElement('span');
  cover.className = 'course-cover course-topic-illustration';
  cover.setAttribute('aria-hidden', 'true');
  cover.style.background = tint(65, 93);
  const svg = shape('svg', { viewBox: '0 0 72 62', focusable: 'false' });
  const left = position % 2 === 0;
  svg.append(
    shape('circle', { cx: left ? 59 : 13, cy: position % 3 === 0 ? 10 : 51, r: 23, fill: tint(62, 86) }),
    shape('circle', { cx: 36, cy: 31, r: 21, fill: tint(69, 97) }),
    shape('path', { d: icons[motif], transform: 'translate(21 16) scale(1.25)', fill: 'none',
      stroke: tint(55, 34), 'stroke-width': 1.65, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  );
  cover.append(svg);
  return cover;
}

