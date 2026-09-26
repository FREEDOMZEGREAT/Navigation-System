const connectDB = require('../config/database');
const POI = require('../models/POI');
const allPois = require('../data/all_pois');

// Map source categories to POI model enum
function mapCategory(cat) {
  if (!cat) return 'services';
  const c = String(cat).toLowerCase();
  if (c.includes('academic') || c.includes('block')) return 'academic';
  if (c.includes('admin') || c.includes('administrative')) return 'administrative';
  if (c.includes('residen') || c.includes('dorm')) return 'residential';
  if (c.includes('service') || c.includes('clinic') || c.includes('cafeteria') || c.includes('library')) return 'services';
  if (c.includes('recreat') || c.includes('student center') || c.includes('auditorium')) return 'recreational';
  if (c === 'entrance') return 'services';
  return 'services';
}

async function seed() {
  try {
    await connectDB();
    console.log('Connected to DB — starting POI seed');

    let inserted = 0;
    for (const p of allPois) {
      const doc = {
        name: p.name || p.id || 'Unnamed POI',
        description: p.description || '',
        building: p.building || (p.name || p.id),
        category: mapCategory(p.category),
        latitude: Number(p.latitude) || Number(p.lat) || 0,
        longitude: Number(p.longitude) || Number(p.lng) || 0,
        floor: p.floor || p.room || undefined,
        room: p.room || undefined,
        opening_hours: p.opening_hours || undefined,
        tags: Array.isArray(p.tags) ? p.tags : [],
        isActive: p.isActive !== undefined ? p.isActive : true,
        translations: p.translations || {},
        location: { type: 'Point', coordinates: [(Number(p.longitude) || 0), (Number(p.latitude) || 0)] }
      };

      // Upsert by name to avoid duplicates
      await POI.findOneAndUpdate({ name: doc.name }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
      inserted += 1;
    }

    console.log(`Seed complete — processed ${inserted} POIs`);
    process.exit(0);
  } catch (err) {
    console.error('POI seed failed', err);
    process.exit(1);
  }
}

seed();
