import { createHash } from 'node:crypto';
import { activeCourseProducts, parseGetCourseDate } from './course-entitlements.mjs';
import { AuthError } from './auth/security.mjs';
import { loadCourseVideoLinks, videoLink, videoReferences } from './course-video-links.mjs';

const id = v => Number.isSafeInteger(v) && v > 0;
const digest = s => createHash('sha256').update(s).digest('hex');
const unavailable = () => new AuthError(503, 'course_materials_unavailable', 'Материалы курсов временно недоступны. Попробуйте ещё раз.');
const denied = () => new AuthError(403, 'course_access_required', 'Нет подтверждённого доступа к этому материалу.');
const freeLessons = [[4302509, 347472707], [4309095, 347531402]];
const isFreeLesson = (productId, lessonId) => freeLessons.some(([product, lesson]) => productId === product && lessonId === lesson);
const allowedTags = new Set('div span p h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr td th caption colgroup col br hr strong b em i u s del blockquote pre code details summary sup sub'.split(' '));

function inventoryData(db) {
  const products = db.prepare('SELECT product_id,title,type FROM course_products ORDER BY rowid').all()
    .map(p => ({ productId: p.product_id, title: p.title, type: p.type, trainingId: null }));
  const productMap = new Map(products.map(p => [p.productId, p]));
  const streams = new Map(), lessons = new Map();
  for (const record of db.prepare('SELECT family,inventory_json,sha256 FROM course_program_drafts').all()) {
    if (digest(record.inventory_json) !== record.sha256) throw unavailable();
    const inventory = JSON.parse(record.inventory_json);
    const rows = record.family === 'express' ? Object.values(inventory.streams) : inventory.streams;
    for (const row of rows) {
      const streamId = record.family === 'express' ? row.id : row.streamId;
      if (!id(streamId) || streams.has(streamId)) throw unavailable();
      const parents = record.family === 'express' ? row.parents.map(p => ({ id: p.streamId, order: p.order }))
        : row.parentStreamId ? [{ id: row.parentStreamId, order: row.order }] : [];
      streams.set(streamId, { id: streamId, title: row.title, parents, order: row.order ?? 0, productIds: [] });
    }
    const roots = record.family === 'express' ? inventory.roots : rows.flatMap(s => s.productProvenance
      .filter(p => p.relationship === 'direct_product_root' && p.observedAtStreamId === s.streamId)
      .map(p => ({ productId: p.productId, trainingId: s.streamId })));
    for (const root of roots) {
      const product = productMap.get(root.productId), stream = streams.get(root.trainingId);
      if (!product || product.type !== 'training' || !stream || (product.trainingId && product.trainingId !== stream.id)) throw unavailable();
      product.trainingId = stream.id; stream.productIds.push(product.productId);
    }
    for (const row of inventory.lessons) {
      const lessonId = record.family === 'express' ? row.id : row.lessonId;
      const parent = record.family === 'express' ? row.parentId : row.parentStreamId;
      if (!id(lessonId) || lessons.has(lessonId) || !streams.has(parent)) throw unavailable();
      lessons.set(lessonId, { id: lessonId, parent, order: row.order, family: record.family });
    }
  }
  const stored = db.prepare('SELECT lesson_id,parent_stream_id,title,content_json,sha256 FROM course_lesson_drafts').all();
  if (stored.length !== lessons.size || products.some(p => p.type === 'training' && !p.trainingId)) throw unavailable();
  for (const row of stored) {
    const lesson = lessons.get(row.lesson_id);
    if (!lesson || lesson.parent !== row.parent_stream_id || digest(row.content_json) !== row.sha256) throw unavailable();
    const content = JSON.parse(row.content_json);
    if (!Array.isArray(content.blocks)) throw unavailable();
    Object.assign(lesson, { title: row.title, contentHash: row.sha256,
      hasVideo: content.blocks.some(b => b.type === 'video'),
      hasText: content.blocks.some(b => ['text', 'list', 'table'].includes(b.type)
        && (typeof b.text === 'string' && b.text.trim() || b.richHtml || b.html)) });
  }
  for (const stream of streams.values()) if (stream.parents.some(p => !streams.has(p.id))) throw unavailable();
  return { products, streams, lessons };
}

export function importCourseDeliveryPolicy(db, source) {
  const catalog = inventoryData(db);
  if (source?.schemaVersion !== 1 || !Array.isArray(source.streams) || !Array.isArray(source.lessons)
    || source.streams.length !== catalog.streams.size || source.lessons.length !== catalog.lessons.size) throw new Error('Incomplete course policy');
  const streams = new Set(), lessons = new Set();
  for (const s of source.streams) {
    if (!catalog.streams.has(s.streamId) || streams.has(s.streamId) || !['0', '1'].includes(s.scheduleType)
      || typeof s.accessType !== 'string' || typeof s.noAccessMode !== 'string'
      || ![s.disableCopy, s.disableCopyCurrent, s.reverseLessons, s.hideUnavailable].every(v => typeof v === 'boolean')) throw new Error('Invalid stream policy');
    streams.add(s.streamId);
  }
  for (const l of source.lessons) {
    if (!catalog.lessons.has(l.lessonId) || lessons.has(l.lessonId) || !['1', '2', '3'].includes(l.visibility)
      || typeof l.startAt !== 'string' || ![l.hidden, l.disableCopy, l.hasMission, l.stop, l.alwaysAvailable, l.delayed].every(v => typeof v === 'boolean')
      || typeof l.stopType !== 'string') throw new Error('Invalid lesson policy');
    lessons.add(l.lessonId);
  }
  // Trusted private metadata is reduced to an explicit allowlist before storage.
  const normalized = { schemaVersion: 1,
    streams: source.streams.map(s => ({ streamId: s.streamId, accessType: s.accessType, noAccessMode: s.noAccessMode,
      scheduleType: s.scheduleType, hideUnavailable: s.hideUnavailable, disableCopy: s.disableCopy,
      disableCopyCurrent: s.disableCopyCurrent, reverseLessons: s.reverseLessons })),
    lessons: source.lessons.map(l => ({ lessonId: l.lessonId, visibility: l.visibility, startAt: l.startAt,
      hidden: l.hidden, disableCopy: l.disableCopy, hasMission: l.hasMission, stop: l.stop,
      alwaysAvailable: l.alwaysAvailable, delayed: l.delayed, stopType: l.stopType })),
  };
  const json = JSON.stringify(normalized);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS course_delivery_policy (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), body_json TEXT NOT NULL, sha256 TEXT NOT NULL)`);
    db.prepare(`INSERT INTO course_delivery_policy VALUES(1,?,?) ON CONFLICT(singleton)
      DO UPDATE SET body_json=excluded.body_json,sha256=excluded.sha256`).run(json, digest(json));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { streams: streams.size, lessons: lessons.size, videosEnabled: false };
}

const webAppFaqLessonIds = new Set([347472351, 347529680]);
const webAppFaqHtml = `
  <h2>Как войти в приложение «Лёгкие роды»</h2>
  <ol>
    <li>Откройте app.legkie-rody.ru.</li>
    <li>Введите электронную почту. Если вы уже покупали курс, укажите тот же адрес, что и при покупке в GetCourse.</li>
    <li>Нажмите «Получить код». Откройте письмо, введите шестизначный код и нажмите «Войти». Код действует 5 минут.</li>
  </ol>
  <p>Для входа достаточно кода из письма. При следующем входе запросите новый код.</p>
  <h2>Если письмо с кодом не пришло</h2>
  <p>Проверьте папку «Спам» и адрес, указанный на экране. Если в адресе ошибка, нажмите «Изменить почту». Если адрес верный, дождитесь, когда станет доступна кнопка «Отправить код ещё раз», и запросите новый код.</p>
  <h2>Как открыть купленный курс</h2>
  <p>В нижнем меню откройте «Мой путь». В разделе «Курсы для вас» выберите свой курс или нажмите «Все курсы». Затем откройте нужный раздел и урок.</p>
  <h2>Если курс не открывается</h2>
  <p>Проверьте, что вы вошли с той же почтой, которую указали при покупке. Если приложение показывает кнопку «Повторить проверку», нажмите её. Если проблема осталась, откройте «Профиль», в разделе «Поддержка» нажмите «Написать» и выберите мессенджер. Укажите название курса, почту покупки и опишите, на каком шаге возникла проблема.</p>
`;


function publicBlocks(content, lessonId, contentHash, links) {
  if (!Array.isArray(content.blocks)) throw unavailable();
  return content.blocks.map(block => {
    if (!block || !['text', 'list', 'table', 'video', 'image', 'attachment'].includes(block.type)) throw unavailable();
    const text = typeof block.text === 'string' ? block.text : '';
    const html = block.richHtml || block.html;
    if (html != null && typeof html !== 'string') throw unavailable();
    if (html) for (const token of html.matchAll(/<([^>]*)>/g)) {
      const match = token[1].match(/^\/?([a-z][a-z0-9]*)\s*\/?$/i);
      if (!match || !allowedTags.has(match[1].toLowerCase())) throw unavailable();
    }
    if (block.type === 'video') return { type: 'video', text,
      videos: videoReferences(block).map((ref, index) => {
        if (!['getcourse', 'youtube', 'rutube'].includes(ref?.provider)) return { provider: 'unknown', url: null };
        const url = videoLink(links, lessonId, block.blockId, index, contentHash);
        if (!url) return { provider: ref.provider, url: null };
        const favoriteId = digest(JSON.stringify([block.blockId, index, ref.provider, ref.videoId, ref.getcourseFileId]));
        return { provider: ref.provider, url, favoriteId };
      }) };
    return ['image', 'attachment'].includes(block.type) ? { type: block.type, text }
      : { type: block.type, text, ...(html ? { html } : {}) };
  });
}

export function createCourseMaterials({ db, courseChecks, clock = Date.now }) {
  const catalog = inventoryData(db);
  const record = db.prepare('SELECT body_json,sha256 FROM course_delivery_policy WHERE singleton=1').get();
  if (!record || digest(record.body_json) !== record.sha256) throw unavailable();
  const policy = JSON.parse(record.body_json);
  const streamPolicies = new Map(policy.streams.map(s => [s.streamId, s]));
  const lessonPolicies = new Map(policy.lessons.map(l => [l.lessonId, l]));
  if (streamPolicies.size !== catalog.streams.size || lessonPolicies.size !== catalog.lessons.size) throw unavailable();
  const siblings = new Map();
  for (const lesson of catalog.lessons.values()) {
    if (!siblings.has(lesson.parent)) siblings.set(lesson.parent, []);
    siblings.get(lesson.parent).push(lesson);
  }
  for (const list of siblings.values()) list.sort((a, b) => a.order - b.order || a.id - b.id);
  const lessonStatement = db.prepare('SELECT content_json,sha256 FROM course_lesson_drafts WHERE lesson_id=?');
  const videoLinks = loadCourseVideoLinks(db);

  async function context(userId) {
    const check = await courseChecks.requireCurrent(userId), now = clock();
    if (check?.snapshot?.version !== 2 || !Array.isArray(check.snapshot.purchases)
      || !Array.isArray(check.snapshot.trainingIds) || !Array.isArray(check.snapshot.lessonStates)) throw unavailable();
    const checkedAt = Date.parse(check.checkedAt), expiresAt = Date.parse(check.expiresAt);
    if (!Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || checkedAt > now || expiresAt <= now
      || expiresAt <= checkedAt || expiresAt - checkedAt > 300_000) throw unavailable();
    const active = activeCourseProducts(catalog.products, check, now);
    const grants = new Map(active.map(p => [p.productId, p.validUntil]));
    const available = new Set(check.snapshot.trainingIds);
    const answers = new Map();
    for (const answer of check.snapshot.lessonStates) {
      const time = parseGetCourseDate(answer.updatedAt);
      const previous = answers.get(answer.lessonId);
      if (time === null || time > now) answers.set(answer.lessonId, { time: Infinity, accepted: false });
      else if (!previous || time > previous.time) answers.set(answer.lessonId, { time, accepted: answer.status === 'accepted' });
      else if (time === previous.time && answer.status !== 'accepted') previous.accepted = false;
    }
    const meta = until => {
      const sentAt = clock();
      if (!Number.isFinite(until) || sentAt < now || sentAt >= until) throw unavailable();
      return { checkedAt: check.checkedAt, expiresAt: check.expiresAt,
        validUntil: new Date(until).toISOString(), serverTime: new Date(sentAt).toISOString() };
    };
    return { check, now, grants, active, available, answers, meta };
  }
  function pathsToRoot(streamId, root, visiting = new Set()) {
    if (streamId === root) return [[root]];
    if (visiting.has(streamId)) return [];
    const stream = catalog.streams.get(streamId);
    if (!stream) return [];
    const seen = new Set([...visiting, streamId]);
    return stream.parents.flatMap(p => pathsToRoot(p.id, root, seen).map(path => [...path, streamId]));
  }
  function allowedPath(streamId, product, ctx) {
    if (!ctx.grants.has(product.productId)) return null;
    let best = null;
    for (const path of pathsToRoot(streamId, product.trainingId)) {
      let validUntil = ctx.grants.get(product.productId), allowed = true;
      for (const [index, sid] of path.entries()) {
        const stream = catalog.streams.get(sid), p = streamPolicies.get(sid);
        if (!p || !ctx.available.has(sid) || !['none', 'parent'].includes(p.accessType)) { allowed = false; break; }
        if (index !== 0 && p.accessType === 'none') {
          // An independently purchased child can expire before its parent.
          const childEnd = Math.max(-Infinity, ...stream.productIds.filter(pid => ctx.grants.has(pid)).map(pid => ctx.grants.get(pid)));
          if (childEnd === -Infinity) { allowed = false; break; }
          validUntil = Math.min(validUntil, childEnd);
        }
      }
      if (allowed && (!best || validUntil > best.validUntil)) best = { path, validUntil };
    }
    return best;
  }
  function readable(lesson, product, ctx) {
    const p = lessonPolicies.get(lesson.id), sp = streamPolicies.get(lesson.parent);
    const access = allowedPath(lesson.parent, product, ctx);
    if (!p || !sp || p.hidden || !access) return null;
    if (p.visibility !== '1') {
      if (sp.scheduleType !== '0') return null; // Individual entry/lesson schedule is not yet verified.
      if (p.startAt) { const start = parseGetCourseDate(p.startAt); if (start === null || start > ctx.now) return null; }
    }
    if (!p.alwaysAvailable) {
      for (const earlier of siblings.get(lesson.parent)) {
        if (earlier.id === lesson.id) break;
        const previous = lessonPolicies.get(earlier.id);
        if (previous?.hasMission && previous.stop && (!ctx.answers.get(earlier.id)?.accepted || previous.stopType !== 'self')) return null;
      }
    }
    return { validUntil: access.validUntil, sectionPath: access.path, contentCopyDisabled: p.disableCopy || sp.disableCopyCurrent
      || access.path.some(sid => streamPolicies.get(sid).disableCopy) };
  }
  function owned(productId, ctx) {
    const product = catalog.products.find(p => p.productId === productId && p.type === 'training');
    if (!product || !ctx.grants.has(productId)) throw denied();
    return product;
  }
  function summaries(product, ctx) {
    return [...catalog.lessons.values()].filter(l => readable(l, product, ctx));
  }
  function aiLesson(lesson, product, sectionPath) {
    const record = lessonStatement.get(lesson.id);
    if (!record || digest(record.content_json) !== record.sha256 || record.sha256 !== lesson.contentHash) throw unavailable();
    const blocks = publicBlocks(JSON.parse(record.content_json), lesson.id, record.sha256, videoLinks);
    const text = blocks.filter(b => ['text', 'list', 'table'].includes(b.type))
      .map(b => b.text || b.html?.replace(/<[^>]+>/g, ' ') || '').join('\n')
      .replace(/https?:\/\/[^\s"'<>]+(?:\.mp4|\/files\/|\/video\/)[^\s"'<>]*/gi, '[видео]')
      .trim();
    return { productId: product.productId, course: product.title, lessonId: lesson.id,
      sectionId: lesson.parent, sectionPath, title: lesson.title, contentHash: record.sha256, text };
  }
  return Object.freeze({
    async program(userId, productId) {
      const ctx = await context(userId);
      const product = catalog.products.find(p => p.productId === productId && p.type === 'training');
      if (!product) throw denied();
      const sections = new Map();
      let validUntil = Math.min(Date.parse(ctx.check.expiresAt), ctx.grants.get(productId) ?? Infinity);
      for (const stream of catalog.streams.values()) {
        const path = pathsToRoot(stream.id, product.trainingId)[0];
        if (!path) continue;
        const rows = (siblings.get(stream.id) ?? []).filter(lesson => !lessonPolicies.get(lesson.id)?.hidden);
        if (!rows.length) continue;
        if (streamPolicies.get(stream.id).reverseLessons) rows.reverse();
        for (const [index, streamId] of path.entries()) {
          if (!sections.has(streamId)) sections.set(streamId, { streamId,
            parentStreamId: path[index - 1] ?? null,
            title: catalog.streams.get(streamId).title, available: false, lessons: [] });
        }
        const section = sections.get(stream.id);
        section.lessons = rows.map(lesson => {
          const access = readable(lesson, product, ctx);
          if (access) validUntil = Math.min(validUntil, access.validUntil);
          return { lessonId: lesson.id, title: lesson.title,
            available: Boolean(access) || isFreeLesson(productId, lesson.id),
            hasVideo: lesson.hasVideo, hasText: lesson.hasText };
        });
      }
      for (const section of sections.values()) {
        if (!section.lessons.some(lesson => lesson.available)) continue;
        let current = section;
        while (current && !current.available) {
          current.available = true;
          current = sections.get(current.parentStreamId);
        }
      }
      const children = new Map();
      for (const section of sections.values()) {
        if (!children.has(section.parentStreamId)) children.set(section.parentStreamId, []);
        children.get(section.parentStreamId).push(section);
      }
      const order = section => catalog.streams.get(section.streamId).parents
        .find(parent => parent.id === section.parentStreamId)?.order ?? 0;
      const ordered = parentId => (children.get(parentId) ?? [])
        .sort((a, b) => order(a) - order(b) || a.streamId - b.streamId)
        .flatMap(section => [section, ...ordered(section.streamId)]);
      const grant = ctx.active.find(row => row.productId === productId);
      return { course: { productId, title: product.title, rootStreamId: product.trainingId,
        available: Boolean(grant),
        ...(grant ? { accessEndsAt: grant.accessEndsAt === null ? null : new Date(grant.accessEndsAt).toISOString() } : {}),
        sections: ordered(null) }, ...ctx.meta(validUntil) };
    },
    async aiContext(userId) {
      const ctx = await context(userId);
      const courses = catalog.products.filter(p => p.type === 'training' && ctx.grants.has(p.productId));
      const lessons = [];
      let validUntil = Date.parse(ctx.check.expiresAt);
      for (const product of courses) {
        validUntil = Math.min(validUntil, ctx.grants.get(product.productId));
        for (const lesson of catalog.lessons.values()) {
          const access = readable(lesson, product, ctx);
          if (!access) continue;
          validUntil = Math.min(validUntil, access.validUntil);
          lessons.push(aiLesson(lesson, product, access.sectionPath));
        }
      }
      // Keep paid context stable; free accounts receive only these already public lessons.
      for (const [productId, lessonId] of courses.length ? [] : freeLessons) {
        if (lessons.some(lesson => lesson.lessonId === lessonId)) continue;
        const lesson = catalog.lessons.get(lessonId);
        const product = catalog.products.find(p => p.productId === productId);
        if (!lesson || !product || !pathsToRoot(lesson.parent, product.trainingId).length) continue;
        lessons.push(aiLesson(lesson, product, pathsToRoot(lesson.parent, product.trainingId)[0]));
      }
      return { courses: courses.map(p => ({ productId: p.productId, title: p.title })), lessons,
        ...ctx.meta(validUntil) };
    },
    async list(userId) {
      const ctx = await context(userId);
      const courses = catalog.products.filter(p => p.type === 'training' && ctx.grants.has(p.productId)).map(p => ({ productId: p.productId,
        title: p.title, lessonCount: summaries(p, ctx).length }));
      const until = Math.min(Date.parse(ctx.check.expiresAt), ...ctx.grants.values());
      return { courses, ...ctx.meta(until) };
    },
    async course(userId, productId) {
      const ctx = await context(userId), product = owned(productId, ctx);
      const sections = new Map();
      let validUntil = ctx.grants.get(productId);
      for (const [sid, rows] of siblings) {
        let path;
        const selected = rows.filter(l => {
          const access = readable(l, product, ctx);
          if (access) {
            validUntil = Math.min(validUntil, access.validUntil);
            path = access.sectionPath;
          }
          return access;
        });
        if (!selected.length) continue;
        // A folder with no direct lessons is visible only on an authorized lesson path.
        for (const [index, streamId] of path.entries()) {
          if (sections.has(streamId)) continue;
          sections.set(streamId, { streamId, parentStreamId: path[index - 1] ?? null,
            title: catalog.streams.get(streamId).title, lessons: [] });
        }
        if (streamPolicies.get(sid).reverseLessons) selected.reverse();
        sections.get(sid).lessons = selected.map(l => ({
          lessonId: l.id, title: l.title, hasVideo: l.hasVideo, hasText: l.hasText,
        }));
      }
      const children = new Map();
      for (const section of sections.values()) {
        const parentId = section.parentStreamId;
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(section);
      }
      const order = section => catalog.streams.get(section.streamId).parents
        .find(parent => parent.id === section.parentStreamId)?.order ?? 0;
      const ordered = parentId => (children.get(parentId) ?? [])
        .sort((a, b) => order(a) - order(b) || a.streamId - b.streamId)
        .flatMap(section => [section, ...ordered(section.streamId)]);
      const { accessEndsAt } = ctx.active.find(grant => grant.productId === productId);
      return { course: { productId, title: product.title, rootStreamId: product.trainingId,
        accessEndsAt: accessEndsAt === null ? null : new Date(accessEndsAt).toISOString(),
        sections: ordered(null) }, ...ctx.meta(validUntil) };
    },
    async lesson(userId, productId, lessonId) {
      // This exact lesson is free after the HTTP layer verifies sign-in and profile.
      // It does not depend on a GetCourse purchase or an external availability check.
      if (isFreeLesson(productId, lessonId)) {
        const lesson = catalog.lessons.get(lessonId);
        const product = catalog.products.find(p => p.productId === productId);
        if (!lesson || !product || !pathsToRoot(lesson.parent, product.trainingId).length) throw denied();
        const record = lessonStatement.get(lessonId);
        if (!record || digest(record.content_json) !== record.sha256 || record.sha256 !== lesson.contentHash) throw unavailable();
        const blocks = publicBlocks(JSON.parse(record.content_json), lessonId, record.sha256, videoLinks);
        const now = clock(), expires = new Date(now + 300_000).toISOString();
        return { lesson: { lessonId, productId, title: lesson.title, blocks, contentCopyDisabled: lessonPolicies.get(lessonId).disableCopy
            || streamPolicies.get(lesson.parent).disableCopyCurrent
            || pathsToRoot(lesson.parent, product.trainingId).some(path => path.some(sid => streamPolicies.get(sid).disableCopy)),
          videoAvailable: blocks.some(b => b.videos?.some(v => v.url !== null)),
          hasAssignment: lessonPolicies.get(lessonId).hasMission, assignmentAvailable: false },
          navigation: { productId, title: product.title, sections: [{ streamId: lesson.parent,
            title: catalog.streams.get(lesson.parent).title, lessons: [{ lessonId, title: lesson.title,
              hasVideo: lesson.hasVideo, hasText: lesson.hasText }] }] },
          checkedAt: new Date(now).toISOString(), serverTime: new Date(now).toISOString(),
          expiresAt: expires, validUntil: expires };
      }
      const ctx = await context(userId), product = owned(productId, ctx);
      const lesson = catalog.lessons.get(lessonId), access = lesson && readable(lesson, product, ctx);
      if (!access) throw denied();
      const record = lessonStatement.get(lessonId);
      if (!record || digest(record.content_json) !== record.sha256 || record.sha256 !== lesson.contentHash) throw unavailable();
      const sourceBlocks = publicBlocks(JSON.parse(record.content_json), lessonId, record.sha256, videoLinks);
      const blocks = webAppFaqLessonIds.has(lessonId)
        ? [{ type: 'text', text: '', html: webAppFaqHtml },
          ...sourceBlocks.filter(block => block.type === 'video'
            || (block.type === 'attachment' && lessonId !== 347472351))]
        : sourceBlocks;
      return { lesson: { lessonId, title: lesson.title, productId, blocks, contentCopyDisabled: access.contentCopyDisabled,
        videoAvailable: blocks.some(block => block.videos?.some(video => video.url !== null)),
        hasAssignment: lessonPolicies.get(lessonId).hasMission, assignmentAvailable: false },
        ...ctx.meta(access.validUntil) };
    },
  });
}
