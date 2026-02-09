    import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.30.0/+esm";
    import * as pmtiles from "https://cdn.jsdelivr.net/npm/pmtiles@3.2.1/dist/pmtiles.es.js";
    import * as GeoTIFF from "https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm";

    const state = {
      map: null,
      layers: [],
      idCounter: 0,
      db: null,
      conn: null,
      workerURL: null,
      pmtilesProtocol: null
    };

    const el = {
      dataType: document.getElementById("dataType"),
      layerName: document.getElementById("layerName"),
      urlInput: document.getElementById("urlInput"),
      sourceLayerInput: document.getElementById("sourceLayerInput"),
      fileInput: document.getElementById("fileInput"),
      addLayerBtn: document.getElementById("addLayerBtn"),
      clearFormBtn: document.getElementById("clearFormBtn"),
      status: document.getElementById("status"),
      queryOutput: document.getElementById("queryOutput"),
      layers: document.getElementById("layers")
    };

    const colorPalette = ["#3f8efc", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#14b8a6"];

    function setStatus(message, cls = "") {
      el.status.className = cls;
      el.status.textContent = message;
    }

    function setOutput(value) {
      const txt = typeof value === "string"
        ? value
        : JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
      el.queryOutput.textContent = txt;
    }

    function escapeSqlLiteral(value) {
      return value.replace(/'/g, "''");
    }

    function inferType(urlOrName = "") {
      const lower = urlOrName.toLowerCase();
      if (lower.endsWith(".pmtiles")) return "pmtiles";
      if (lower.endsWith(".geojson") || lower.endsWith(".json") || lower.endsWith(".gpkg") || lower.endsWith(".shp") || lower.endsWith(".zip")) return "geojson";
      if (lower.endsWith(".tif") || lower.endsWith(".tiff") || lower.includes("cog")) return "cog";
      if (lower.includes("{z}") && (lower.includes(".pbf") || lower.includes(".mvt") || lower.includes("tiles"))) return "mvt";
      return "geojson";
    }

    function isGeoJSONName(name = "") {
      const lower = name.toLowerCase();
      return lower.endsWith(".geojson") || lower.endsWith(".json");
    }

    function createLayerRecord({ name, kind, sourceId, mapLayerIds }) {
      const id = `lyr-${++state.idCounter}`;
      const rec = {
        id,
        name,
        kind,
        sourceId,
        mapLayerIds,
        visible: true
      };
      state.layers.push(rec);
      return rec;
    }

    function removeLayerRecord(id) {
      const idx = state.layers.findIndex((l) => l.id === id);
      if (idx >= 0) state.layers.splice(idx, 1);
    }

    function applyLayerOrder() {
      for (const layerRec of state.layers) {
        for (const mapLayerId of layerRec.mapLayerIds) {
          if (state.map.getLayer(mapLayerId)) {
            state.map.moveLayer(mapLayerId);
          }
        }
      }
    }

    function toggleLayerVisibility(layerRec, visible) {
      layerRec.visible = visible;
      for (const mapLayerId of layerRec.mapLayerIds) {
        if (state.map.getLayer(mapLayerId)) {
          state.map.setLayoutProperty(mapLayerId, "visibility", visible ? "visible" : "none");
        }
      }
    }

    function removeMapLayer(layerRec) {
      for (const mapLayerId of layerRec.mapLayerIds) {
        if (state.map.getLayer(mapLayerId)) {
          state.map.removeLayer(mapLayerId);
        }
      }
      if (state.map.getSource(layerRec.sourceId)) {
        state.map.removeSource(layerRec.sourceId);
      }
      removeLayerRecord(layerRec.id);
      renderLayerList();
      setStatus(`Removed layer: ${layerRec.name}`, "ok");
    }

    function renderLayerList() {
      el.layers.innerHTML = "";
      if (!state.layers.length) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "No layers added.";
        el.layers.appendChild(li);
        return;
      }

      state.layers.forEach((layerRec, index) => {
        const li = document.createElement("li");
        li.className = "layer-item";

        const head = document.createElement("div");
        head.className = "layer-head";

        const nameWrap = document.createElement("div");
        const name = document.createElement("div");
        name.className = "layer-name";
        name.textContent = layerRec.name;
        const meta = document.createElement("div");
        meta.className = "layer-meta";
        meta.textContent = `${layerRec.kind} · ${layerRec.mapLayerIds.length} style layer(s)`;
        nameWrap.appendChild(name);
        nameWrap.appendChild(meta);

        const controls = document.createElement("div");
        controls.className = "controls";

        const visible = document.createElement("input");
        visible.type = "checkbox";
        visible.checked = layerRec.visible;
        visible.title = "Toggle on/off";
        visible.addEventListener("change", () => toggleLayerVisibility(layerRec, visible.checked));

        const up = document.createElement("button");
        up.className = "secondary";
        up.textContent = "Up";
        up.disabled = index === 0;
        up.addEventListener("click", () => {
          if (index === 0) return;
          [state.layers[index - 1], state.layers[index]] = [state.layers[index], state.layers[index - 1]];
          renderLayerList();
          applyLayerOrder();
        });

        const down = document.createElement("button");
        down.className = "secondary";
        down.textContent = "Down";
        down.disabled = index === state.layers.length - 1;
        down.addEventListener("click", () => {
          if (index === state.layers.length - 1) return;
          [state.layers[index + 1], state.layers[index]] = [state.layers[index], state.layers[index + 1]];
          renderLayerList();
          applyLayerOrder();
        });

        const remove = document.createElement("button");
        remove.className = "secondary";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => removeMapLayer(layerRec));

        controls.appendChild(visible);
        controls.appendChild(up);
        controls.appendChild(down);
        controls.appendChild(remove);

        head.appendChild(nameWrap);
        head.appendChild(controls);
        li.appendChild(head);
        el.layers.appendChild(li);
      });
    }

    function computeGeoJSONBounds(geojson) {
      const bounds = new maplibregl.LngLatBounds();

      function walkCoords(coords) {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0] === "number" && typeof coords[1] === "number") {
          bounds.extend([coords[0], coords[1]]);
          return;
        }
        for (const c of coords) walkCoords(c);
      }

      if (geojson.type === "FeatureCollection") {
        for (const f of geojson.features) {
          if (f.geometry) walkCoords(f.geometry.coordinates);
        }
      } else if (geojson.type === "Feature") {
        if (geojson.geometry) walkCoords(geojson.geometry.coordinates);
      } else {
        walkCoords(geojson.coordinates);
      }

      return bounds;
    }

    function addGeoJSONToMap(geojson, layerName) {
      const idx = state.layers.length % colorPalette.length;
      const color = colorPalette[idx];
      const sourceId = `src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const mapLayerIds = [];

      state.map.addSource(sourceId, { type: "geojson", data: geojson });

      const fillId = `${sourceId}-fill`;
      state.map.addLayer({
        id: fillId,
        type: "fill",
        source: sourceId,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": color, "fill-opacity": 0.25 }
      });
      mapLayerIds.push(fillId);

      const lineId = `${sourceId}-line`;
      state.map.addLayer({
        id: lineId,
        type: "line",
        source: sourceId,
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "Polygon", "MultiPolygon", "MultiLineString"]]],
        paint: { "line-color": color, "line-width": 1.4 }
      });
      mapLayerIds.push(lineId);

      const circleId = `${sourceId}-circle`;
      state.map.addLayer({
        id: circleId,
        type: "circle",
        source: sourceId,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        paint: {
          "circle-radius": 4,
          "circle-color": color,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff"
        }
      });
      mapLayerIds.push(circleId);

      const rec = createLayerRecord({ name: layerName, kind: "vector", sourceId, mapLayerIds });
      renderLayerList();
      applyLayerOrder();

      const bounds = computeGeoJSONBounds(geojson);
      if (!bounds.isEmpty()) {
        state.map.fitBounds(bounds, { padding: 40, duration: 600 });
      }

      return rec;
    }

    async function readVectorWithDuckDB(pathForRead, displayName) {
      if (!state.conn) throw new Error("DuckDB is not initialized.");

      const candidatePaths = pathForRead.startsWith("/")
        ? [pathForRead]
        : [pathForRead, `/${pathForRead}`];
      let lastErr = null;

      for (const pathCandidate of candidatePaths) {
        try {
          const pathSql = escapeSqlLiteral(pathCandidate);
          const summary = await state.conn.query(`
            SELECT
              COUNT(*) AS feature_count,
              MIN(ST_XMin(geom)) AS minx,
              MIN(ST_YMin(geom)) AS miny,
              MAX(ST_XMax(geom)) AS maxx,
              MAX(ST_YMax(geom)) AS maxy
            FROM ST_Read('${pathSql}');
          `);

          const rows = summary.toArray().map((r) => r.toJSON());
          setOutput({ dataset: displayName, summary: rows[0] || {}, path_used: pathCandidate });

          const featuresRes = await state.conn.query(`
            SELECT ST_AsGeoJSON(geom) AS geom_json
            FROM ST_Read('${pathSql}')
            LIMIT 50000;
          `);

          const features = featuresRes.toArray().map((r) => {
            const obj = r.toJSON();
            return {
              type: "Feature",
              properties: {},
              geometry: JSON.parse(obj.geom_json)
            };
          });

          return {
            type: "FeatureCollection",
            features
          };
        } catch (err) {
          lastErr = err;
        }
      }

      throw lastErr || new Error("ST_Read failed for all path candidates.");
    }

    async function registerUploadFiles(files) {
      for (const file of files) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        await state.db.registerFileBuffer(file.name, buffer);
      }
    }

    function getShapefileMain(files) {
      const shp = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
      return shp ? shp.name : null;
    }

    async function readGeoJSONFileDirect(file) {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") {
        throw new Error("GeoJSON parse returned invalid object.");
      }
      if (!data.type) {
        throw new Error("GeoJSON is missing top-level type.");
      }
      return data;
    }

    async function addVectorFromFiles(files, desiredName) {
      const geojsonFile = files.find((f) => isGeoJSONName(f.name));
      if (geojsonFile) {
        const geojson = await readGeoJSONFileDirect(geojsonFile);
        addGeoJSONToMap(geojson, desiredName || geojsonFile.name);
        const featureCount = Array.isArray(geojson.features) ? geojson.features.length : null;
        setOutput({
          dataset: desiredName || geojsonFile.name,
          method: "direct_geojson_parse",
          feature_count: featureCount
        });
        setStatus(`Loaded GeoJSON file: ${desiredName || geojsonFile.name}`, "ok");
        return;
      }

      await registerUploadFiles(files);
      const shpMain = getShapefileMain(files);
      const primary = shpMain || files[0].name;
      const geojson = await readVectorWithDuckDB(primary, desiredName || primary);
      addGeoJSONToMap(geojson, desiredName || primary);
      setStatus(`Loaded vector layer with DuckDB ST_Read: ${desiredName || primary}`, "ok");
    }

    async function addVectorFromUrl(url, desiredName) {
      const geojson = await readVectorWithDuckDB(url, desiredName || url);
      addGeoJSONToMap(geojson, desiredName || url);
      setStatus(`Loaded vector URL with DuckDB ST_Read: ${desiredName || url}`, "ok");
    }

    async function addPMTilesLayer(url, desiredName) {
      const p = new pmtiles.PMTiles(url);
      state.pmtilesProtocol.add(p);
      const metadata = await p.getMetadata();
      const sourceId = `src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const mapLayerIds = [];

      state.map.addSource(sourceId, {
        type: "vector",
        url: `pmtiles://${url}`
      });

      const vectorLayers = Array.isArray(metadata.vector_layers) ? metadata.vector_layers : [];
      const list = vectorLayers.length ? vectorLayers.map((v) => v.id) : ["layer0"];
      const color = colorPalette[state.layers.length % colorPalette.length];

      for (const srcLayer of list) {
        const fillId = `${sourceId}-${srcLayer}-fill`;
        state.map.addLayer({
          id: fillId,
          type: "fill",
          source: sourceId,
          "source-layer": srcLayer,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": color, "fill-opacity": 0.25 }
        });
        mapLayerIds.push(fillId);

        const lineId = `${sourceId}-${srcLayer}-line`;
        state.map.addLayer({
          id: lineId,
          type: "line",
          source: sourceId,
          "source-layer": srcLayer,
          filter: ["in", ["geometry-type"], ["literal", ["LineString", "Polygon", "MultiPolygon", "MultiLineString"]]],
          paint: { "line-color": color, "line-width": 1.2 }
        });
        mapLayerIds.push(lineId);

        const circleId = `${sourceId}-${srcLayer}-circle`;
        state.map.addLayer({
          id: circleId,
          type: "circle",
          source: sourceId,
          "source-layer": srcLayer,
          filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
          paint: { "circle-radius": 3, "circle-color": color }
        });
        mapLayerIds.push(circleId);
      }

      createLayerRecord({
        name: desiredName || metadata.name || url,
        kind: "pmtiles",
        sourceId,
        mapLayerIds
      });

      renderLayerList();
      applyLayerOrder();
      setOutput({ pmtiles: desiredName || url, vector_layers: list });
      setStatus(`Loaded PMTiles: ${desiredName || url}`, "ok");
    }

    async function addMVTLayer(urlTemplate, sourceLayer, desiredName) {
      if (!sourceLayer) {
        throw new Error("MVT source-layer is required.");
      }

      const sourceId = `src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const mapLayerIds = [];
      const color = colorPalette[state.layers.length % colorPalette.length];

      state.map.addSource(sourceId, {
        type: "vector",
        tiles: [urlTemplate],
        minzoom: 0,
        maxzoom: 14
      });

      const fillId = `${sourceId}-fill`;
      state.map.addLayer({
        id: fillId,
        type: "fill",
        source: sourceId,
        "source-layer": sourceLayer,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": color, "fill-opacity": 0.24 }
      });
      mapLayerIds.push(fillId);

      const lineId = `${sourceId}-line`;
      state.map.addLayer({
        id: lineId,
        type: "line",
        source: sourceId,
        "source-layer": sourceLayer,
        filter: ["in", ["geometry-type"], ["literal", ["LineString", "Polygon", "MultiPolygon", "MultiLineString"]]],
        paint: { "line-color": color, "line-width": 1.3 }
      });
      mapLayerIds.push(lineId);

      const circleId = `${sourceId}-circle`;
      state.map.addLayer({
        id: circleId,
        type: "circle",
        source: sourceId,
        "source-layer": sourceLayer,
        filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
        paint: { "circle-radius": 3.5, "circle-color": color }
      });
      mapLayerIds.push(circleId);

      createLayerRecord({
        name: desiredName || `MVT:${sourceLayer}`,
        kind: "mvt",
        sourceId,
        mapLayerIds
      });

      renderLayerList();
      applyLayerOrder();
      setOutput({ mvt: urlTemplate, sourceLayer });
      setStatus(`Loaded MVT layer: ${desiredName || sourceLayer}`, "ok");
    }

    function normalizeBandValue(value, min, max) {
      if (max <= min) return 0;
      return Math.max(0, Math.min(255, Math.round(((value - min) / (max - min)) * 255)));
    }

    async function readCogAsImageSource(input, isUrl) {
      const tiff = isUrl ? await GeoTIFF.fromUrl(input) : await GeoTIFF.fromArrayBuffer(await input.arrayBuffer());
      const image = await tiff.getImage();
      const width = image.getWidth();
      const height = image.getHeight();
      const samplesPerPixel = image.getSamplesPerPixel();

      const maxDim = 1024;
      const scale = Math.max(width, height) > maxDim ? maxDim / Math.max(width, height) : 1;
      const outWidth = Math.max(1, Math.round(width * scale));
      const outHeight = Math.max(1, Math.round(height * scale));

      const sampleList = samplesPerPixel >= 3 ? [0, 1, 2] : [0];
      const rasters = await image.readRasters({
        interleave: true,
        width: outWidth,
        height: outHeight,
        samples: sampleList
      });

      const canvas = document.createElement("canvas");
      canvas.width = outWidth;
      canvas.height = outHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const imageData = ctx.createImageData(outWidth, outHeight);
      const data = imageData.data;

      if (sampleList.length === 1) {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < rasters.length; i++) {
          const v = rasters[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        for (let i = 0, p = 0; i < rasters.length; i++, p += 4) {
          const g = normalizeBandValue(rasters[i], min, max);
          data[p] = g;
          data[p + 1] = g;
          data[p + 2] = g;
          data[p + 3] = 255;
        }
      } else {
        let minR = Number.POSITIVE_INFINITY;
        let maxR = Number.NEGATIVE_INFINITY;
        let minG = Number.POSITIVE_INFINITY;
        let maxG = Number.NEGATIVE_INFINITY;
        let minB = Number.POSITIVE_INFINITY;
        let maxB = Number.NEGATIVE_INFINITY;

        for (let i = 0; i < rasters.length; i += 3) {
          const r = rasters[i];
          const g = rasters[i + 1];
          const b = rasters[i + 2];
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (g < minG) minG = g;
          if (g > maxG) maxG = g;
          if (b < minB) minB = b;
          if (b > maxB) maxB = b;
        }

        for (let i = 0, p = 0; i < rasters.length; i += 3, p += 4) {
          data[p] = normalizeBandValue(rasters[i], minR, maxR);
          data[p + 1] = normalizeBandValue(rasters[i + 1], minG, maxG);
          data[p + 2] = normalizeBandValue(rasters[i + 2], minB, maxB);
          data[p + 3] = 255;
        }
      }

      ctx.putImageData(imageData, 0, 0);

      const tiePoints = image.getTiePoints();
      const fileDirectory = image.getFileDirectory();
      const modelPixelScale = fileDirectory.ModelPixelScale;

      if (!tiePoints.length || !modelPixelScale) {
        throw new Error("COG is missing georeferencing tags (ModelTiepoint/ModelPixelScale).");
      }

      const tp = tiePoints[0];
      const scaleX = modelPixelScale[0];
      const scaleY = modelPixelScale[1];
      const originX = tp.x - tp.i * scaleX;
      const originY = tp.y - tp.j * scaleY;

      const minX = originX;
      const maxY = originY;
      const maxX = originX + width * scaleX;
      const minY = originY - height * scaleY;

      return {
        imageURL: canvas.toDataURL("image/png"),
        coordinates: [
          [minX, maxY],
          [maxX, maxY],
          [maxX, minY],
          [minX, minY]
        ],
        bounds: [[minX, minY], [maxX, maxY]],
        width,
        height,
        samplesPerPixel
      };
    }

    async function addCOGLayer(input, isUrl, desiredName) {
      const cog = await readCogAsImageSource(input, isUrl);
      const sourceId = `src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const layerId = `${sourceId}-raster`;

      state.map.addSource(sourceId, {
        type: "image",
        url: cog.imageURL,
        coordinates: cog.coordinates
      });

      state.map.addLayer({
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: {
          "raster-opacity": 0.85,
          "raster-resampling": "linear"
        }
      });

      createLayerRecord({
        name: desiredName,
        kind: "cog",
        sourceId,
        mapLayerIds: [layerId]
      });

      renderLayerList();
      applyLayerOrder();
      state.map.fitBounds(cog.bounds, { padding: 40, duration: 700 });
      setOutput({ cog: desiredName, width: cog.width, height: cog.height, samples: cog.samplesPerPixel });
      setStatus(`Loaded COG preview: ${desiredName}`, "ok");
    }

    async function handleAddLayer() {
      const url = el.urlInput.value.trim();
      const files = Array.from(el.fileInput.files || []);
      const manualName = el.layerName.value.trim();
      const sourceLayer = el.sourceLayerInput.value.trim();
      const selectedType = el.dataType.value;

      if (!url && !files.length) {
        throw new Error("Provide a URL or upload at least one file.");
      }

      const inferred = selectedType === "auto"
        ? inferType(url || (files[0] ? files[0].name : ""))
        : selectedType;

      if (inferred === "pmtiles") {
        const targetUrl = url || (files[0] ? URL.createObjectURL(files[0]) : "");
        if (!targetUrl) throw new Error("PMTiles needs a URL or .pmtiles upload.");
        await addPMTilesLayer(targetUrl, manualName || (files[0]?.name || targetUrl));
        return;
      }

      if (inferred === "mvt") {
        if (!url) throw new Error("MVT requires a URL template.");
        await addMVTLayer(url, sourceLayer, manualName || "MVT Layer");
        return;
      }

      if (inferred === "cog") {
        if (files.length) {
          await addCOGLayer(files[0], false, manualName || files[0].name);
        } else {
          await addCOGLayer(url, true, manualName || url);
        }
        return;
      }

      if (files.length) {
        await addVectorFromFiles(files, manualName || files[0].name);
      } else {
        await addVectorFromUrl(url, manualName || url);
      }
    }

    async function initDuckDB() {
      const bundles = duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(bundles);

      state.workerURL = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
      );

      const worker = new Worker(state.workerURL);
      state.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
      await state.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      state.conn = await state.db.connect();

      try {
        await state.conn.query("LOAD spatial;");
      } catch (_loadErr) {
        await state.conn.query("INSTALL spatial;");
        await state.conn.query("LOAD spatial;");
      }
    }

    function initMap() {
      state.map = new maplibregl.Map({
        container: "map",
        style: "https://demotiles.maplibre.org/style.json",
        center: [139.76, 35.68],
        zoom: 3,
        bearing: 0,
        pitch: 0,
        attributionControl: true
      });

      state.map.addControl(new maplibregl.NavigationControl({ showZoom: true, showCompass: true }), "top-right");
      state.map.dragRotate.enable();
      state.map.touchZoomRotate.enableRotation();

      state.pmtilesProtocol = new pmtiles.Protocol();
      maplibregl.addProtocol("pmtiles", state.pmtilesProtocol.tile);
    }

    function clearForm() {
      el.urlInput.value = "";
      el.fileInput.value = "";
      el.layerName.value = "";
      el.sourceLayerInput.value = "";
      el.dataType.value = "auto";
    }

    function hasRequiredFeatures() {
      return (
        typeof WebAssembly === "object" &&
        typeof Worker === "function" &&
        typeof Promise === "function" &&
        typeof fetch === "function"
      );
    }

    async function bootstrap() {
      if (!hasRequiredFeatures()) {
        setStatus("This browser lacks required APIs (WebAssembly, Worker, Fetch, Promise).", "err");
        return;
      }

      initMap();
      renderLayerList();
      setStatus("Map initialized. Loading DuckDB-Wasm spatial extension...");

      try {
        await initDuckDB();
        setStatus("Ready. Add URL/files to create map layers.", "ok");
        setOutput("DuckDB Spatial is ready. Use ST_Read via UI for local/remote vector files.");
      } catch (err) {
        console.error(err);
        setStatus(`DuckDB init failed: ${err.message}`, "err");
        setOutput("DuckDB failed to initialize. Check CORS or extension download restrictions.");
      }

      el.addLayerBtn.addEventListener("click", async () => {
        el.addLayerBtn.disabled = true;
        try {
          await handleAddLayer();
        } catch (err) {
          console.error(err);
          setStatus(`Add layer failed: ${err.message}`, "err");
        } finally {
          el.addLayerBtn.disabled = false;
        }
      });

      el.clearFormBtn.addEventListener("click", clearForm);

      window.addEventListener("beforeunload", () => {
        if (state.workerURL) URL.revokeObjectURL(state.workerURL);
      });
    }

    window.addEventListener("load", () => {
      void bootstrap();
    });
