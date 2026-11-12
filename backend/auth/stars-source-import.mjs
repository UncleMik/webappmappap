import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {normalizeEmail} from './security.mjs';
import {transaction} from './store.mjs';
import {normalizeGamificationContent} from './gamification-content.mjs';

export const STARS_REUSE_EVIDENCE='Повторное использование действующих опубликованных материалов школы, без изменения содержания';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(sort(value));
function sort(value) {
  if(Array.isArray(value))return value.map(sort);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])]));
  return value;
}
function editorItems(catalog,source) {
  const result=new Map();
  function walk(value,kind) {
    if(Array.isArray(value)){for(const item of value)walk(item,kind);return;}
    if(!value||typeof value!=='object')return;
    if(value.id&&kind!=='features'&&kind!=='materials') {
      if(result.has(value.id))throw fail('stars_catalog_duplicate','В каталоге повторяется идентификатор.');
      result.set(value.id,{id:value.id,kind,body:value,medical:value.medical!==false});return;
    }
    for(const [key,item]of Object.entries(value))walk(item,kind||key);
  }
  walk(catalog,'');
  result.set('urgent-help',{id:'urgent-help',kind:'urgent_help',body:{paragraphs:source.urgent_help_source},medical:true});
  return result;
}
async function sourcePlan(requiredHash,evidence) {
  if(typeof requiredHash!=='string'||! /^[a-f0-9]{64}$/i.test(requiredHash))throw fail('stars_source_hash_required','Укажите SHA256 утверждённого файла источника.');
  if(typeof evidence!=='string'||!evidence.trim()||evidence.length>=2000||evidence.includes('\0'))throw fail('stars_source_evidence_required','Укажите непустое основание до 1999 знаков.');
  const [sourceBytes,catalogBytes]=await Promise.all([readFile(new URL('../content/gamification-source.json',import.meta.url)),readFile(new URL('./gamification-catalog.json',import.meta.url))]);
  const sourceSha256=sha(sourceBytes);
  if(sourceSha256!==requiredHash.toLowerCase())throw fail('stars_source_hash_mismatch','Файл источника не совпадает с утверждённым SHA256.');
  const parse=bytes=>JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  const source=parse(sourceBytes),catalog=parse(catalogBytes),items=editorItems(catalog,source);
  const exactDocx=editorItems(normalizeGamificationContent(source),source);
  for(const [id,item]of items) {
    item.reused=['weekly','quests'].includes(item.kind);
    if(!item.reused&&canonical(item)!==canonical({...exactDocx.get(id),reused:false}))throw fail('stars_catalog_source_mismatch','Каталог содержит изменение вне утверждённого источника.');
  }
  for(const id of exactDocx.keys())if(!items.has(id))throw fail('stars_catalog_source_mismatch','В каталоге отсутствует утверждённый исходный материал.');
  const list=[...items.values()].sort((a,b)=>a.id.localeCompare(b.id));
  return {sourceSha256,catalogSha256:sha(canonical(list)),catalogFileSha256:sha(catalogBytes),sourceDocxSha256:source.source?.sha256||null,evidence:evidence.trim(),items:list};
}

// Privileged offline maintenance only. ownerEmail comes from private ADMIN_OWNER_EMAIL,
// never an HTTP payload or a fabricated UUID. The complete import owns one transaction.
export async function importApprovedStarsSource({pool,ownerEmail,evidence,sourceSha256,dryRun=false}={}) {
  if(!pool?.connect||typeof dryRun!=='boolean')throw fail('stars_source_invalid_options','Нужны pool и корректный dryRun.');
  const source=await sourcePlan(sourceSha256,evidence);
  let email;try{email=normalizeEmail(ownerEmail);}catch{throw fail('stars_source_owner_required','Не задан корректный ADMIN_OWNER_EMAIL.');}
  return transaction(pool,async client=>{
    // Same global mutex as normal owner edits/approvals: no lost admin revision.
    const settings=(await client.query('SELECT * FROM gamification_settings WHERE id=1 FOR UPDATE')).rows[0];
    if(!settings)throw fail('stars_source_settings_missing','Сначала примените миграцию настроек.');
    const owners=(await client.query('SELECT id FROM auth_users WHERE lower(email)=$1 FOR SHARE',[email])).rows;
    if(owners.length!==1)throw fail('stars_source_owner_absent','Единственный аккаунт владельца не найден.');
    const actorId=owners[0].id,existing=new Map((await client.query('SELECT * FROM gamification_content WHERE id=ANY($1::text[]) FOR UPDATE',[source.items.map(x=>x.id)])).rows.map(row=>[row.id,row]));
    // Preflight every row before the first write; conflicts never overwrite drafts.
    for(const item of source.items) {
      const row=existing.get(item.id);
      if(row&&(row.kind!==item.kind||row.medical!==item.medical||canonical(row.body)!==canonical(item.body)))throw fail('stars_source_content_conflict',`Исходный материал уже изменён: ${item.id}. Импорт отменён.`);
    }
    const counts={total:source.items.length,docx:source.items.filter(x=>!x.reused).length,reused:source.items.filter(x=>x.reused).length,insert:0,approve:0,unchanged:0};
    for(const item of source.items){const row=existing.get(item.id);if(!row)counts.insert++;if(row?.status==='approved')counts.unchanged++;else counts.approve++;}
    const result={dryRun,sourceSha256:source.sourceSha256,catalogSha256:source.catalogSha256,counts,medicalGateChange:!settings.medical_approved};
    if(dryRun)return result;
    const now=new Date();
    async function audit(action,target,before,after,reason) {
      await client.query('INSERT INTO gamification_audit(actor_id,action,target,before_value,after_value,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[actorId,action,target,before===null?null:JSON.stringify(before),JSON.stringify(after),reason,now]);
    }
    for(const item of source.items) {
      let row=existing.get(item.id);
      const reason=item.reused?STARS_REUSE_EVIDENCE:source.evidence;
      if(!row) {
        row=(await client.query("INSERT INTO gamification_content(id,kind,body,medical,status,updated_by,updated_at) VALUES($1,$2,$3,$4,'draft',$5,$6) RETURNING *",[item.id,item.kind,JSON.stringify(item.body),item.medical,actorId,now])).rows[0];
        await audit('content_saved',item.id,null,row,reason);
      }
      if(row.status!=='approved') {
        const after=(await client.query("UPDATE gamification_content SET status='approved',approved_by=$2,approved_at=$3,evidence=$4 WHERE id=$1 RETURNING *",[item.id,actorId,now,reason])).rows[0];
        await audit('content_approved',item.id,row,after,reason);
      }
    }
    if(!settings.medical_approved) {
      await client.query('UPDATE gamification_settings SET medical_approved=true,updated_at=$1 WHERE id=1',[now]);
      await audit('gate_approved','medicalApproved',{approved:false},{approved:true},source.evidence);
    }
    const target='stars-source:'+source.sourceSha256;
    const proof=(await client.query("SELECT id FROM gamification_audit WHERE action='source_imported' AND target=$1 AND after_value->>'catalogSha256'=$2 LIMIT 1",[target,source.catalogSha256])).rows[0];
    if(!proof)await audit('source_imported',target,null,{sourceSha256:source.sourceSha256,catalogSha256:source.catalogSha256,catalogFileSha256:source.catalogFileSha256,sourceDocxSha256:source.sourceDocxSha256,documentIds:source.items.filter(x=>!x.reused).map(x=>x.id),reusedIds:source.items.filter(x=>x.reused).map(x=>x.id),reusedEvidence:STARS_REUSE_EVIDENCE,counts},source.evidence);
    return result;
  });
}

// Run only inside the existing trusted runtime environment; no secrets in arguments/output.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    if(process.argv.slice(2).some(x=>x!=='--dry-run'))throw fail('stars_source_invalid_options','Разрешён только параметр --dry-run.');
    if(!process.env.AUTH_DATABASE_URL)throw fail('stars_source_database_required','Не задан AUTH_DATABASE_URL.');
    const {default:pg}=await import('pg');pool=new pg.Pool({connectionString:process.env.AUTH_DATABASE_URL});
    const result=await importApprovedStarsSource({pool,ownerEmail:process.env.ADMIN_OWNER_EMAIL,evidence:process.env.STARS_SOURCE_EVIDENCE,sourceSha256:process.env.STARS_SOURCE_SHA256,dryRun:process.argv.includes('--dry-run')});
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {process.stderr.write((error.code||'stars_source_import_failed')+'\n');process.exitCode=1;}
  finally {await pool?.end();}
}
