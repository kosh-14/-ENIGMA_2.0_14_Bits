// public/script.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Water } from "three/addons/objects/Water.js";
import { Sky } from "three/addons/objects/Sky.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";

// ========== CONFIGURATION ==========
const API_URL = window.location.origin;
let currentBBox = [-122.5, 37.7, -122.3, 37.9]; // Default San Francisco
let currentLocation = { lon: -122.4, lat: 37.8 };
let satelliteData = null;
let historicalChart = null;

// ========== INITIALIZE SCENE ==========
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0f1a);
scene.fog = new THREE.FogExp2(0x0a0f1a, 0.002);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(30, 18, 35);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = 1.2;
document.getElementById("canvas-container").appendChild(renderer.domElement);

// CSS2 Renderer for labels
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0px";
labelRenderer.domElement.style.left = "0px";
labelRenderer.domElement.style.pointerEvents = "none";
document
  .getElementById("canvas-container")
  .appendChild(labelRenderer.domElement);

// ========== CONTROLS ==========
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2.5;
controls.minDistance = 20;
controls.maxDistance = 80;

// Add click handler to get coordinates
controls.addEventListener("change", () => {
  // Not implementing click selection in this example
});

// ========== LIGHTING ==========
const ambientLight = new THREE.AmbientLight(0x404060);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0x4488ff, 0x224422, 0.6);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.5);
sunLight.position.set(20, 30, 10);
sunLight.castShadow = true;
sunLight.receiveShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
const d = 30;
sunLight.shadow.camera.left = -d;
sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d;
sunLight.shadow.camera.bottom = -d;
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 60;
scene.add(sunLight);

// ========== SKY ==========
const sky = new Sky();
sky.scale.set(100, 10, 100);
scene.add(sky);

const skyUniforms = sky.material.uniforms;
skyUniforms["turbidity"].value = 10;
skyUniforms["rayleigh"].value = 2;
skyUniforms["mieCoefficient"].value = 0.005;
skyUniforms["mieDirectionalG"].value = 0.8;
skyUniforms["sunPosition"].value.set(1, 0.5, 1);

// ========== TERRAIN ==========
const groundGeo = new THREE.CircleGeometry(40, 64);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a5a3a });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
ground.receiveShadow = true;
scene.add(ground);

// ========== WATER ==========
const waterGeo = new THREE.CircleGeometry(40, 128);
const water = new Water(waterGeo, {
  textureWidth: 512,
  textureHeight: 512,
  waterNormals: new THREE.TextureLoader().load(
    "https://threejs.org/examples/textures/waternormals.jpg",
  ),
  sunDirection: new THREE.Vector3(1, 1, 1).normalize(),
  sunColor: 0xffdd88,
  waterColor: 0x2277aa,
  distortionScale: 3.7,
  fog: scene.fog !== undefined,
});
water.rotation.x = -Math.PI / 2;
water.position.y = -0.4;
scene.add(water);

// ========== BUILDINGS ==========
const buildings = [];

function createBuilding(x, z, height, style = "modern") {
  const group = new THREE.Group();

  const color = style === "modern" ? 0xe0e5ec : 0xb85c38;
  const material = new THREE.MeshStandardMaterial({ color: color });

  const main = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, height, 1.5),
    material,
  );
  main.position.y = height / 2;
  main.castShadow = true;
  main.receiveShadow = true;
  group.add(main);

  // Windows
  const windowMat = new THREE.MeshStandardMaterial({ color: 0x88aaff });
  for (let i = 0; i < 4; i++) {
    const windowGeo = new THREE.BoxGeometry(0.2, 0.3, 0.1);
    const windowMesh = new THREE.Mesh(windowGeo, windowMat);
    windowMesh.position.set(0.4, i * 0.8 + 0.5, 0.76);
    windowMesh.castShadow = true;
    group.add(windowMesh);
  }

  group.position.set(x, 0, z);
  return group;
}

// Generate city grid
for (let i = -3; i <= 3; i++) {
  for (let j = -3; j <= 3; j++) {
    if (i === 0 && j === 0) continue;
    const x = i * 5;
    const z = j * 5;
    const height = 2 + Math.random() * 3;
    const style = Math.random() > 0.5 ? "modern" : "brick";

    const building = createBuilding(x, z, height, style);
    scene.add(building);
    buildings.push({
      mesh: building,
      baseY: 0,
      height: height,
      position: new THREE.Vector3(x, 0, z),
    });
  }
}

// ========== TREES ==========
function createTree(x, z) {
  const group = new THREE.Group();

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.3, 1.0),
    trunkMat,
  );
  trunk.position.y = 0.5;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);

  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32 });
  const foliage = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.0, 8),
    foliageMat,
  );
  foliage.position.y = 1.2;
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  group.add(foliage);

  group.position.set(x, 0, z);
  return group;
}

for (let i = 0; i < 30; i++) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 8 + Math.random() * 10;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  scene.add(createTree(x, z));
}

// ========== UI ELEMENTS ==========
const floodSlider = document.getElementById("flood-slider");
const depthDisplay = document.getElementById("depth-display");
const floodDepthEl = document.getElementById("flood-depth");
const floodProgress = document.getElementById("flood-progress");
const toast = document.getElementById("toast");
const toastMessage = document.getElementById("toast-message");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingStatus = document.getElementById("loading-status");

// Band buttons
document
  .getElementById("band-truecolor")
  .addEventListener("click", () => updateSatelliteBand("truecolor"));
document
  .getElementById("band-ndvi")
  .addEventListener("click", () => updateSatelliteBand("ndvi"));
document
  .getElementById("band-ndwi")
  .addEventListener("click", () => updateSatelliteBand("ndwi"));

// Scenario buttons
document.getElementById("scenario-normal").addEventListener("click", () => {
  floodSlider.value = 0;
  updateFloodLevel(0);
  setActiveButton("scenario-normal");
});

document.getElementById("scenario-flashflood").addEventListener("click", () => {
  floodSlider.value = 200;
  updateFloodLevel(200);
  setActiveButton("scenario-flashflood");
  showToast("🌊 Flash flood scenario activated");
});

document.getElementById("scenario-extreme").addEventListener("click", () => {
  floodSlider.value = 365;
  updateFloodLevel(365);
  setActiveButton("scenario-extreme");
  showToast("🔴 Extreme flood scenario (3.65m)");
});

function setActiveButton(id) {
  document
    .querySelectorAll(".scenario-buttons button")
    .forEach((btn) => btn.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ========== FLOOD UPDATE FUNCTION ==========
function updateFloodLevel(percent) {
  const depth = percent / 100; // meters

  depthDisplay.textContent = depth.toFixed(2) + "m";
  floodDepthEl.textContent = depth.toFixed(2);
  floodProgress.style.width = (depth / 3.65) * 100 + "%";

  // Update water height
  const waterY = -0.4 + (depth / 3.65) * 4.0;
  water.position.y = waterY;

  // Update risk level
  const riskEl = document.getElementById("risk-level");
  const riskTrend = document.getElementById("risk-trend");

  if (depth < 0.5) {
    riskEl.textContent = "LOW";
    riskEl.style.color = "#4caf50";
    riskTrend.innerHTML = "● Stable";
    riskTrend.style.color = "#4caf50";
  } else if (depth < 1.5) {
    riskEl.textContent = "MODERATE";
    riskEl.style.color = "#ffeb3b";
    riskTrend.innerHTML = "⚠️ Rising";
    riskTrend.style.color = "#ffeb3b";
  } else {
    riskEl.textContent = "CRITICAL";
    riskEl.style.color = "#ff5252";
    riskTrend.innerHTML = "🔴 Emergency";
    riskTrend.style.color = "#ff5252";
  }

  // Update flood trend
  const floodTrend = document.getElementById("flood-trend");
  if (percent < 100) floodTrend.innerHTML = "⬇️ Receding";
  else if (percent < 200) floodTrend.innerHTML = "➡️ Stable";
  else floodTrend.innerHTML = "⬆️ Rising";

  // Color buildings based on flood depth
  buildings.forEach((building) => {
    const floodDepthAtBuilding = waterY;
    building.mesh.traverse((child) => {
      if (child.isMesh && child.material && !Array.isArray(child.material)) {
        if (floodDepthAtBuilding > building.height * 0.7) {
          child.material.color.setHex(0xff5252);
        } else if (floodDepthAtBuilding > building.height * 0.3) {
          child.material.color.setHex(0xffeb3b);
        } else if (floodDepthAtBuilding > 0) {
          child.material.color.setHex(0x4caf50);
        }
      }
    });
  });
}

floodSlider.addEventListener("input", (e) => {
  updateFloodLevel(parseInt(e.target.value));
});

// ========== SENTINEL HUB INTEGRATION ==========

async function fetchSatelliteData() {
  try {
    loadingOverlay.classList.add("show");
    loadingStatus.textContent = "Authenticating with Sentinel Hub...";

    const response = await fetch(`${API_URL}/api/satellite-data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bbox: currentBBox,
        options: {
          width: 512,
          height: 512,
          maxCloudCoverage: 30,
        },
      }),
    });

    const result = await response.json();

    if (result.success) {
      satelliteData = result.data;
      loadingStatus.textContent = "Processing satellite imagery...";

      // Update UI with satellite data
      updateUIWithSatelliteData(satelliteData);

      // Fetch historical data
      await fetchHistoricalData();

      showToast("✅ Satellite data updated");
      document.getElementById("live-badge").style.background = "#4caf50";
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error("Failed to fetch satellite data:", error);
    showToast("❌ Using simulated data (Sentinel API unavailable)");
    document.getElementById("live-badge").style.background = "#ff5252";

    // Use simulated data
    useSimulatedData();
  } finally {
    loadingOverlay.classList.remove("show");
  }
}

function updateUIWithSatelliteData(data) {
  // Update satellite image
  const imgElement = document.getElementById("satellite-image");
  imgElement.src =
    data.truecolor || "https://via.placeholder.com/512x512?text=Satellite+Data";

  // Update metadata
  document.getElementById("image-metadata").innerHTML = `
        <span>${new Date(data.metadata.timestamp).toLocaleString()} • Sentinel-2 L2A</span>
    `;

  // Update analysis metrics
  if (data.analysis) {
    document.getElementById("ndvi-value").textContent =
      data.analysis.ndvi.toFixed(2);
    document.getElementById("ndwi-value").textContent =
      data.analysis.ndwi.toFixed(2);
    document.getElementById("temp-value").textContent =
      data.analysis.surfaceTemperature + "°C";
    document.getElementById("cloud-cover").innerHTML =
      `<i class="fas fa-cloud"></i> Cloud cover: ${data.analysis.cloudCoverage}%`;

    // Land cover
    document.getElementById("water-percent").textContent =
      data.analysis.waterPercentage + "%";
    document.getElementById("veg-percent").textContent =
      data.analysis.vegetationPercentage + "%";
    document.getElementById("urban-percent").textContent =
      data.analysis.urbanPercentage + "%";
    document.getElementById("bare-percent").textContent =
      data.analysis.barePercentage + "%";

    // Update flood depth based on satellite analysis
    if (data.analysis.floodDepth) {
      const floodDepth = parseFloat(data.analysis.floodDepth) * 100;
      floodSlider.value = Math.min(365, floodDepth);
      updateFloodLevel(floodSlider.value);
    }
  }

  // Update timestamp
  document.getElementById("timestamp").textContent =
    new Date().toLocaleString() + " UTC";
}

async function fetchHistoricalData() {
  try {
    const response = await fetch(
      `${API_URL}/api/historical/${currentLocation.lon}/${currentLocation.lat}?days=30`,
    );
    const result = await response.json();

    if (result.success) {
      updateHistoricalChart(result.data);
    }
  } catch (error) {
    console.error("Failed to fetch historical data:", error);
  }
}

function updateHistoricalChart(data) {
  const ctx = document.getElementById("historical-chart").getContext("2d");

  if (historicalChart) {
    historicalChart.destroy();
  }

  historicalChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => d.date.slice(5)),
      datasets: [
        {
          label: "Flood Risk",
          data: data.map((d) => d.floodRisk * 100),
          borderColor: "#ff5252",
          backgroundColor: "rgba(255, 82, 82, 0.1)",
          tension: 0.4,
        },
        {
          label: "NDVI",
          data: data.map((d) => d.ndvi * 100),
          borderColor: "#4caf50",
          backgroundColor: "rgba(76, 175, 80, 0.1)",
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "white", font: { size: 10 } },
        },
      },
      scales: {
        y: {
          grid: { color: "rgba(255,255,255,0.1)" },
          ticks: { color: "white", callback: (v) => v + "%" },
        },
        x: {
          grid: { display: false },
          ticks: { color: "white", maxRotation: 45 },
        },
      },
    },
  });
}

function updateSatelliteBand(band) {
  if (!satelliteData) return;

  document
    .querySelectorAll(".band-btn")
    .forEach((btn) => btn.classList.remove("active"));
  document.getElementById(`band-${band}`).classList.add("active");

  const imgElement = document.getElementById("satellite-image");

  switch (band) {
    case "truecolor":
      imgElement.src = satelliteData.truecolor;
      break;
    case "ndvi":
      imgElement.src = satelliteData.ndvi || satelliteData.truecolor;
      break;
    case "ndwi":
      imgElement.src = satelliteData.ndwi || satelliteData.truecolor;
      break;
  }
}

function useSimulatedData() {
  // Generate simulated data for demonstration
  const simulatedData = {
    truecolor:
      "https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/Global_urban_areas_2000_lrg.jpg",
    analysis: {
      ndvi: 0.45,
      ndwi: 0.23,
      surfaceTemperature: "24.5",
      cloudCoverage: 15,
      waterPercentage: 18,
      vegetationPercentage: 42,
      urbanPercentage: 28,
      barePercentage: 12,
      floodDepth: (Math.random() * 0.8 + 0.2).toFixed(2),
    },
  };

  satelliteData = simulatedData;
  updateUIWithSatelliteData(simulatedData);
}

// ========== ANIMATION LOOP ==========
let clock = new THREE.Clock();

function animate() {
  const delta = clock.getDelta();

  // Animate water
  if (water.material.uniforms) {
    water.material.uniforms["time"].value += delta;
  }

  controls.update();

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);

  requestAnimationFrame(animate);
}

animate();

// ========== INITIALIZATION ==========
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// Check server health and fetch initial data
async function init() {
  try {
    const healthResponse = await fetch(`${API_URL}/api/health`);
    const health = await healthResponse.json();

    if (health.status === "healthy") {
      console.log("✅ Connected to backend");
      await fetchSatelliteData();
    }
  } catch (error) {
    console.warn("⚠️ Backend not available, using simulated data");
    useSimulatedData();
  }

  updateFloodLevel(0);
}

init();

console.log("🚀 Digital Twin initialized with Sentinel Hub integration");
