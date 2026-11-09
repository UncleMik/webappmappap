import { reviewedDestinations, reviewedCrossLinks } from './course-topic-editorial.js?v=20261109';

export const topics = [
  ['pregnancy', 'Беременность', [
    ['trimesters', 'Триместры'], ['screening', 'УЗИ, анализы и обследования'],
    ['health', 'Самочувствие и здоровье'], ['nutrition', 'Питание и витамины'],
    ['emotions', 'Эмоции и тревога'], ['movement', 'Движение и расслабление'],
  ]],
  ['birth', 'Подготовка к родам', [
    ['preparation', 'Подготовка и настрой'], ['process', 'Схватки, потуги и роддом'],
    ['practice', 'Дыхание, позы и массаж'], ['special', 'Особые ситуации и вмешательства'],
  ]],
  ['cesarean', 'Кесарево сечение', [
    ['preparation', 'Подготовка и операция'], ['recovery', 'Восстановление после КС'],
    ['feeding', 'Кормление после КС'],
  ]],
  ['feeding', 'Кормление малыша', [['breast', 'Грудное вскармливание'], ['formula', 'Смесь и бутылочка'], ['solids', 'Прикорм'], ['weaning', 'Завершение ГВ']]],
  ['sleep', 'Сон малыша', [['routine', 'Безопасность и режим'], ['settling', 'Засыпание'], ['night', 'Ночной сон']]],
  ['recovery', 'Восстановление после родов', [
    ['body', 'Уход и восстановление тела'], ['wellbeing', 'Эмоции и ресурс мамы'],
    ['training', 'Упражнения после родов'],
  ]],
  ['exercise', 'Упражнения во время беременности', [['pregnancy', 'Упражнения во время беременности'], ['recovery', 'Тренировки после родов']]],
  ['baby-care', 'Уход за малышом', [
    ['newborn', 'Первые дни с малышом'], ['daily', 'Ежедневный уход'],
    ['water', 'Купание и плавание'], ['carrying', 'Ношение и слинг'],
  ]],
  ['development', 'Развитие малыша', [['early', 'От рождения до 6 месяцев'], ['later', 'От 6 месяцев до года'], ['play', 'Игры и развитие']]],
  ['health', 'ОРВИ и детская вакцинация', [
    ['respiratory', 'ОРВИ, насморк и кашель'], ['prevention', 'Вакцинация и иммунитет'],
    ['illness', 'Другие вопросы о здоровье'],
  ]],
  ['first-aid', 'Первая помощь', [['emergency', 'Первая помощь и безопасность']]],
  ['other', 'Онлайн-встречи и ответы на вопросы', [['course', 'Навигация, обратная связь и материалы курса'], ['meetings', 'Записи встреч и ответы на вопросы']]],
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
// Reviewed exceptions from the school catalog. Keep original lesson links and access checks.
const reviewedLessons = new Map(Object.entries({
  'sleep/routine': [347472706],
  'sleep/settling': [347472501, 347472730, 349405902],
  'feeding/formula': [347472428, 347472442],
  'feeding/weaning': [347472512, 347472672, 347472834],
  'feeding/breast': [350366414, 350366415, 350366416, 350366417, 350366419, 350366420,
    347472522, 347472523, 347472524, 347472525, 347472527, 347472528, 347472756],
  'baby-care/daily': [350366418, 347472526, 347472815],
  'development/early': [347472745],
  'development/later': [347472499],
  'development/play': [347529609],
  'health/illness': [347472438, 347472443, 347472444, 347472446, 347472448, 347472449,
    347472451, 347472740, 347472770],
  'first-aid/emergency': [347472753, 347472784],
  'exercise/pregnancy': [347472655, 347472656, 347472657, 347472659],
  'exercise/recovery': [347529571, 347529572, 347529573, 347529574, 347529575, 347529576,
    347472600, 347472601, 347472602, 347472603, 347472604, 347472605],
  'cesarean/recovery': [347531298, 347531307, 347531309, 347472543, 347472547, 347472548],
  'recovery/wellbeing': [347472626, 347472731, 347472732, 347472739, 347472781, 347927985],
  'birth/preparation': [347472729, 347472735],
  'birth/process': [347472741, 347472758, 347472761, 347472785, 347472810],
  'other/course': [347472352, 347472622, 347472661, 347472674, 347472716],
}).flatMap(([topic, ids]) => ids.map(id => [id, topic])));

// These practices also belong to the pregnancy and birth-preparation sequences.
const additionalPregnancyExercises = new Set([
  347529457, 347529465, 347531402, 347531403, // Express
  347472386, 347472394, 347472707, 347472708, // Full
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
  [/йога для беременных|фитнес|здоровая спина/, 'exercise/pregnancy'],
  [/питание.*беременн|питание.*анеми/, 'pregnancy/nutrition'],
  [/6 до 12|6 месяцев до 1 года|6 до 9|9 месяцев/, 'development/later'],
  [/0 до 6|новорожденные до 3|с 3 до 6/, 'development/early'],
  [/спокойная беременность|^беременность$/, 'pregnancy/health'],
  [/вмешательства|роды с особыми/, 'birth/special'],
  [/^введение$|^заключение$|раздел обратной связи|отзыв о родах/, 'other/course'],
];
const lessonRules = [
  [/навига(тор|ция)|организационные моменты|раздел обратной связи|правила работы раздела|отложить\/активировать|вступайте в чат|отзыв (о курсе|о родах)|раздел по вопросам/, 'other/course'],
  [/прикорм/, 'feeding/solids'],
  [/отлучени|самоотлучен|завершение гв/, 'feeding/weaning'],
  [/искусственн.*вскармл|смешанн.*вскармл|смес[ьи]|из бутылк|\bив\b|на ив|сторона ив/, 'feeding/formula'],
  [/грудн.*вскармл|вопросы грудного вскартмливания|проблемы гв|организовать гв|вид вскармливания|психологический взгляд на вскармливани|прикладыван|кормлени|сцеживан|лактостаз|мастит|молок[аоуе]|\sгв(?:\s|$)|у груди|к груди/, 'feeding/breast'],
  [/ночн.*пробужден|ночной сон/, 'sleep/night'],
  [/укладыва|засыпан|ассоциаци.*сон|окно в сон/, 'sleep/settling'],
  [/детский сон|сон (малыша|ребенка)|здоровый сон|условия сна|режим сна|дневник сна|безопасн.*сон/, 'sleep/routine'],
  [/кесарев|после кс|рубц[ае] после/, 'cesarean/preparation'],
  [/первая помощь|аптечк|подавилс|неотложных состояниях/, 'first-aid/emergency'],
  [/вакцинац|детский иммунитет/, 'health/prevention'],
  [/орви.*беременн/, 'pregnancy/health'],
  [/орви|насморк и кашель/, 'health/respiratory'],
  [/колики|газики/, 'health/illness'],
  [/купани|плавани/, 'baby-care/water'],
  [/как одеть ребенка|летние прогулки|путешестви.*малыш|уход за кожей|особенности развития и ухода|уход с первого месяца|покупки для ребенка/, 'baby-care/daily'],
  [/малыш[еау]? 0[–-]5|развитие ребенка от 0 до 3/, 'development/early'],
  [/малыш[еау]? 6[–-]12/, 'development/later'],
  [/дерматит|жкт у детей|кишечные инфекции|беспокойства ребенка первых месяцев|витамин д/, 'health/illness'],
  [/слингоношение/, 'baby-care/carrying'],
  [/развивающ.*игр/, 'development/play'],
  [/фитнес|спорт во время беременности|йога для беременных/, 'exercise/pregnancy'],
  [/йога после родов|плоский живот/, 'exercise/recovery'],
  [/анеми|гсд|питание во время беременности|витамин/, 'pregnancy/nutrition'],
  [/контрацепци|восстановлен.*после родов|послеродов/, 'recovery/body'],
  [/выгор(ание|еть)|материнской вины|послеродовая депрессия/, 'recovery/wellbeing'],
  [/уход за (собой и ребенком|ребенком|младенцем|новорожденным)|пеленани|подгузник/, 'baby-care/daily'],
  [/схватк|потуг|роддом|воды отошли|как организм готовится к родам|дыхание в родах|партнерские роды|движение и позы в родах|гормоны в родах/, 'birth/process'],
  [/медицинск.*стимуляци|неожиданные состояния в родах|решения в родах/, 'birth/special'],
  [/триместр/, 'pregnancy/trimesters'],
  [/скрининг|узи|анализы во время беременности|мазок.*стрептококк/, 'pregnancy/screening'],
  [/плацент|шевелени.*утроб/, 'pregnancy/health'],
  [/запись встречи/, 'other/meetings'],
];
const find = (rules, text) => rules.find(([pattern]) => pattern.test(text))?.[1];

function classify(title, parents, productId) {
  const normalized = normalize(title);
  // A meeting host can cover several topics. Prefer the subject over their job title.
  const subject = normalized.startsWith('запись встречи')
    ? normalized.match(/(?:на тему|тема:)\s*[«"]?(.+)/)?.[1] : undefined;
  const name = subject ?? normalized;
  const ancestry = parents.map(normalize);
  const parent = ancestry.map(value => find(parentRules, value)).find(Boolean);
  const fallback = defaults.get(productId);
  if (/после (кесарев|кс)|восстановлен.*(?:кесарев|кс)/.test(name) && !/кормлен|вскармл|гв/.test(name)) return 'cesarean/recovery';
  if (parent?.startsWith('sleep/') && /ночн.*пробужден|кормлен.*на сон/.test(name)) return 'sleep/night';
  const direct = find(lessonRules, name);
  if (direct?.startsWith('feeding/') && direct === 'feeding/breast' && [parent, fallback].includes('feeding/weaning')) return 'feeding/weaning';
  if (direct) return direct;
  if (subject) return 'other/meetings';
  if (fallback && fallback !== 'birth/preparation' && (!parent || parent === 'other/course')) return fallback;
  return parent ?? fallback ?? 'other/course';
}

export function courseLessonTopic(lesson, parents, productId) {
  return reviewedLessons.get(Number(lesson.lessonId)) ?? classify(lesson.title, parents, Number(productId));
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
        const id = Number(lesson.lessonId);
        const key = reviewedDestinations.get(id) ?? courseLessonTopic(lesson, path, course.productId);
        const keys = new Set([key, ...(reviewedCrossLinks.get(id) ?? [])]);
        if (additionalPregnancyExercises.has(id)) keys.add('exercise/pregnancy');
        if (keys.has('exercise/pregnancy')) keys.add('pregnancy/movement');
        if (keys.has('exercise/recovery')) keys.add('recovery/training');
        const title = normalize(lesson.title);
        if (id === 347472734) keys.add('sleep/routine');
        if (id === 347472412) keys.add('feeding/formula');
        if (key === 'sleep/night' && /кормлен.*на сон/.test(title)) keys.add('feeding/weaning');
        if (key === 'feeding/weaning' && /ночн.*кормлен/.test(title)) keys.add('sleep/night');
        if (/^(?:запись\s+)?(?:встреч[аи]|вебинар)(?:\s|$)/.test(title)) keys.add('other/meetings');
        const entry = { ...lesson, productId: course.productId, sectionId: section.streamId };
        for (const target of keys) {
          if (!groups.has(target)) groups.set(target, []);
          groups.get(target).push(entry);
        }
      }
    }
  }
  return groups;
}
