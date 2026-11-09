export const topics = [
  ['pregnancy', 'Беременность', [['health', 'Здоровье и обследования'], ['nutrition', 'Питание и витамины']]],
  ['birth', 'Подготовка к родам', [['preparation', 'Подготовка и настрой'], ['process', 'Схватки, потуги и роддом'], ['special', 'Особые ситуации и вмешательства']]],
  ['cesarean', 'Кесарево сечение', [['preparation', 'Подготовка и операция'], ['recovery', 'Восстановление после КС']]],
  ['feeding', 'Кормление малыша', [['breast', 'Грудное вскармливание'], ['formula', 'Смесь и бутылочка'], ['solids', 'Прикорм'], ['weaning', 'Завершение ГВ']]],
  ['sleep', 'Сон малыша', [['routine', 'Безопасность и режим'], ['settling', 'Засыпание'], ['night', 'Ночной сон']]],
  ['recovery', 'Восстановление после родов', [['body', 'Уход и восстановление тела'], ['wellbeing', 'Эмоции и ресурс мамы']]],
  ['exercise', 'Упражнения', [['pregnancy', 'Йога и фитнес для беременных'], ['recovery', 'Тренировки после родов']]],
  ['baby-care', 'Уход за малышом', [['daily', 'Ежедневный уход'], ['water', 'Купание и плавание'], ['carrying', 'Ношение и слинг']]],
  ['development', 'Развитие малыша', [['early', 'От рождения до 6 месяцев'], ['later', 'От 6 месяцев до года'], ['play', 'Игры и развитие']]],
  ['health', 'Детское здоровье', [['prevention', 'Вакцинация и иммунитет'], ['illness', 'Болезни и самочувствие']]],
  ['first-aid', 'Первая помощь', [['emergency', 'Первая помощь и безопасность']]],
  ['other', 'Материалы школы', [['course', 'Навигация, обратная связь и материалы курса'], ['meetings', 'Записи встреч и ответы на вопросы']]],
].map(([id, title, sections]) => ({ id, title, sections }));

const defaults = new Map([
  [4309095, 'birth/preparation'], [4302509, 'birth/preparation'],
  [4307012, 'baby-care/daily'], [4307003, 'development/early'], [4516222, 'development/later'],
  [4302575, 'development/early'], [4302584, 'development/later'],
  [4316498, 'exercise/pregnancy'], [4302552, 'exercise/pregnancy'], [4302567, 'exercise/pregnancy'],
  [4302557, 'exercise/recovery'], [4302570, 'exercise/recovery'],
  [4516226, 'feeding/weaning'], [4302526, 'feeding/weaning'], [4302546, 'feeding/breast'],
  [4302588, 'feeding/breast'], [4302523, 'feeding/solids'], [4302520, 'sleep/routine'],
  [4302620, 'health/prevention'], [4302598, 'health/illness'], [4302617, 'first-aid/emergency'],
  [4302529, 'recovery/body'], [4302535, 'recovery/wellbeing'], [4302602, 'recovery/body'],
  [4302532, 'baby-care/water'], [4302549, 'baby-care/carrying'],
  [4302543, 'pregnancy/nutrition'], [4302555, 'birth/preparation'],
]);
const normalize = value => value.toLowerCase().replaceAll('ё', 'е');
const parentRules = [
  [/завершение гв|отлучение от груди/, 'feeding/weaning'],
  [/прикорм/, 'feeding/solids'],
  [/грудное вскармливание|правила прикладывания|питание во время гв/, 'feeding/breast'],
  [/подготовка к кс|кесарево сечение/, 'cesarean/preparation'],
  [/спокойная ночь/, 'sleep/night'],
  [/легкое засыпание/, 'sleep/settling'],
  [/сон ребенка|безопасность и режим|психологические аспекты/, 'sleep/routine'],
  [/первая помощь/, 'first-aid/emergency'],
  [/вакцинаци|иммунитет/, 'health/prevention'],
  [/орви/, 'health/illness'],
  [/грудничковое плавание/, 'baby-care/water'],
  [/слингоношение/, 'baby-care/carrying'],
  [/уход за (младенцем|ребенком)/, 'baby-care/daily'],
  [/мама в ресурсе/, 'recovery/wellbeing'],
  [/восстановление после родов|массаж лица/, 'recovery/body'],
  [/йога после родов|плоский живот/, 'exercise/recovery'],
  [/йога для беременных|фитнес/, 'exercise/pregnancy'],
  [/питание.*беременн|питание.*анеми/, 'pregnancy/nutrition'],
  [/6 до 12|6 месяцев до 1 года|6 до 9|9 месяцев/, 'development/later'],
  [/0 до 6|новорожденные до 3|с 3 до 6/, 'development/early'],
  [/спокойная беременность|^беременность$/, 'pregnancy/health'],
  [/вмешательства|роды с особыми/, 'birth/special'],
  [/^введение$|^заключение$|раздел обратной связи|отзыв о родах/, 'other/course'],
];
const lessonRules = [
  [/навига(тор|ция)|организационные моменты|отложить\/активировать|вступайте в чат|отзыв (о курсе|о родах)|раздел по вопросам/, 'other/course'],
  [/прикорм/, 'feeding/solids'],
  [/отлучени|самоотлучен|завершение гв/, 'feeding/weaning'],
  [/искусственн.*вскармл|смешанн.*вскармл|смес[ьи]|из бутылк|\bив\b|на ив|сторона ив/, 'feeding/formula'],
  [/грудн.*вскармл|прикладыван|кормлени|сцеживан|лактостаз|мастит|молок[аоуе]|\sгв(?:\s|$)|у груди|к груди/, 'feeding/breast'],
  [/ночн.*пробужден|ночной сон/, 'sleep/night'],
  [/укладыва|засыпан|ассоциаци.*сон|окно в сон/, 'sleep/settling'],
  [/детский сон|сон (малыша|ребенка)|здоровый сон|условия сна|режим сна|безопасн.*сон/, 'sleep/routine'],
  [/кесарев|после кс|рубц[ае] после/, 'cesarean/preparation'],
  [/первая помощь|аптечк|подавилс/, 'first-aid/emergency'],
  [/вакцинац|детский иммунитет/, 'health/prevention'],
  [/орви|колики|газики/, 'health/illness'],
  [/купани|плавани/, 'baby-care/water'],
  [/как одеть ребенка|летние прогулки|уход с первого месяца|покупки для ребенка/, 'baby-care/daily'],
  [/малыш[еау]? 0[–-]5|развитие ребенка от 0 до 3/, 'development/early'],
  [/малыш[еау]? 6[–-]12/, 'development/later'],
  [/дерматит|жкт у детей|кишечные инфекции|беспокойства ребенка первых месяцев|витамин д/, 'health/illness'],
  [/слингоношение/, 'baby-care/carrying'],
  [/развивающ.*игр/, 'development/play'],
  [/фитнес|спорт во время беременности|йога для беременных/, 'exercise/pregnancy'],
  [/йога после родов|плоский живот/, 'exercise/recovery'],
  [/анеми|гсд|питание во время беременности|витамин/, 'pregnancy/nutrition'],
  [/контрацепци|восстановлен.*после родов|послеродов/, 'recovery/body'],
  [/выгорание|материнской вины/, 'recovery/wellbeing'],
  [/уход за (собой и ребенком|ребенком|младенцем|новорожденным)|пеленани|подгузник/, 'baby-care/daily'],
  [/схватк|потуг|роддом|воды отошли|как организм готовится к родам|дыхание в родах|партнерские роды|движение и позы в родах|гормоны в родах/, 'birth/process'],
  [/медицинск.*стимуляци|неожиданные состояния в родах|решения в родах/, 'birth/special'],
  [/триместр|скрининг|плацент|шевелени.*утроб/, 'pregnancy/health'],
  [/запись встречи/, 'other/meetings'],
];
const find = (rules, text) => rules.find(([pattern]) => pattern.test(text))?.[1];

function classify(title, parents, productId) {
  const name = normalize(title);
  const ancestry = parents.map(normalize);
  const parent = ancestry.map(value => find(parentRules, value)).find(Boolean);
  const fallback = defaults.get(productId);
  if (/после (кесарев|кс)|восстановлен.*(?:кесарев|кс)/.test(name) && !/кормлен|вскармл|гв/.test(name)) return 'cesarean/recovery';
  if (parent?.startsWith('sleep/') && /ночн.*пробужден|кормлен.*на сон/.test(name)) return 'sleep/night';
  const direct = find(lessonRules, name);
  if (direct?.startsWith('feeding/') && direct === 'feeding/breast' && [parent, fallback].includes('feeding/weaning')) return 'feeding/weaning';
  if (direct) return direct;
  if (fallback && fallback !== 'birth/preparation' && (!parent || parent === 'other/course')) return fallback;
  return parent ?? fallback ?? 'other/course';
}

export function groupTopicLessons(courses) {
  const groups = new Map();
  const seen = new Set();
  for (const course of courses) {
    const paths = new Map();
    for (const section of course.sections) {
      const parents = paths.get(String(section.parentStreamId)) ?? [];
      const path = String(section.streamId) === String(course.rootStreamId) ? [] : [section.title, ...parents];
      paths.set(String(section.streamId), path);
      for (const lesson of section.lessons) {
        if (seen.has(String(lesson.lessonId))) continue;
        seen.add(String(lesson.lessonId));
        const key = classify(lesson.title, path, Number(course.productId));
        const keys = [key];
        const title = normalize(lesson.title);
        if (key === 'sleep/night' && /кормлен.*на сон/.test(title)) keys.push('feeding/weaning');
        if (key === 'feeding/weaning' && /ночн.*кормлен/.test(title)) keys.push('sleep/night');
        for (const target of keys) {
          if (!groups.has(target)) groups.set(target, []);
          groups.get(target).push({ ...lesson, productId: course.productId, sectionId: section.streamId });
        }
      }
    }
  }
  return groups;
}
