// One-shot seed of the perennial topic verticals. Re-running is safe — the
// upsert keys on slug, so labels/keywords get refreshed but IDs stay stable.
import { getDb, closeDb } from '../src/db/client.js';
import { canonicalizeKeywords } from '../src/ai/topics.js';

interface EvergreenSeed {
  slug: string;
  label: string;
  description: string;
  keywords: string[];
}

const evergreens: EvergreenSeed[] = [
  {
    slug: 'politica',
    label: 'Política',
    description: 'Gobierno nacional, parlamento, partidos políticos, elecciones, legislación.',
    keywords: ['gobierno', 'parlamento', 'presidencia', 'ministerio', 'partidos', 'frente amplio', 'partido nacional', 'partido colorado', 'cabildo abierto'],
  },
  {
    slug: 'elecciones',
    label: 'Elecciones',
    description: 'Procesos electorales nacionales, departamentales y partidarios.',
    keywords: ['elecciones', 'campaña', 'votación', 'candidatos', 'corte electoral', 'internas', 'balotaje', 'plebiscito'],
  },
  {
    slug: 'economia',
    label: 'Economía',
    description: 'Macroeconomía, finanzas públicas, dólar, inflación, comercio exterior.',
    keywords: ['economía', 'inflación', 'dólar', 'pbi', 'mef', 'bcu', 'recaudación', 'presupuesto', 'comercio exterior', 'mercosur'],
  },
  {
    slug: 'seguridad',
    label: 'Seguridad',
    description: 'Inseguridad, delitos, policía, narcotráfico, sistema penitenciario.',
    keywords: ['seguridad', 'policía', 'delito', 'rapiña', 'homicidio', 'narcotráfico', 'cárcel', 'ministerio del interior'],
  },
  {
    slug: 'educacion',
    label: 'Educación',
    description: 'Sistema educativo, ANEP, UDELAR, escuelas, liceos, universidad.',
    keywords: ['educación', 'anep', 'udelar', 'escuela', 'liceo', 'universidad', 'docentes', 'estudiantes', 'ces'],
  },
  {
    slug: 'salud',
    label: 'Salud',
    description: 'Sistema de salud, ASSE, mutualistas, salud pública, pandemia.',
    keywords: ['salud', 'asse', 'mutualista', 'msp', 'hospital', 'pandemia', 'vacuna', 'fonasa'],
  },
  {
    slug: 'sociedad',
    label: 'Sociedad',
    description: 'Asuntos sociales, derechos, vivienda, género, diversidad, minorías.',
    keywords: ['sociedad', 'mides', 'vivienda', 'género', 'feminicidio', 'lgbt', 'derechos humanos', 'discriminación'],
  },
  {
    slug: 'internacional',
    label: 'Internacional',
    description: 'Política y noticias internacionales, mercosur, vecinos, mundo.',
    keywords: ['internacional', 'argentina', 'brasil', 'mercosur', 'estados unidos', 'china', 'unión europea', 'naciones unidas'],
  },
  {
    slug: 'deportes',
    label: 'Deportes',
    description: 'Fútbol uruguayo, selección, deportes en general.',
    keywords: ['fútbol', 'peñarol', 'nacional', 'selección', 'celeste', 'auf', 'libertadores', 'basket', 'rugby'],
  },
  {
    slug: 'cultura',
    label: 'Cultura',
    description: 'Cultura, espectáculos, música, cine, literatura, premios.',
    keywords: ['cultura', 'cine', 'música', 'teatro', 'literatura', 'carnaval', 'murga', 'candombe', 'sodre'],
  },
  {
    slug: 'clima',
    label: 'Clima',
    description: 'Pronóstico, eventos meteorológicos, sequías, inundaciones, ambiente.',
    keywords: ['clima', 'tiempo', 'inumet', 'sequía', 'inundación', 'tormenta', 'alerta meteorológica', 'temperatura'],
  },
  {
    slug: 'tecnologia',
    label: 'Tecnología',
    description: 'Tecnología, ciencia, innovación, internet, startups uruguayas.',
    keywords: ['tecnología', 'ciencia', 'startup', 'internet', 'antel', 'ceibal', 'inteligencia artificial', 'agesic'],
  },
];

function main(): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO topics (slug, label, description, keywords_json, parent_topic_id, scope, first_seen_at, last_seen_at, status)
    VALUES (@slug, @label, @description, @keywords_json, NULL, 'evergreen', @now, @now, 'active')
    ON CONFLICT(slug) DO UPDATE SET
      label         = excluded.label,
      description   = excluded.description,
      keywords_json = excluded.keywords_json,
      last_seen_at  = excluded.last_seen_at,
      status        = 'active'
  `);

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const e of evergreens) {
      insert.run({
        slug: e.slug,
        label: e.label,
        description: e.description,
        keywords_json: JSON.stringify(canonicalizeKeywords(e.keywords)),
        now,
      });
    }
  });
  tx();
  console.log(`[seed-evergreen] Synced ${evergreens.length} evergreen topics.`);
  closeDb();
}

main();
