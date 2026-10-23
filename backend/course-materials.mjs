import { createHash } from 'node:crypto';
import { activeCourseProducts, parseGetCourseDate } from './course-entitlements.mjs';
import { AuthError } from './auth/security.mjs';

const id = v => Number.isSafeInteger(v) && v > 0;
const digest = s => createHash('sha256').update(s).digest('hex');
const unavailable = () => new AuthError(503, 'course_materials_unavailable', 'Материалы курсов временно недоступны. Попробуйте ещё раз.');
const denied = () => new AuthError(403, 'course_access_required', 'Нет подтверждённого доступа к этому материалу.');
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

function publicBlocks(content) {
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
    return ['video', 'image', 'attachment'].includes(block.type) ? { type: block.type, text }
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
    return { check, now, grants, available, answers, meta };
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
    return { validUntil: access.validUntil, contentCopyDisabled: p.disableCopy || sp.disableCopyCurrent
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
  return Object.freeze({
    async list(userId) {
      const ctx = await context(userId);
      const courses = catalog.products.filter(p => p.type === 'training' && ctx.grants.has(p.productId)).map(p => ({ productId: p.productId,
        title: p.title, lessonCount: summaries(p, ctx).length }));
      const until = Math.min(Date.parse(ctx.check.expiresAt), ...ctx.grants.values());
      return { courses, ...ctx.meta(until) };
    },
    async course(userId, productId) {
      const ctx = await context(userId), product = owned(productId, ctx);
      const sections = [];
      let validUntil = ctx.grants.get(productId);
      for (const [sid, rows] of siblings) {
        const selected = rows.filter(l => {
          const access = readable(l, product, ctx);
          if (access) validUntil = Math.min(validUntil, access.validUntil);
          return access;
        });
        if (!selected.length) continue;
        if (streamPolicies.get(sid).reverseLessons) selected.reverse();
        sections.push({ streamId: sid, title: catalog.streams.get(sid).title,
          lessons: selected.map(l => ({ lessonId: l.id, title: l.title, hasVideo: l.hasVideo, hasText: l.hasText })) });
      }
      return { course: { productId, title: product.title, sections }, ...ctx.meta(validUntil) };
    },
    async lesson(userId, productId, lessonId) {
      const ctx = await context(userId), product = owned(productId, ctx);
      const lesson = catalog.lessons.get(lessonId), access = lesson && readable(lesson, product, ctx);
      if (!access) throw denied();
      const record = lessonStatement.get(lessonId);
      if (!record || digest(record.content_json) !== record.sha256 || record.sha256 !== lesson.contentHash) throw unavailable();
      const blocks = publicBlocks(JSON.parse(record.content_json));
      return { lesson: { lessonId, title: lesson.title, productId, blocks, contentCopyDisabled: access.contentCopyDisabled,
        videoAvailable: false, hasAssignment: lessonPolicies.get(lessonId).hasMission, assignmentAvailable: false },
        ...ctx.meta(access.validUntil) };
    },
  });
}
