// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const moment = require("moment");
const cron = require("node-cron");


const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Cache for satellite data
const cache = new Map();
const CACHE_DURATION = process.env.CACHE_DURATION || 3600000;

// ========== SENTINEL HUB SERVICE ==========
class SentinelHubService {
  constructor() {
    this.clientId = process.env.SENTINEL_CLIENT_ID;
    this.clientSecret = process.env.SENTINEL_CLIENT_SECRET;
    this.token = null;
    this.tokenExpiry = null;
    this.baseUrl = "https://services.sentinel-hub.com";
    this.evalscript = `
            //VERSION=3
            function setup() {
                return {
                    input: [{
                        bands: ["B02", "B03", "B04", "B08", "B11", "SCL"],
                        units: "DN"
                    }],
                    output: [
                        { id: "truecolor", bands: 3, sampleType: "AUTO" },
                        { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
                        { id: "ndwi", bands: 1, sampleType: "FLOAT32" },
                        { id: "scl", bands: 1, sampleType: "UINT8" }
                    ]
                };
            }

            function evaluatePixel(sample) {
                // True Color
                let trueColor = [sample.B04 * 2.5, sample.B03 * 2.5, sample.B02 * 2.5];
                
                // NDVI (Vegetation Index)
                let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
                
                // NDWI (Water Index) for flood detection
                let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08);
                
                return {
                    truecolor: trueColor,
                    ndvi: [ndvi],
                    ndwi: [ndwi],
                    scl: [sample.SCL]
                };
            }
        `;
  }

  async getAccessToken() {
    if (this.token && this.tokenExpiry > Date.now()) {
      return this.token;
    }

    try {
      console.log("🔄 Getting new Sentinel Hub access token...");
      const response = await axios.post(
        `${this.baseUrl}/auth/realms/main/protocol/openid-connect/token`,
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      this.token = response.data.access_token;
      this.tokenExpiry = Date.now() + response.data.expires_in * 1000;
      console.log(
        "✅ Token acquired, expires in",
        response.data.expires_in,
        "seconds",
      );
      return this.token;
    } catch (error) {
      console.error(
        "❌ Failed to get Sentinel token:",
        error.response?.data || error.message,
      );
      throw new Error("Authentication failed with Sentinel Hub");
    }
  }

  async getSatelliteData(bbox, options = {}) {
    const { width = 512, height = 512, maxCloudCoverage = 30 } = options;

    // Generate cache key
    const cacheKey = `${bbox.join(",")}-${width}-${height}`;

    // Check cache
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log("📦 Returning cached data for", cacheKey);
        return cached.data;
      }
    }

    try {
      const token = await this.getAccessToken();

      console.log("📡 Fetching Sentinel data for bbox:", bbox);

      // Get current date and date 30 days ago
      const endDate = moment().format("YYYY-MM-DD");
      const startDate = moment().subtract(30, "days").format("YYYY-MM-DD");

      const response = await axios.post(
        `${this.baseUrl}/api/v1/process`,
        {
          input: {
            bounds: {
              bbox: bbox,
              properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" },
            },
            data: [
              {
                type: "S2L2A",
                dataFilter: {
                  maxCloudCoverage: maxCloudCoverage,
                  timeRange: {
                    from: startDate + "T00:00:00Z",
                    to: endDate + "T23:59:59Z",
                  },
                },
                processing: {
                  harmonizeValues: true,
                },
              },
            ],
          },
          output: {
            width: width,
            height: height,
            responses: [
              { identifier: "truecolor", format: { type: "image/png" } },
              { identifier: "ndvi", format: { type: "image/tiff" } },
              { identifier: "ndwi", format: { type: "image/tiff" } },
              { identifier: "scl", format: { type: "image/tiff" } },
            ],
          },
          evalscript: this.evalscript,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          responseType: "arraybuffer",
        },
      );

      // Parse multipart response
      const boundary = this.extractBoundary(response.headers["content-type"]);
      const parts = this.parseMultipartResponse(response.data, boundary);

      // Convert images to base64
      const result = {
        truecolor: parts.truecolor
          ? `data:image/png;base64,${parts.truecolor.toString("base64")}`
          : null,
        ndvi: parts.ndvi
          ? `data:image/tiff;base64,${parts.ndvi.toString("base64")}`
          : null,
        ndwi: parts.ndwi
          ? `data:image/tiff;base64,${parts.ndwi.toString("base64")}`
          : null,
        scl: parts.scl
          ? `data:image/tiff;base64,${parts.scl.toString("base64")}`
          : null,
        metadata: {
          timestamp: new Date().toISOString(),
          bbox: bbox,
          cloudCoverage: maxCloudCoverage,
          source: "Sentinel-2 L2A",
        },
      };

      // Analyze the data
      const analysis = await this.analyzeSentinelData(parts, bbox);
      result.analysis = analysis;

      // Cache the result
      cache.set(cacheKey, {
        timestamp: Date.now(),
        data: result,
      });

      console.log("✅ Sentinel data fetched and analyzed successfully");
      return result;
    } catch (error) {
      console.error("❌ Failed to fetch Sentinel data:", error.message);
      throw error;
    }
  }

  extractBoundary(contentType) {
    const match = contentType.match(/boundary=([^;]+)/);
    return match ? match[1] : null;
  }

  parseMultipartResponse(buffer, boundary) {
    const parts = {};
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const endBoundaryBuffer = Buffer.from(`--${boundary}--`);

    let start = 0;
    let end = buffer.indexOf(endBoundaryBuffer);

    if (end === -1) {
      end = buffer.length;
    }

    let pos = buffer.indexOf(boundaryBuffer, start);
    while (pos !== -1 && pos < end) {
      // Find headers end
      const headersEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), pos);
      if (headersEnd === -1) break;

      // Parse headers
      const headers = buffer
        .slice(pos + boundaryBuffer.length + 2, headersEnd)
        .toString();
      const contentIdMatch = headers.match(/Content-ID: <([^>]+)>/);

      if (contentIdMatch) {
        const contentId = contentIdMatch[1];

        // Find next boundary
        const nextBoundary = buffer.indexOf(boundaryBuffer, headersEnd + 4);
        const contentEnd = nextBoundary !== -1 ? nextBoundary - 4 : end - 2;

        // Extract content
        const content = buffer.slice(headersEnd + 4, contentEnd);
        parts[contentId] = content;
      }

      pos = buffer.indexOf(boundaryBuffer, headersEnd + 4);
    }

    return parts;
  }

  async analyzeSentinelData(parts, bbox) {
    // This would process the TIFF data for actual analysis
    // For now, return simulated analysis based on bbox location

    const centerLat = (bbox[1] + bbox[3]) / 2;
    const centerLon = (bbox[0] + bbox[2]) / 2;

    // Simulate analysis based on location
    const randomFactor = Math.random() * 0.3;

    // Calculate flood risk based on NDWI (simulated)
    let floodRisk, waterPercentage;
    if (Math.abs(centerLat) < 30) {
      // Tropical
      floodRisk = 0.6 + randomFactor;
      waterPercentage = 0.4 + randomFactor;
    } else if (Math.abs(centerLat) < 45) {
      // Temperate
      floodRisk = 0.3 + randomFactor;
      waterPercentage = 0.2 + randomFactor;
    } else {
      // Polar
      floodRisk = 0.1 + randomFactor;
      waterPercentage = 0.1 + randomFactor;
    }

    // Calculate NDVI (vegetation)
    const ndvi = 0.3 + Math.random() * 0.5;

    // Land cover classification
    const landCover = {
      water: Math.round(waterPercentage * 100),
      vegetation: Math.round(ndvi * 100),
      urban: Math.round((1 - waterPercentage - ndvi) * 100 * 0.7),
      bare: Math.round((1 - waterPercentage - ndvi) * 100 * 0.3),
    };

    // Ensure total is 100
    const total =
      landCover.water + landCover.vegetation + landCover.urban + landCover.bare;
    if (total !== 100) {
      landCover.bare += 100 - total;
    }

    return {
      ndvi: parseFloat(ndvi.toFixed(3)),
      ndwi: parseFloat((waterPercentage - 0.2).toFixed(3)),
      floodRisk: parseFloat(floodRisk.toFixed(2)),
      waterPercentage: landCover.water,
      vegetationPercentage: landCover.vegetation,
      urbanPercentage: landCover.urban,
      barePercentage: landCover.bare,
      cloudCoverage: Math.floor(Math.random() * 30),
      surfaceTemperature: this.estimateSurfaceTemperature(centerLat, ndvi),
      floodDepth: this.estimateFloodDepth(floodRisk, waterPercentage),
    };
  }

  estimateSurfaceTemperature(latitude, ndvi) {
    // Simplified temperature estimation
    const baseTemp = 35 - Math.abs(latitude) * 0.5;
    const vegetationCooling = ndvi * 5;
    return (baseTemp - vegetationCooling).toFixed(1);
  }

  estimateFloodDepth(floodRisk, waterPercentage) {
    // Estimate flood depth in meters based on risk
    if (floodRisk > 0.7) return (Math.random() * 2 + 1.5).toFixed(2); // 1.5-3.5m
    if (floodRisk > 0.4) return (Math.random() * 1 + 0.5).toFixed(2); // 0.5-1.5m
    return (Math.random() * 0.5).toFixed(2); // 0-0.5m
  }

  async getHistoricalData(bbox, days = 30) {
    const historicalData = [];
    const endDate = moment();

    for (let i = 0; i < days; i++) {
      const date = moment().subtract(i, "days");
      historicalData.push({
        date: date.format("YYYY-MM-DD"),
        floodRisk: 0.2 + Math.random() * 0.5,
        ndvi: 0.3 + Math.random() * 0.4,
        waterExtent: 10 + Math.random() * 40,
      });
    }

    return historicalData.sort((a, b) => a.date.localeCompare(b.date));
  }
}

// ========== FLOOD MODELING SERVICE ==========
class FloodModelingService {
  calculateFloodRisk(terrainData, waterLevel) {
    // Simplified flood modeling
    const elevation = terrainData.elevation || 0;
    const distanceToRiver = terrainData.distanceToRiver || 1000;
    const soilType = terrainData.soilType || "clay";

    // Base risk calculation
    let risk = 0;

    // Elevation factor (lower areas flood first)
    if (elevation < waterLevel) {
      risk += 0.5;
    } else if (elevation < waterLevel + 2) {
      risk += 0.3;
    }

    // Distance to river factor
    if (distanceToRiver < 100) {
      risk += 0.4;
    } else if (distanceToRiver < 500) {
      risk += 0.2;
    }

    // Soil absorption factor
    if (soilType === "clay") {
      risk += 0.2; // Clay doesn't absorb well
    } else if (soilType === "sand") {
      risk -= 0.1; // Sand absorbs better
    }

    return Math.min(1, Math.max(0, risk));
  }

  predictFloodSpread(waterSource, terrain, hours = 24) {
    // Simplified flood spread prediction
    const spreadRate = 0.1; // km per hour
    const maxDistance = spreadRate * hours;

    return {
      affectedArea: Math.PI * Math.pow(maxDistance, 2),
      maxDistance: maxDistance,
      timeToReach: hours,
      riskZones: this.generateRiskZones(waterSource, maxDistance),
    };
  }

  generateRiskZones(source, maxDistance) {
    const zones = [];
    for (let i = 0; i < 3; i++) {
      const distance = (i + 1) * (maxDistance / 3);
      zones.push({
        radius: distance,
        risk: 1 - i * 0.3,
        color: i === 0 ? "#ff5252" : i === 1 ? "#ffeb3b" : "#4caf50",
      });
    }
    return zones;
  }
}

// ========== INITIALIZE SERVICES ==========
const sentinelHub = new SentinelHubService();
const floodModel = new FloodModelingService();

// ========== API ENDPOINTS ==========

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    services: {
      sentinelHub: !!process.env.SENTINEL_CLIENT_ID,
      cacheSize: cache.size,
    },
  });
});

// Get satellite data for location
app.post("/api/satellite-data", async (req, res) => {
  try {
    const { bbox, options } = req.body;

    if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
      return res.status(400).json({
        error: "Invalid bbox. Expected [minLon, minLat, maxLon, maxLat]",
      });
    }

    console.log("📍 Processing request for bbox:", bbox);

    const data = await sentinelHub.getSatelliteData(bbox, options);

    res.json({
      success: true,
      data: data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Failed to fetch satellite data",
    });
  }
});

// Get flood analysis for area
app.post("/api/flood-analysis", async (req, res) => {
  try {
    const { bbox, waterLevel } = req.body;

    if (!bbox) {
      return res.status(400).json({ error: "bbox required" });
    }

    // Get satellite data first
    const satelliteData = await sentinelHub.getSatelliteData(bbox);

    // Calculate flood risk
    const terrainData = {
      elevation: 5, // mock elevation
      distanceToRiver: 200,
      soilType: "clay",
    };

    const floodRisk = floodModel.calculateFloodRisk(
      terrainData,
      waterLevel || 1,
    );
    const floodPrediction = floodModel.predictFloodSpread(
      { x: 0, y: 0 },
      terrainData,
      24,
    );

    res.json({
      success: true,
      data: {
        currentRisk: floodRisk,
        prediction: floodPrediction,
        satelliteAnalysis: satelliteData.analysis,
        affectedBuildings: Math.round(floodRisk * 42), // mock building count
        recommendedEvacuation: floodRisk > 0.7,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get historical data for area
app.get("/api/historical/:lon/:lat", async (req, res) => {
  try {
    const { lon, lat } = req.params;
    const { days = 30 } = req.query;

    const bbox = [
      parseFloat(lon) - 0.1,
      parseFloat(lat) - 0.1,
      parseFloat(lon) + 0.1,
      parseFloat(lat) + 0.1,
    ];

    const historicalData = await sentinelHub.getHistoricalData(
      bbox,
      parseInt(days),
    );

    res.json({
      success: true,
      data: historicalData,
      location: { lon: parseFloat(lon), lat: parseFloat(lat) },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear cache
app.post("/api/cache/clear", (req, res) => {
  cache.clear();
  res.json({ success: true, message: "Cache cleared", size: cache.size });
});

// Get cache stats
app.get("/api/cache/stats", (req, res) => {
  res.json({
    size: cache.size,
    keys: Array.from(cache.keys()),
    oldestEntry:
      cache.size > 0
        ? Math.min(...Array.from(cache.values()).map((v) => v.timestamp))
        : null,
  });
});

// ========== SCHEDULED TASKS ==========

// Refresh token every 50 minutes
cron.schedule("*/50 * * * *", async () => {
  console.log("🔄 Refreshing Sentinel Hub token...");
  try {
    await sentinelHub.getAccessToken();
    console.log("✅ Token refreshed successfully");
  } catch (error) {
    console.error("❌ Token refresh failed:", error.message);
  }
});

// Clean old cache entries every hour
cron.schedule("0 * * * *", () => {
  console.log("🧹 Cleaning cache...");
  const now = Date.now();
  let removed = 0;

  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
      removed++;
    }
  }

  console.log(`✅ Removed ${removed} old cache entries`);
});

// ========== SERVE FRONTEND ==========
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
    ╔════════════════════════════════════════╗
    ║   🌊 FLOOD TWIN DIGITAL TWIN          ║
    ║   🛰️  Sentinel Hub Integration         ║
    ║   📡 Server running on port ${PORT}      ║
    ╚════════════════════════════════════════╝
    `);
  console.log("📍 API endpoints:");
  console.log(`   - GET  /api/health`);
  console.log(`   - POST /api/satellite-data`);
  console.log(`   - POST /api/flood-analysis`);
  console.log(`   - GET  /api/historical/:lon/:lat`);
});
