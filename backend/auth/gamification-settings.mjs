import { AuthError, isUuid } from './security.mjs';

export const DEFAULT_GAMIFICATION_SETTINGS = Object.freeze({
  enabled: false,
  audience: {mode:'selected',userIds:[]},
  features: { stars:false, daily:false, weekLocks:false, peekNextWeek:false, aiPacks:false, myths:false, quests:false, capsule:false, games:false, notifications:false, push:false },
  rewards: { welcome:100, checkin:5, surprise:5, mythAnswer:5, mythCorrect:5, article:10, video:20, courseLesson:30, weekComplete:50, poll:20, pollMajority:10, clubMessage:5, kicks:5, quest:15, firstKick:15, capsule:15, trimester:30 },
  limits: { freeDaily:100, courseDaily:150 },
  prices: { peekNextWeek:100, aiPackFree:50, aiPackCourse:100 },
  ai: { freeDaily:5, courseDaily:30, freePack:3, coursePack:10, freePurchases:2, coursePurchases:1, freePaidDaily:6, coursePaidDaily:10 },
});
export const GAMIFICATION_SETTING_MAXIMUMS = Object.freeze({rewards:32767,limits:32767,prices:32767,ai:{freeDaily:30,courseDaily:30,freePack:30,coursePack:30,freePurchases:2,coursePurchases:1,freePaidDaily:10,coursePaidDaily:10}});
const invalid = () => new AuthError(400,'invalid_settings','Проверьте параметры звёздочек.');
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid();
  for (const [group,value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_GAMIFICATION_SETTINGS,group)) throw invalid();
    if (group === 'enabled') { if (typeof value !== 'boolean') throw invalid(); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    if(group==='audience') {
      if(Object.keys(value).some(k=>!['mode','userIds'].includes(k)) || value.mode!==undefined&&!['selected','all'].includes(value.mode))throw invalid();
      if(value.userIds!==undefined && (!Array.isArray(value.userIds)||value.userIds.length>1000||value.userIds.some(id=>!isUuid(id))||new Set(value.userIds.map(id=>id.toLowerCase())).size!==value.userIds.length))throw invalid();
      continue;
    }
    for (const [key,n] of Object.entries(value)) {
      if (!Object.hasOwn(DEFAULT_GAMIFICATION_SETTINGS[group],key)) throw invalid();
      if (group === 'features' ? typeof n !== 'boolean' : !Number.isInteger(n) || n < 0 || n > (typeof GAMIFICATION_SETTING_MAXIMUMS[group] === 'number' ? GAMIFICATION_SETTING_MAXIMUMS[group] : GAMIFICATION_SETTING_MAXIMUMS[group]?.[key])) throw invalid();
    }
  }
  return patch;
}
export function mergeSettings(value = {}) {
  validateSettingsPatch(value);
  const result = structuredClone(DEFAULT_GAMIFICATION_SETTINGS);
  for (const [group,patch] of Object.entries(value)) result[group] = group === 'enabled' ? patch : {...result[group],...patch};
  return result;
}
export function forGamificationUser(config,userId) {
  const selected=!config.audience || config.audience.mode==='all' || config.audience.mode==='selected' && config.audience.userIds?.some(id=>id.toLowerCase()===String(userId).toLowerCase());
  return {...config,enabled:config.enabled===true&&Boolean(selected)};
}
export function createGamificationSettings({pool}) {
  async function get(client = pool) {
    const {rows:[row]} = await client.query('SELECT * FROM gamification_settings WHERE id=1');
    const result = mergeSettings(row?.value);
    return {...result,medicalApproved:row?.medical_approved === true,aiBudgetApproved:row?.ai_budget_approved === true};
  }
  return {get, async publicSettings() {
    const {enabled,features,rewards,limits,prices,ai,medicalApproved,aiBudgetApproved} = await get();
    return {enabled,features,rewards,limits,prices,ai,medicalApproved,aiBudgetApproved};
  }};
}
