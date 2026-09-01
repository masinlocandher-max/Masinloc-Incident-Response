/* A small slippy map for the response consoles.

   WHY THIS EXISTS RATHER THAN A LIBRARY. The site's Content-Security-Policy is
   script-src 'self' — no CDN — so a map library would have to be vendored into
   the repository. For what these consoles need (a tile backdrop, a pin per
   incident, pan and zoom) that is a hundred kilobytes of dependency for about
   a hundred lines of Web Mercator arithmetic. Tiles themselves are <img>
   loads, which img-src already permits, so nothing here needs a policy change.

   WHAT IT REFUSES TO DO. It never invents a position. A marker sits exactly
   where the last received fix put it and does not drift, animate towards
   anything, or interpolate between updates. When updates stop, the marker
   freezes and the incident is labelled LAST KNOWN LOCATION — the caller owns
   that wording, and this module simply never contradicts it. A map that
   smooths a stale position into apparent movement would be telling a
   responder something nobody reported.

   Offline it degrades honestly: tiles fail, the backdrop goes flat, and a
   notice says the basemap could not load. Markers keep their real positions,
   because those came from the incident record and not from the network.
*/

const TILE = 256;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// OpenStreetMap's tile policy requires visible attribution. It is not
// decoration and it is not optional.
const ATTRIBUTION = '© OpenStreetMap contributors';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/* Two incidents on the same street corner draw one pin on top of the other,
   and the console silently reports fewer incidents than it holds. Pins closer
   together than this on screen are grouped and the group carries its count.

   The group is anchored on one of its members — an exact reported position —
   and never on an average of them. A centroid would be a coordinate nobody
   reported, drawn at pin precision, which is the one thing this module does
   not do. Zooming apart separates the group into its real positions. */
const CLUSTER_PX = 34;

// Highest wins the group's colour, so a critical incident is never hidden
// behind a resolved one it happens to sit beside.
const RANK = { critical: 5, high: 4, normal: 3, low: 2, unassessed: 1, resolved: 0 };

function cluster(points) {
  const groups = [];
  points.forEach((point) => {
    const near = groups.find((g) => Math.hypot(g.x - point.x, g.y - point.y) <= CLUSTER_PX);
    if (near) near.members.push(point);
    else groups.push({ x: point.x, y: point.y, members: [point] });
  });
  return groups;
}

/* Web Mercator, in world pixels at a given zoom. */
function project(lat, lon, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const phi = (clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * scale;
  return { x, y };
}

export function createMap(host, options = {}) {
  const state = {
    lat: options.lat ?? 15.5363,      // Masinloc town proper
    lon: options.lon ?? 119.9524,
    zoom: options.zoom ?? 13,
    markers: [],
    selected: null,
    onSelect: options.onSelect || (() => {}),
    tilesFailed: false,
  };

  host.classList.add('opmap');
  host.innerHTML =
    '<div class="opmap-tiles" aria-hidden="true"></div>' +
    '<div class="opmap-pins"></div>' +
    '<div class="opmap-zoom">' +
      '<button type="button" data-zoom="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-zoom="out" aria-label="Zoom out">−</button>' +
    '</div>' +
    `<p class="opmap-attribution">${ATTRIBUTION}</p>` +
    '<p class="opmap-notice" hidden></p>';

  const tiles = host.querySelector('.opmap-tiles');
  const pins = host.querySelector('.opmap-pins');
  const notice = host.querySelector('.opmap-notice');

  function say(message) {
    notice.hidden = !message;
    notice.textContent = message || '';
  }

  function draw() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;

    const centre = project(state.lat, state.lon, state.zoom);
    const originX = centre.x - w / 2;
    const originY = centre.y - h / 2;
    const count = Math.pow(2, state.zoom);

    const first = { x: Math.floor(originX / TILE), y: Math.floor(originY / TILE) };
    const last = { x: Math.floor((originX + w) / TILE), y: Math.floor((originY + h) / TILE) };

    let markup = '';
    let requested = 0;
    for (let ty = first.y; ty <= last.y; ty += 1) {
      if (ty < 0 || ty >= count) continue;
      for (let tx = first.x; tx <= last.x; tx += 1) {
        // Wrap horizontally so panning past the antimeridian does not blank.
        const wrapped = ((tx % count) + count) % count;
        const url = TILE_URL.replace('{z}', state.zoom).replace('{x}', wrapped).replace('{y}', ty);
        const left = tx * TILE - originX;
        const top = ty * TILE - originY;
        markup += `<img src="${url}" alt="" width="${TILE}" height="${TILE}" loading="lazy" ` +
                  `style="left:${left}px;top:${top}px">`;
        requested += 1;
      }
    }
    tiles.innerHTML = markup;

    // One failure is a missing tile; every tile failing is no basemap.
    let failed = 0;
    tiles.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        failed += 1;
        if (failed >= requested) {
          state.tilesFailed = true;
          host.classList.add('is-flat');
          say('Basemap could not load. Incident positions are still exact — they come from the report, not the map.');
        }
      }, { once: true });
      img.addEventListener('load', () => {
        if (state.tilesFailed) {
          state.tilesFailed = false;
          host.classList.remove('is-flat');
          say('');
        }
      }, { once: true });
    });

    drawPins(originX, originY);
  }

  function drawPins(originX, originY) {
    const placed = state.markers.map((marker) => {
      const point = project(marker.lat, marker.lon, state.zoom);
      return { marker, x: point.x - originX, y: point.y - originY };
    });

    pins.innerHTML = cluster(placed).map((group) => {
      // Highest priority in the group decides its colour; the group is stale
      // only when every position inside it is.
      const lead = group.members.reduce((best, m) =>
        (RANK[m.marker.priority] ?? 1) > (RANK[best.marker.priority] ?? 1) ? m : best);
      const stale = group.members.every((m) => m.marker.stale);
      const selected = group.members.some((m) => m.marker.id === state.selected);
      const count = group.members.length;

      /* The pin's class carries priority and staleness, and its accessible
         name spells both out — colour never carries the meaning alone. A
         group names its count and says how to open it, because a number a
         screen reader cannot read is a number that is not there. */
      const label = count === 1
        ? lead.marker.label
        : `${count} incidents within a few metres of each other. ` +
          `Highest priority here: ${lead.marker.label}. Activate to zoom in and separate them.`;

      return `<button class="opmap-pin p-${lead.marker.priority || 'unassessed'}` +
             `${stale ? ' is-stale' : ''}${selected ? ' is-selected' : ''}` +
             `${count > 1 ? ' is-cluster' : ''}" type="button" ` +
             `data-id="${lead.marker.id}" data-count="${count}" ` +
             `data-x="${group.x}" data-y="${group.y}" ` +
             `style="left:${group.x}px;top:${group.y}px" ` +
             `title="${label}" aria-label="${label}"><span></span>` +
             `${count > 1 ? `<b aria-hidden="true">${count}</b>` : ''}</button>`;
    }).join('');

    pins.querySelectorAll('.opmap-pin').forEach((pin) => {
      pin.addEventListener('click', () => {
        // A single incident opens. A group does not guess which of its
        // incidents you meant — it zooms until they are separate pins.
        if (Number(pin.dataset.count) > 1 && state.zoom < 18) {
          const w = host.clientWidth;
          const h = host.clientHeight;
          const scale = TILE * Math.pow(2, state.zoom);
          const centre = project(state.lat, state.lon, state.zoom);
          const worldX = centre.x - w / 2 + Number(pin.dataset.x);
          const worldY = centre.y - h / 2 + Number(pin.dataset.y);
          state.lon = (worldX / scale) * 360 - 180;
          const n = Math.PI - (2 * Math.PI * worldY) / scale;
          state.lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
          state.zoom = clamp(state.zoom + 2, 3, 18);
          draw();
          return;
        }
        state.onSelect(pin.dataset.id);
      });
    });
  }

  /* --- interaction ------------------------------------------------------ */

  let dragging = null;
  host.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.opmap-zoom, .opmap-pin')) return;
    dragging = { x: event.clientX, y: event.clientY };
    host.setPointerCapture(event.pointerId);
    host.classList.add('is-dragging');
  });
  host.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging = { x: event.clientX, y: event.clientY };
    const scale = TILE * Math.pow(2, state.zoom);
    const centre = project(state.lat, state.lon, state.zoom);
    const moved = { x: centre.x - dx, y: centre.y - dy };
    state.lon = (moved.x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * moved.y) / scale;
    state.lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    draw();
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    host.classList.remove('is-dragging');
    try { host.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);

  host.querySelectorAll('[data-zoom]').forEach((button) => {
    button.addEventListener('click', () => {
      state.zoom = clamp(state.zoom + (button.dataset.zoom === 'in' ? 1 : -1), 3, 18);
      draw();
    });
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(draw, 150);
  });

  /* --- api -------------------------------------------------------------- */

  return {
    setMarkers(markers) {
      state.markers = markers.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
      draw();
    },
    select(id) {
      state.selected = id;
      draw();
    },
    /* Centre on one incident without changing its position. Panning the view
       is not the same as moving a marker, and only the view moves here. */
    focus(id) {
      const marker = state.markers.find((m) => m.id === id);
      if (!marker) return;
      state.lat = marker.lat;
      state.lon = marker.lon;
      state.zoom = Math.max(state.zoom, 15);
      state.selected = id;
      draw();
    },
    fit() {
      if (!state.markers.length) { draw(); return; }
      const lats = state.markers.map((m) => m.lat);
      const lons = state.markers.map((m) => m.lon);
      state.lat = (Math.min(...lats) + Math.max(...lats)) / 2;
      state.lon = (Math.min(...lons) + Math.max(...lons)) / 2;
      draw();
    },
    redraw: draw,
    notice: say,
  };
}
