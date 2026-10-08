import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const front = path.join(root, 'Фронт');
const seed = path.join(root, 'backend', 'seed');
const uploads = path.join(seed, 'uploads', 'weekly');
fs.mkdirSync(uploads, { recursive: true });
const sourceRef = process.argv[2] || '30094b8';
const original = relative => execFileSync('git', ['show', `${sourceRef}:Фронт/${relative.replaceAll('\\', '/')}`], { cwd: root });

function readLibrary(filename, name) {
  const context = { window: {} };
  vm.runInNewContext(original(filename).toString('utf8'), context, { filename, timeout: 1000 });
  return JSON.parse(JSON.stringify(context.window[name]));
}

const baby = readLibrary('baby-weeks-data.js', 'babyWeekLibrary');
const mom = readLibrary('mom-weeks-data.js', 'momWeekLibrary');
const source = original('calendar-sheet.js').toString('utf8');
const match = source.match(/const events = (\{[\s\S]*?\n  \});\s*const icons =/);
if (!match) throw new Error('Calendar events were not found');
const originalCalendar = vm.runInNewContext(`(${match[1]})`, {}, { timeout: 1000 });
const calendar = Object.fromEntries(Array.from({ length: 42 }, (_, i) => [String(i + 1), originalCalendar[i + 1] || []]));
const calendarNotes = Object.fromEntries([...source.matchAll(/if \(selectedWeek === (\d+)\) content\.insertAdjacentHTML\('beforeend', '(<p class="calendar-note">.*?<\/p>)'\);/g)]
  .map(([, week, markup]) => [week, markup.replace(/<span[^>]*>i<\/span>/, '').replace(/<[^>]+>/g, '')]));

for (const [week, item] of Object.entries(baby)) {
  for (const field of ['illustration', 'comparisonImage']) {
    if (!item[field]) continue;
    const relative = item[field].split('?')[0];
    const bytes = fs.existsSync(path.join(front, relative)) ? fs.readFileSync(path.join(front, relative)) : original(relative);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const filename = `${digest}.webp`;
    fs.writeFileSync(path.join(uploads, filename), bytes);
    item[field] = `/uploads/weekly/${filename}`;
  }
  if (!mom[week]) throw new Error(`Missing mom week ${week}`);
}
if (Object.keys(baby).length !== 42 || Object.keys(mom).length !== 42) throw new Error('Expected 42 weeks');
fs.writeFileSync(path.join(seed, 'weekly-content.json'), `${JSON.stringify({ baby, mom, calendar, calendarNotes }, null, 2)}\n`);
console.log(`Exported ${Object.keys(baby).length} baby and mom weeks and ${Object.values(calendar).flat().length} calendar events`);
