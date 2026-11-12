import { readFileSync } from 'node:fs';
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export function loadGamificationCatalog({pool} = {}) {
  const base=read('./gamification-catalog.json');
  if(!pool) return base;
  return async (_context,client=pool) => {
    const cat=structuredClone(base),rows=(await client.query('SELECT * FROM gamification_content')).rows;
    const apply=item=>{ const row=rows.find(r=>r.id===item.id);if(!row)return item;
      return {...item,...row.body,id:item.id,status:row.status==='approved'?'published':'unpublished',medical:row.medical,medicalApproved:row.status==='approved'&&Boolean(row.approved_by&&row.approved_at&&row.evidence)}; };
    for(const key of ['letters','questions','care','ideas','practices','replies','quests','hints'])cat[key]=(cat[key]||[]).map(apply);
    for(const key of ['bag','doctor'])cat.checklists[key]=cat.checklists[key].map(apply);
    cat.weekly=Object.fromEntries(Object.entries(cat.weekly).map(([k,v])=>[k,apply(v)]));
    return cat;
  };
}
const range = value => { const n = String(value).match(/\d+/g)?.map(Number) || [1,42]; return [n[0], n[1] || n[0]]; };
export function normalizeGamificationContent(source, weekly = {}) {
  const draft = item => ({ status: item.status === 'published' && item.review_status === 'approved' ? 'published' : 'unpublished', medical: true, medicalApproved: item.review_status === 'approved' });
  const displayText=value=>typeof value==='string'?value.replace(/\s*\(текст один на 4 недели; смена по разделу В, если уже был\)$/u,''):value;
  const cards = (items, prefix) => (items || []).map((x,i) => ({id:`${prefix}-${i+1}`, text:displayText(x.text || x['Текст']), trimester:x.trimester, ...draft(x)}));
  const features = (source.feature_schedule_source || []).map(x => ({id:x['Код'], minDays:Number(x['Стаж, дней ≥']), minWeek:range(x['Недели'])[0], maxWeek:range(x['Недели'])[1], novelty:x['Тип']==='Новинка', priority:Number(x['Приоритет новинок'])||0}));
  const paragraphs = source.checklists_quests_capsule_source || [];
  const bag = paragraphs.filter(x=>x.paragraph>=2504 && x.paragraph<=2508).flatMap(x=>x.text.split(': ').slice(1).join(': ').split(' · ').map((text,i)=>({id:`bag-${x.paragraph}-${i}`, text, conditional:/если есть/.test(text), ...draft(x)})));
  const doctor = paragraphs.filter(x=>x.paragraph>=2510 && x.paragraph<=2521).map(x=>({id:`doctor-${x.paragraph}`,text:x.text,conditional:false,...draft(x)}));
  const quests = Object.entries(weekly.calendar||{}).flatMap(([week,items])=>items.map((x,i)=>({id:`quest-${week}-${i}`,week:Number(week),type:x.type,title:x.title,text:x.description,conditional:/Rh|резус/i.test(x.title+' '+x.description),...draft(x)})));
  return {version:1,hints:(source.feature_hints_source||[]).map(x=>({id:`hint-${x['Код']}`,feature:x['Код'],text:x['Текст подсказки'],babyRelated:!['checkin','streak'].includes(x['Код']),...draft(x)})),tags:(source.tag_dictionary_source||[]).map(x=>({tag:x['Тег'],keywords:x['Ключевые слова в названии'].replace(/\([^)]*\)/g,'').split(/[,/]/).map(s=>s.trim().toLocaleLowerCase('ru')).filter(Boolean)})),features,letters:(source.letters||[]).map(x=>({id:`letter-${x.week}`,week:x.week,text:x.text,...draft(x)})), questions:(source.myths||[]).map(x=>({id:`myth-${x.week}-${x.slot}`,kind:'myth',week:x.week,slot:x.slot,prompt:x.statement,options:['Правда','Миф'],answer:x.answer==='Миф'?1:0,explanation:x.explanation,articleId:x.article_id,...draft(x)})),care:cards(source.care_cards,'care'),ideas:cards(source.day_ideas,'idea').map((x,i)=>({...x,minWeek:range(source.day_ideas[i]['Нед.'])[0],maxWeek:range(source.day_ideas[i]['Нед.'])[1]})),practices:cards(source.short_practices,'practice'),replies:(source.checkin_replies||[]).map((x,i)=>({id:`reply-${i+1}`,text:x.text,mood:x.mood,trimester:x.trimester,...draft(x)})),weekly:Object.fromEntries(Object.entries(weekly.baby||{}).map(([week,x])=>[week,{id:`weekly-${week}`,week:Number(week),baby:x.description,development:x.developmentDescription,measurements:x.measurements,momTitle:weekly.mom?.[week]?.title||'',mom:weekly.mom?.[week]?.paragraphs?.join('\n')||'',...draft(x)}])),quests,checklists:{bag,doctor},materials:[]};
}
export function isPublished(item, settings) { return item?.status === 'published' && (item.medical === false || (settings.medicalApproved === true && item.medicalApproved === true)); }
export function parseMeasurements(value) {
  const match = String(value||'').match(/Рост\s*[≈~:]?\s*(\d+(?:[.,]\d+)?)\s*см.*?Вес\s*[≈~:]?\s*(\d+(?:[.,]\d+)?)\s*(кг|г)/i);
  if (!match) return null;
  const height=Number(match[1].replace(',','.')), weight=Number(match[2].replace(',','.'))*(match[3].toLowerCase()==='кг'?1000:1);
  return height>0 && weight>0 ? {height,weight} : null;
}
export function guessQuestion(item) {
  const measurement=parseMeasurements(item?.measurements); if(!measurement) return null;
  const values=[measurement.weight,Math.round(measurement.weight*.6/50)*50,Math.round(measurement.weight*1.5/50)*50];
  if(new Set(values).size!==3) return null;
  // Stable per-week permutation prevents a refresh from moving the correct answer.
  const shift=item.week%3, rotated=[...values.slice(shift),...values.slice(0,shift)];
  return {id:`guess-${item.week}`,kind:'guess_size',week:item.week,slot:2,prompt:`Сколько весит малыш на ${item.week} неделе?`, options:rotated.map(x=>`${x} г`),answer:rotated.indexOf(measurement.weight),explanation:`Около ${measurement.weight} г — и примерно ${measurement.height} см от макушки до пят. Цифры средние: у твоего малыша могут быть свои`,status:item.status,medical:item.medical,medicalApproved:item.medicalApproved};
}

export function materialTags(title,dictionary=[]) { const text=String(title||'').toLocaleLowerCase('ru'); const tags=dictionary.filter(x=>x.keywords.some(word=>text.includes(word))).slice(0,3).map(x=>x.tag);return tags.length?tags:['Самочувствие']; }
