// Servidor ligero sin dependencias (Node 18+). Actúa de proxy del API MITECO (evita CORS),
// cachea los datos 15 min, calcula Haversine y devuelve los resultados ordenados por precio.
const http = require("http");
const fs = require("fs");
const path = require("path");

const API = "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";
const PORT = process.env.PORT || 3000;
const TTL = 15 * 60 * 1000;
const FUELS = {
  gasolina95: "Precio Gasolina 95 E5",
  gasolina98: "Precio Gasolina 98 E5",
  diesel: "Precio Gasoleo A",
  dieselPremium: "Precio Gasoleo Premium",
};

let cache = { at: 0, fecha: "", stations: [] };
let loading = null;

const num = (s) => {
  if (s == null || s === "") return null;
  const n = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

async function loadStations() {
  if (Date.now() - cache.at < TTL && cache.stations.length) return cache;
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(API, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error("MITECO respondió " + res.status);
      const data = await res.json();
      const stations = (data.ListaEESSPrecio || [])
        .map((e) => ({
          rotulo: e["Rótulo"] || "Sin rótulo",
          direccion: e["Dirección"],
          municipio: e["Municipio"],
          provincia: e["Provincia"],
          cp: e["C.P."],
          lat: num(e["Latitud"]),
          lon: num(e["Longitud (WGS84)"]),
          precios: Object.fromEntries(Object.entries(FUELS).map(([k, f]) => [k, num(e[f])])),
          _m: norm(e["Municipio"]),
        }))
        .filter((s) => s.lat !== null && s.lon !== null);
      cache = { at: Date.now(), fecha: data.Fecha || "", stations };
      return cache;
    } catch (err) {
      if (cache.stations.length) return cache; // sirve datos antiguos si falla
      throw err;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const mean = (arr, k) => arr.reduce((t, x) => t + x[k], 0) / arr.length;

// Resuelve el centro de búsqueda a partir del CP o municipio usando los propios datos (sin geocoder externo).
function resolveCenter(stations, q) {
  if (/^\d{5}$/.test(q)) {
    const m = stations.filter((s) => s.cp === q);
    if (!m.length) return null;
    return { lat: mean(m, "lat"), lon: mean(m, "lon"), label: `C.P. ${q} · ${m[0].municipio}` };
  }
  const n = norm(q);
  if (n.length < 3) return null;
  let m = stations.filter((s) => s._m === n);
  if (!m.length) m = stations.filter((s) => s._m.includes(n));
  if (!m.length) return null;
  const first = m[0]._m;
  m = m.filter((s) => s._m === first);
  return { lat: mean(m, "lat"), lon: mean(m, "lon"), label: `${m[0].municipio} (${m[0].provincia})` };
}

async function search(params) {
  const fuel = params.get("fuel") in FUELS ? params.get("fuel") : "gasolina95";
  const radius = Math.min(Math.max(Number(params.get("radius")) || 10, 1), 100);
  const { stations, fecha } = await loadStations();

  let center;
  const lat = parseFloat(params.get("lat")), lon = parseFloat(params.get("lon"));
  if (Number.isFinite(lat) && Number.isFinite(lon)) center = { lat, lon, label: "Tu ubicación" };
  else center = resolveCenter(stations, params.get("q") || "");
  if (!center) return { status: 404, body: { error: "No se encontró ese código postal o municipio." } };

  const results = stations
    .filter((s) => s.precios[fuel] !== null)
    .map((s) => ({ ...s, precio: s.precios[fuel], dist: haversine(center.lat, center.lon, s.lat, s.lon) }))
    .filter((s) => s.dist <= radius)
    .sort((a, b) => a.precio - b.precio || a.dist - b.dist)
    .slice(0, 50)
    .map(({ _m, precios, ...s }) => ({ ...s, dist: Math.round(s.dist * 10) / 10 }));

  return { status: 200, body: { center, fecha, total: results.length, results } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type + "; charset=utf-8" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (url.pathname === "/api/search") {
      const { status, body } = await search(url.searchParams);
      return send(status, body);
    }
    if (url.pathname === "/") {
      return send(200, fs.readFileSync(path.join(__dirname, "public", "index.html")), "text/html");
    }
    send(404, { error: "No encontrado" });
  } catch (err) {
    console.error(err);
    send(502, { error: "No se pudo obtener datos del Ministerio. Inténtalo de nuevo en unos minutos." });
  }
});

server.listen(PORT, () => console.log(`Gasolineras baratas en http://localhost:${PORT}`));
loadStations().catch(() => {}); // precarga
