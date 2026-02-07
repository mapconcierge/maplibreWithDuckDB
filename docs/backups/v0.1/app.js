import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.30.0/+esm";

const WORLD_GEOJSON_URL = "https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json";

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

function setStatus(message, cls = "") {
  statusEl.className = cls;
  statusEl.textContent = message;
}

function setResults(value) {
  if (typeof value === "string") {
    resultsEl.textContent = value;
    return;
  }
  resultsEl.textContent = JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2
  );
}

function hasRequiredBrowserFeatures() {
  return (
    typeof WebAssembly === "object" &&
    typeof Worker === "function" &&
    typeof fetch === "function" &&
    typeof Promise === "function"
  );
}

function initMap() {
  const map = new maplibregl.Map({
    container: "map",
    style: "https://demotiles.maplibre.org/style.json",
    center: [0, 20],
    zoom: 1.3,
    pitch: 0,
    bearing: 0,
    hash: true,
    attributionControl: true
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), "top-right");
  map.dragRotate.enable();
  map.touchZoomRotate.enableRotation();

  map.on("load", async () => {
    try {
      const response = await fetch(WORLD_GEOJSON_URL, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`GeoJSON fetch failed: ${response.status} ${response.statusText}`);
      }
      const worldGeoJSON = await response.json();

      map.addSource("world", {
        type: "geojson",
        data: worldGeoJSON
      });

      map.addLayer({
        id: "world-fill",
        type: "fill",
        source: "world",
        paint: {
          "fill-color": "#4f87c2",
          "fill-opacity": 0.24
        }
      });

      map.addLayer({
        id: "world-outline",
        type: "line",
        source: "world",
        paint: {
          "line-color": "#1f4e79",
          "line-width": 0.8
        }
      });
    } catch (err) {
      console.error(err);
      setStatus(`Map loaded, but world boundary overlay failed: ${err.message}`, "err");
    }
  });

  return map;
}

async function initDuckDBAndRunSpatialQuery() {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  const workerURL = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );

  const logger = new duckdb.ConsoleLogger();
  const worker = new Worker(workerURL);
  const db = new duckdb.AsyncDuckDB(logger, worker);

  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();

    await conn.query("INSTALL spatial;");
    await conn.query("LOAD spatial;");

    await conn.query(`
      CREATE OR REPLACE TEMP TABLE world_boundaries AS
      SELECT *
      FROM ST_Read('${WORLD_GEOJSON_URL}');
    `);

    const result = await conn.query(`
      SELECT
        COUNT(*) AS country_count,
        ROUND(SUM(ST_Area(geom))::DOUBLE, 2) AS total_area_units
      FROM world_boundaries;
    `);

    const rows = result.toArray().map((row) => row.toJSON());
    setStatus("Map ready. DuckDB spatial query completed.", "ok");
    setResults(rows);

    await conn.close();
  } finally {
    URL.revokeObjectURL(workerURL);
  }
}

async function main() {
  if (!hasRequiredBrowserFeatures()) {
    setStatus(
      "This browser is missing required features (WebAssembly, Worker, Fetch, Promise). Use a recent Chrome, Edge, Firefox, or Safari.",
      "err"
    );
    setResults("No query executed.");
    return;
  }

  try {
    initMap();
    setStatus("Map initialized. Starting DuckDB-Wasm spatial demo...");
    await initDuckDBAndRunSpatialQuery();
  } catch (err) {
    console.error(err);
    setStatus(`Initialization failed: ${err.message}`, "err");
    setResults("Check browser console for details. Common issue: extension/data URL blocked by CORS.");
  }
}

window.addEventListener("load", () => {
  void main();
});
