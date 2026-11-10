const scheme = /(?<![\p{L}\p{N}])(?:[a-z][a-z\d+.-]*\s*:\s*\/\s*\/|h\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\/|(?:https?|ftp|mailto|tel|sms|tg|whatsapp):\S)/iu;
const label = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`;
const dot = String.raw`(?:[ \t]*\.|[ \t]*\[\.\][ \t]*)`;
const suffix = String.raw`(?:[\p{L}]{2,63}|xn--[a-z\d-]{2,59})(?![\p{L}\p{N}_-])`;
const domain = new RegExp(String.raw`(?<![\p{L}\p{N}_-])(?:${label}${dot})+${suffix}`, 'iu');
// After a dot followed by a space, require a familiar suffix or a path.
const spacedDomain = new RegExp(String.raw`(?<![\p{L}\p{N}_-])(?:${label}\s*\.\s*)+(?:(?:com|net|org|info|ru|рф|su|me|io|app|online|site|онлайн)(?![\p{L}\p{N}_-])|${suffix}\s*\/)`, 'iu');

export function containsClubLink(text) {
  const normalized = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[。｡]/g, '.');
  return scheme.test(normalized) || domain.test(normalized) || spacedDomain.test(normalized);
}

const profanity = [
  /^(?:на|по|ни|до|о|за|про)?ху(?:й|я|е[а-яё]+|и[а-яё]*|йн[а-яё]*|яр[а-яё]*)$/iu,
  /^(?:рас|раз|от|на|вы|за|под|про|до|пере)?пизд[а-яё]*$/iu,
  /^(?:по|на|вы|за|под|разъ|объ|отъ|съ|у|про|пере|недо)?[её]б(?:а[а-яё]*|л[а-яё]*|н[а-яё]*|у[а-яё]*|уч[а-яё]*|и(?:сь|те)?|[её]т[а-яё]*)$/iu,
  /^(?:бля(?:д[а-яё]*|ть|ха)?|су(?:ка|ки|ку|ке|кой|чка|чки|чку|чке|чкой|чар[а-яё]*)|муда[кч][а-яё]*|долбо[её]б[а-яё]*)$/iu,
  /^(?:(?:гандон|гондон|мразь|мрази|тварь|твари|дебил|кретин|идиот|придур)[а-яё]*|дур(?:а|ы|у|е|ой|ак[а-яё]*|очк[а-яё]*))$/iu,
];

export function maskClubProfanity(text) {
  return text.replace(/[\p{L}\p{M}\p{N}]+(?:\p{Cf}+[\p{L}\p{M}\p{N}]+)*/gu, word => {
    const normalized = word.normalize('NFKC').replace(/\p{Cf}/gu, '');
    return profanity.some(pattern => pattern.test(normalized)) ? '*****' : word;
  });
}
