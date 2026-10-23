import { AuthError, randomToken, generateCode } from './security.mjs';

export function createAuthService({ store, sendMail, ensureGetCourse, makeCode = generateCode }) {
  const unavailable = () => new AuthError(503, 'getcourse_pending', 'GetCourse временно недоступен. Регистрация ещё не завершена. Попробуйте ещё раз.', 5);
  async function processJob(email = null) {
    const job = await store.claimJob(email);
    if (!job) return;
    try {
      const id = await ensureGetCourse(job.email);
      await store.completeJob(job, id);
    } catch {
      // Fixed diagnostic code only: do not persist provider errors containing PII.
      await store.failJob(job, 'getcourse_unavailable');
    }
  }
  async function complete(token) {
    const state = await store.registration(token);
    if (!state.user_id && !state.completed_at) await processJob(state.email);
    const sessionToken = randomToken();
    const result = await store.finish(token, sessionToken);
    if (result.pending) throw unavailable();
    return { ...result, sessionToken };
  }
  return {
    async request(email) {
      const challenge = randomToken(), code = makeCode();
      await store.reserveCode(email, challenge, code);
      try { await sendMail({ email, code, idempotencyKey: challenge }); }
      catch {
        await store.cancelCode(challenge);
        throw new AuthError(503, 'mail_unavailable', 'Не удалось отправить письмо. Попробуйте через минуту.', 60);
      }
      return { challenge, expiresIn: 300, retryAfter: 60 };
    },
    async verify(token, code) {
      await store.verifyCode(token, code);
      return complete(token);
    },
    complete,
    processJob,
    session: token => store.session(token),
    sessionState: token => store.sessionState(token),
    saveProfile: (token, data) => store.saveProfile(token, data),
    logout: token => store.logout(token),
  };
}
