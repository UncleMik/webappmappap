import { createHmac, timingSafeEqual } from 'node:crypto';
import { forGamificationUser } from './gamification-settings.mjs';

const normalize = value => String(value || '').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/gu, ' ').trim();
const groups = [2594, 2596, 2598, 2600, 2602, 2604];
const tags = new Set(['кровь', 'сильная боль', 'малыш затих', 'подтекание']);

// Pure matcher against the explicitly approved version of source paragraphs.
// Exceptions remove only their own span; a separate warning in the message remains active.
export function matchesUrgent(text, paragraphs, selectedTags = []) {
  if (selectedTags.some(tag => tags.has(normalize(tag)))) return true;
  const clean = normalize(text).replace(/[^.!?;\n]*было на прошлой неделе[^.!?;\n]*/gu, '')
    .replace(/(?:нет крови|без крови|не болит|анализ(?:ы|а|ов)? крови|группа крови|сахар в крови)/gu, '');
  return paragraphs.filter(row => groups.includes(row.paragraph)).some(row => row.text.split(',').some(value => {
    const phrase = normalize(value);
    // A left word boundary prevents e.g. «кровь» inside another word. The
    // right side is intentionally open: the source requires stem matching.
    return phrase && new RegExp(`(?:^|[^\\p{L}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(clean);
  }));
}
export function createAiUrgent({ pool, settings }) {
  return { async evaluate({ text, tags: selectedTags = [], userId }) {
    if (!settings) return null;
    const config = forGamificationUser(await settings.get(), userId);
    if (!config.enabled || config.medicalApproved !== true) return null;
    const { rows: [row] } = await pool.query("SELECT * FROM gamification_content WHERE id='urgent-help' AND status='approved'");
    const paragraphs = row?.body?.paragraphs;
    if (!row?.medical || !row.approved_by || !row.approved_at || !row.evidence || !Array.isArray(paragraphs)
      || ![2586,2587,2588,2589,...groups,2606,2607].every(id => paragraphs.some(p => p.paragraph === id && typeof p.text === 'string' && p.text.trim()))) return null;
    if (!matchesUrgent(text, paragraphs, selectedTags)) return null;
    const at = id => paragraphs.find(p => p.paragraph === id).text;
    return { contentId: row.id, revision: row.revision, title: at(2586), body: at(2587), reassurance: at(2588),
      actions: [{ type: 'call', label: 'Позвонить 103', href: 'tel:103' }, { type: 'continue', label: 'Это не срочно, продолжить' }], free: true };
  } };
}
// Continuation belongs to this exact message and approved revision. Another
// message always receives its own screening, including in the same conversation.
export function urgentContinuation(secret, { account, requestId, hash, revision, conversationId = '', expires }) {
  return createHmac('sha256', secret).update(JSON.stringify([account,requestId,hash,revision,conversationId,expires])).digest('hex');
}
export function validUrgentContinuation(secret, context, value, now) {
  if (!value || !Number.isSafeInteger(value.expires) || value.expires <= Number(new Date(now))
    || value.expires > Number(new Date(now)) + 600000 || typeof value.signature !== 'string' || !/^[a-f0-9]{64}$/.test(value.signature)) return false;
  const signature = urgentContinuation(secret, { ...context, expires: value.expires });
  return timingSafeEqual(Buffer.from(signature), Buffer.from(value.signature));
}
