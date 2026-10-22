const displayNames = new Map([
  [8835218, 'Экспресс'],
  [8835266, 'Все включено'],
  [8835331, 'ПРОФИ'],
]);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;

export function validateCourseOffers(source) {
  if (!isRecord(source) || source.currency !== 'RUB' || !Array.isArray(source.products) || !Array.isArray(source.offers)) throw new Error('Invalid course offer source');
  const products = new Map();
  for (const product of source.products) {
    if (!isRecord(product) || !positiveId(product.productId) || products.has(product.productId) ||
        typeof product.name !== 'string' || !product.name.trim()) throw new Error('Invalid or duplicate product');
    const type = positiveId(product.trainingId) ? 'training' : positiveId(product.groupId) ? 'groups' : null;
    if (!type || (product.trainingId != null && product.groupId != null)) throw new Error(`Unknown product type ${product.productId}`);
    products.set(product.productId, { productId: product.productId, title: product.name.trim(), type });
  }
  const offers = [];
  const seen = new Set();
  for (const offer of source.offers) {
    if (!isRecord(offer) || !displayNames.has(offer.offerId) || seen.has(offer.offerId) ||
        typeof offer.name !== 'string' || !offer.name.includes(displayNames.get(offer.offerId)) ||
        !Number.isSafeInteger(offer.price) || offer.price < 0 || !Array.isArray(offer.items) || !offer.items.length) throw new Error('Invalid or duplicate offer');
    seen.add(offer.offerId);
    const itemIds = new Set();
    const items = offer.items.map((item, position) => {
      if (!isRecord(item) || !positiveId(item.productId) || !products.has(item.productId) ||
          itemIds.has(item.productId) || !Number.isSafeInteger(item.accessDays) || item.accessDays <= 0) throw new Error(`Invalid item in offer ${offer.offerId}`);
      itemIds.add(item.productId);
      return { ...products.get(item.productId), accessDays: item.accessDays, position };
    });
    offers.push({ offerId: offer.offerId, displayName: displayNames.get(offer.offerId), price: offer.price, currency: source.currency, position: offers.length, items });
  }
  if (seen.size !== displayNames.size) throw new Error('Expected all three application offers');
  return { products: [...products.values()], offers };
}

export function importCourseOffers(db, source) {
  const catalog = validateCourseOffers(source);
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS course_products (
        product_id INTEGER PRIMARY KEY CHECK(product_id > 0),
        title TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('training','groups'))
      );
      CREATE TABLE IF NOT EXISTS course_offers (
        offer_id INTEGER PRIMARY KEY CHECK(offer_id > 0),
        display_name TEXT NOT NULL,
        position INTEGER NOT NULL UNIQUE CHECK(position >= 0),
        price INTEGER NOT NULL CHECK(price >= 0),
        currency TEXT NOT NULL CHECK(currency = 'RUB')
      );
      CREATE TABLE IF NOT EXISTS course_offer_items (
        offer_id INTEGER NOT NULL REFERENCES course_offers(offer_id),
        product_id INTEGER NOT NULL REFERENCES course_products(product_id),
        position INTEGER NOT NULL CHECK(position >= 0),
        access_days INTEGER NOT NULL CHECK(access_days > 0),
        PRIMARY KEY(offer_id, product_id),
        UNIQUE(offer_id, position)
      );
    `);
    db.exec('DELETE FROM course_offer_items; DELETE FROM course_offers; DELETE FROM course_products;');
    const insertProduct = db.prepare('INSERT INTO course_products(product_id,title,type) VALUES(?,?,?)');
    const insertOffer = db.prepare('INSERT INTO course_offers(offer_id,display_name,position,price,currency) VALUES(?,?,?,?,?)');
    const insertItem = db.prepare('INSERT INTO course_offer_items(offer_id,product_id,position,access_days) VALUES(?,?,?,?)');
    for (const product of catalog.products) insertProduct.run(product.productId, product.title, product.type);
    for (const offer of catalog.offers) {
      insertOffer.run(offer.offerId, offer.displayName, offer.position, offer.price, offer.currency);
      for (const item of offer.items) insertItem.run(offer.offerId, item.productId, item.position, item.accessDays);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { offers: catalog.offers.length, products: catalog.products.length, items: catalog.offers.reduce((sum, offer) => sum + offer.items.length, 0) };
}

export function readCourseOffers(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('course_offers','course_products','course_offer_items')").all();
  if (tables.length !== 3) return null;
  const offers = db.prepare('SELECT offer_id,display_name,price,currency FROM course_offers ORDER BY position').all();
  if (!offers.length) return null;
  const items = db.prepare(`SELECT i.offer_id,p.product_id,p.title,p.type,i.access_days
    FROM course_offer_items i JOIN course_products p ON p.product_id=i.product_id
    ORDER BY i.offer_id,i.position`).all();
  return { offers: offers.map(offer => ({
    offerId: offer.offer_id,
    displayName: offer.display_name,
    price: offer.price,
    currency: offer.currency,
    items: items.filter(item => item.offer_id === offer.offer_id).map(item => ({
      productId: item.product_id, title: item.title, type: item.type, accessDays: item.access_days,
    })),
  })) };
}
