import { AuthError, hashToken } from './security.mjs';
import { transaction } from './store.mjs';
import { readFileSync } from 'node:fs';

const source=JSON.parse(readFileSync(new URL('../content/gamification-source.json',import.meta.url),'utf8'));
export function starsPollSchedule() {
  return [...source.polls_source,...source.polls_reserve_source].map((row,index)=>{
    const start=new Date(Date.parse('2026-11-16T07:00:00Z')+index*7*86400000);
    const options=String(row['Варианты ответа (порядок на экране такой же)']||row['Варианты ответа']).split(/\s*·\s*/).map(s=>s.replace(/^\d+\)\s*/,''));
    return {id:start.toISOString().slice(0,10),question:row['Вопрос'],options,opensAt:start,closesAt:new Date(+start+6*86400000+8*3600000)};
  });
}

const countVotes = `ARRAY(
  SELECT count(w.choice)::integer
  FROM generate_subscripts(p.options, 1) AS option
  LEFT JOIN weekly_poll_votes w ON w.poll_id = p.id AND w.choice = option - 1
  GROUP BY option ORDER BY option
  )`;

export function createWeeklyPoll(pool, { stars = null, notifications = null } = {}) {
  async function ensureSchedule(){
    if(!stars||!await stars.isEnabled())return;
    // Never update an existing poll: it may already have votes under older rules.
    await pool.query(`INSERT INTO weekly_polls(id,question,options,opens_at,closes_at)
      SELECT id,question,options,"opensAt","closesAt" FROM jsonb_to_recordset($1::jsonb)
      AS p(id text,question text,options text[],"opensAt" timestamptz,"closesAt" timestamptz)
      ON CONFLICT DO NOTHING`,[JSON.stringify(starsPollSchedule())]);
  }
  return {
    async read(userId) {
      await ensureSchedule();
      const availability=stars?await stars.pollAvailability(pool,userId):{available:true,reason:null,availableAt:null};
      const { rows: [poll] } = await pool.query(`
        SELECT p.id, p.question, p.options, p.closes_at AS "closesAt",
               p.closes_at > now() AS open, v.choice, v.points,
               p.settled_at IS NOT NULL AS settled,
               CASE WHEN p.settled_at IS NOT NULL OR v.choice IS NOT NULL THEN ${countVotes} END AS counts
        FROM weekly_polls p
        LEFT JOIN weekly_poll_votes v ON v.poll_id = p.id AND v.user_id = $1
        WHERE p.opens_at <= now()
        ORDER BY p.opens_at DESC LIMIT 1
      `, [userId]);
      const { rows: [total] } = await pool.query(`
        SELECT coalesce(sum(points), 0)::integer AS points
        FROM weekly_poll_votes WHERE user_id = $1
      `, [userId]);
      return { poll: availability.available?(poll??null):null, points: total.points, accountId: userId,
        enabled:availability.available,available:availability.available&&Boolean(poll),reason:availability.reason,availableAt:availability.availableAt };
    },
    vote(token, accountId, { pollId, choice }) {
      if (typeof pollId !== 'string' || !Number.isInteger(choice) || choice < 0) {
        throw new AuthError(400, 'invalid_vote', 'Выберите вариант ответа.');
      }
      return transaction(pool, async client => {
        const { rows: [session] } = await client.query(`
          SELECT user_id FROM auth_sessions WHERE token_hash = $1
          AND revoked_at IS NULL AND expires_at > now() FOR SHARE
        `, [hashToken(token || '')]);
        if (!session) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
        if (session.user_id !== accountId) {
          throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
        }
        if(stars && !(await stars.pollAvailability(client,session.user_id)).available)
          throw new AuthError(403,'poll_onboarding','Голосование появится немного позже.');
        const { rows: [poll] } = await client.query(`
          SELECT options,settled_at FROM weekly_polls WHERE id = $1 FOR SHARE
        `, [pollId]);
        if (!poll || choice >= poll.options.length) {
          throw new AuthError(400, 'invalid_vote', 'Выберите вариант ответа.');
        }
        await client.query(`
          INSERT INTO weekly_poll_votes (poll_id, user_id, choice)
          SELECT id, $2, $3 FROM weekly_polls WHERE id = $1
            AND opens_at <= clock_timestamp() AND closes_at > clock_timestamp()
          ON CONFLICT (poll_id, user_id) DO NOTHING
        `, [pollId, session.user_id, choice]);
        const { rows: [vote] } = await client.query(`
          SELECT v.choice, ${countVotes} AS counts
          FROM weekly_polls p JOIN weekly_poll_votes v ON v.poll_id = p.id
          WHERE p.id = $1 AND v.user_id = $2
        `, [pollId, session.user_id]);
        if (!vote) throw new AuthError(409, 'poll_closed', 'Голосование уже завершилось.');
        if(stars && !poll.settled_at && await stars.isEnabled(session.user_id)){
          const c=await stars.contextFor(client,session.user_id);
          const {rows:old}=await client.query('SELECT 1 FROM auth_points_ledger WHERE user_id=$1 AND poll_id=$2',[session.user_id,pollId]);
          if(!old.length){const reward=await stars.credit(client,c,{code:'poll_vote',ref:pollId,amount:c.settings.rewards?.poll??20});
            await client.query('UPDATE weekly_poll_votes SET points=$3 WHERE poll_id=$1 AND user_id=$2',[pollId,session.user_id,reward.actualAmount]);}
        }
        return { ...vote, accountId: session.user_id };
      });
    },
    async settle() {
      await ensureSchedule();
      return transaction(pool, async client => {
        const { rows: polls } = await client.query(`
          SELECT id FROM weekly_polls WHERE settled_at IS NULL AND closes_at <= now()
          ORDER BY id FOR UPDATE
        `);
        for (const { id } of polls) {
          // A temporary feature rollback cannot convert an already credited stars poll
          // into the old 50/100 settlement and pay it a second time.
          if(stars&&!await stars.isEnabled()){
            const {rows}=await client.query("SELECT 1 FROM auth_points_ledger WHERE event_code='poll_vote' AND event_ref=$1 LIMIT 1",[id]);
            if(rows.length)continue;
          }
          if(stars && await stars.isEnabled()){
            const {rows:votes}=await client.query(`SELECT v.user_id,v.choice,(SELECT count(*) FROM weekly_poll_votes x WHERE x.poll_id=v.poll_id AND x.choice=v.choice)::int AS votes FROM weekly_poll_votes v WHERE poll_id=$1 ORDER BY user_id`,[id]);
            const max=Math.max(0,...votes.map(v=>v.votes));
            let pending=false;
            const recipients=[];
            for(const v of votes){
              const {rows:old}=await client.query('SELECT 1 FROM auth_points_ledger WHERE user_id=$1 AND poll_id=$2',[v.user_id,id]);
              if(old.length)continue;
              if(!await stars.isEnabled(v.user_id)){
                const {rows:started}=await client.query("SELECT 1 FROM auth_points_ledger WHERE user_id=$1 AND event_code='poll_vote' AND event_ref=$2",[v.user_id,id]);
                if(started.length){pending=true;continue;}
                // Non-pilot voters retain the previous reward rules even in a mixed poll.
                await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE',[v.user_id]);
                const amount=v.votes===max?100:50;
                await client.query(`INSERT INTO auth_points_ledger(user_id,poll_id,occurred_at,moscow_day,amount,capped)
                  SELECT $1,id,closes_at,(closes_at AT TIME ZONE 'Europe/Moscow')::date,$3,false FROM weekly_polls WHERE id=$2 ON CONFLICT DO NOTHING`,[v.user_id,id,amount]);
                await client.query('UPDATE weekly_poll_votes SET points=$3 WHERE poll_id=$1 AND user_id=$2',[id,v.user_id,amount]);
                continue;
              }
              const c=await stars.contextFor(client,v.user_id);
              recipients.push(v.user_id);
              if(!old.length){
                const participation=await stars.credit(client,c,{code:'poll_vote',ref:id,amount:c.settings.rewards?.poll??20});
                const majority=v.votes===max?await stars.credit(client,c,{code:'poll_majority',ref:id,amount:c.settings.rewards?.pollMajority??10}):null;
                await client.query('UPDATE weekly_poll_votes SET points=$3 WHERE poll_id=$1 AND user_id=$2',[id,v.user_id,participation.actualAmount+(majority?.actualAmount||0)]);
              }
            }
            if(!pending){
              await client.query('UPDATE weekly_polls SET settled_at=now() WHERE id=$1',[id]);
              for(const userId of recipients)await notifications?.enqueue(client,{
                userId,key:'poll-results-'+id,type:'poll_results',title:'Голосование завершено',body:'',
                url:'/club.html?poll=1#events',babyRelated:false,medical:false
              });
            }
            continue;
          }
          await client.query(`
            WITH counts AS (
              SELECT choice, count(*) AS votes FROM weekly_poll_votes
              WHERE poll_id = $1 GROUP BY choice
            )
            UPDATE weekly_poll_votes v
            SET points = CASE WHEN c.votes = (SELECT max(votes) FROM counts) THEN 100 ELSE 50 END
            FROM counts c WHERE v.poll_id = $1 AND v.choice = c.choice
          `, [id]);
          await client.query(`
            INSERT INTO auth_points_ledger (user_id, poll_id, occurred_at, moscow_day, amount)
            SELECT v.user_id, v.poll_id, p.closes_at, (p.closes_at AT TIME ZONE 'Europe/Moscow')::date, v.points
            FROM weekly_poll_votes v JOIN weekly_polls p ON p.id = v.poll_id WHERE v.poll_id = $1
            ON CONFLICT DO NOTHING
          `, [id]);
          await client.query('UPDATE weekly_polls SET settled_at = now() WHERE id = $1', [id]);
        }
      });
    }
  };
}
